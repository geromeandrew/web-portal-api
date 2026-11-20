import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { SFNClient } from "@aws-sdk/client-sfn";
import { STSClient } from "@aws-sdk/client-sts";
import { GlueClient } from "@aws-sdk/client-glue";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AwsStepFunctionsRunner } from "../src/stepFunctionsRunner.js";
import { AwsSourceJobInspector } from "../src/modules/prepaid/infrastructure/sourceJobInspector.js";
import {
  sourceWorkflows,
  validateLegacySourceDefinition,
  type SourceWorkflow,
} from "../src/modules/prepaid/domain/sourceExtraction.js";
import {
  legacyDefinition,
  nativeJobColumnArguments,
  nativeJobFixture,
} from "./fixtures/prepaidSource.js";

// Real AWS SDK serializers, HTTP transport, deserializers and error recovery.
// All endpoints bind to loopback and credentials are deliberately fake.
// The read-only inspected native Glue/SFN shapes are the protocol basis.
describe("Native source AWS protocol against a local HTTP stand-in", () => {
  let server: Server, sfn: SFNClient, sts: STSClient, glue: GlueClient;
  let runner: AwsStepFunctionsRunner, inspector: AwsSourceJobInspector;
  const calls: { action: string; body: any }[] = [];
  const executions = new Map<string, { input: string; status: string }>();
  let drift = false,
    activeGlue = false,
    ownedGlue = false,
    foreignGlue = false;
  beforeAll(async () => {
    server = createServer(async (request, response) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const raw = Buffer.concat(chunks).toString();
        const target = String(request.headers["x-amz-target"] ?? "");
        const action = target.split(".").at(-1) || "GetCallerIdentity";
        if (action === "GetCallerIdentity") {
          calls.push({ action, body: new URLSearchParams(raw).get("Action") });
          response.setHeader("content-type", "text/xml");
          response.end(
            '<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetCallerIdentityResult><Arn>arn:aws:iam::123456789012:user/test</Arn><Account>123456789012</Account><UserId>test</UserId></GetCallerIdentityResult><ResponseMetadata><RequestId>local-test</RequestId></ResponseMetadata></GetCallerIdentityResponse>',
          );
          return;
        }
        const body = JSON.parse(raw);
        calls.push({ action, body });
        response.setHeader("content-type", "application/x-amz-json-1.1");
        const send = (value: unknown) => response.end(JSON.stringify(value));
        switch (action) {
          case "DescribeStateMachine": {
            const workflow = (
              Object.keys(sourceWorkflows) as SourceWorkflow[]
            ).find((w) =>
              body.stateMachineArn.endsWith(":" + sourceWorkflows[w].machine),
            )!;
            const definition = legacyDefinition(workflow);
            // Current live 308 owner fix: no job-run-id passthrough required.
            if (workflow === "adjustments_308")
              (definition.States as any).Extract_5.Parameters.Arguments = {};
            send({
              stateMachineArn: body.stateMachineArn,
              name: sourceWorkflows[workflow].machine,
              type: "STANDARD",
              status: "ACTIVE",
              definition: JSON.stringify(definition),
              creationDate: 1,
            });
            return;
          }
          case "StartExecution": {
            const arn =
              body.stateMachineArn.replace(":stateMachine:", ":execution:") +
              ":" +
              body.name;
            if (executions.has(arn)) {
              response.statusCode = 400;
              response.setHeader("x-amzn-errortype", "ExecutionAlreadyExists");
              send({
                __type: "ExecutionAlreadyExists",
                message: "Named execution already exists",
              });
            } else {
              executions.set(arn, { input: body.input, status: "RUNNING" });
              send({ executionArn: arn, startDate: 1 });
            }
            return;
          }
          case "DescribeExecution": {
            const execution = executions.get(body.executionArn)!;
            const workflow = Object.values(sourceWorkflows).find((w) =>
              body.executionArn.includes(":" + w.machine + ":"),
            )!;
            send({
              executionArn: body.executionArn,
              status: execution.status,
              input: execution.input,
              inputDetails: { included: true },
              startDate: 1,
              ...(execution.status === "SUCCEEDED"
                ? {
                    stopDate: 2,
                    outputDetails: { included: true },
                    output: JSON.stringify({
                      Id: "jr_http",
                      JobRunState: "SUCCEEDED",
                      JobName: `isg-esatp-dv-prep_reclass-gljo-extract_${workflow.jobs.at(-1)}`,
                    }),
                  }
                : {}),
            });
            return;
          }
          case "GetJob": {
            const number = Number(body.JobName.split("_").at(-1));
            const workflow = Object.values(sourceWorkflows).find((w) =>
              (w.jobs as readonly number[]).includes(number),
            )!;
            const index = (workflow.jobs as readonly number[]).indexOf(number);
            send({
              Job: {
                Name: body.JobName,
                Command: nativeJobFixture(number).command,
                DefaultArguments: {
                  ...nativeJobColumnArguments(
                    (Object.keys(sourceWorkflows) as SourceWorkflow[]).find(
                      (key) => sourceWorkflows[key] === workflow,
                    )!,
                    index,
                  ),
                  "--folder_location": "test-bucket/prepaid_reclass/",
                  "--input_file_name": workflow.inputPattern,
                  "--target_table": drift
                    ? "wrong.table"
                    : `sdbtdir1_prepaid_dbo.${workflow.targets[index]}`,
                },
              },
            });
            return;
          }
          case "ListExecutions":
            send({ executions: [] });
            return;
          case "GetJobRuns":
            send({
              JobRuns: ownedGlue
                ? body.JobName.endsWith("_1")
                  ? [
                      { Id: "jr_owned", JobRunState: "RUNNING" },
                      ...(foreignGlue
                        ? [{ Id: "jr_foreign", JobRunState: "RUNNING" }]
                        : []),
                    ]
                  : []
                : activeGlue
                  ? [{ JobRunState: "RUNNING" }]
                  : [],
            });
            return;
          case "GetExecutionHistory":
            send({
              events: [
                {
                  id: 5,
                  previousEventId: 4,
                  timestamp: 1,
                  type: "TaskSubmitted",
                  taskSubmittedEventDetails: {
                    resourceType: "glue",
                    resource: "startJobRun.sync",
                    outputDetails: { truncated: false },
                    output: JSON.stringify({
                      JobName: "isg-esatp-dv-prep_reclass-gljo-extract_1",
                      JobRunId: "jr_owned",
                    }),
                  },
                },
              ],
            });
            return;
          default:
            response.statusCode = 400;
            send({ message: `Unexpected operation ${action}` });
        }
      } catch (error) {
        response.statusCode = 500;
        response.end(JSON.stringify({ message: String(error) }));
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as { port: number };
    const options = {
      region: "us-east-1",
      endpoint: `http://127.0.0.1:${address.port}`,
      maxAttempts: 1,
      credentials: { accessKeyId: "TESTONLY", secretAccessKey: "TESTONLY" },
    };
    sfn = new SFNClient(options);
    sts = new STSClient(options);
    glue = new GlueClient(options);
    runner = new AwsStepFunctionsRunner(sfn, sts, "us-east-1");
    inspector = new AwsSourceJobInspector(glue, sfn);
  });
  beforeEach(() => {
    calls.length = 0;
    executions.clear();
    drift = false;
    activeGlue = false;
    ownedGlue = false;
    foreignGlue = false;
  });
  afterAll(async () => {
    sfn.destroy();
    sts.destroy();
    glue.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  it("serializes all ten native definitions/starts/polls and validates all twelve Glue contracts without portal parameters", async () => {
    const machines: string[] = [];
    for (const workflow of Object.keys(sourceWorkflows) as SourceWorkflow[]) {
      const mapping = sourceWorkflows[workflow];
      const machine = await runner.describeStateMachineDefinition(
        mapping.machine,
      );
      machines.push(machine.arn);
      const input = validateLegacySourceDefinition(
        workflow,
        machine.definition,
        "isg-esatp-dv",
      ).input;
      await inspector.verify(workflow, "isg-esatp-dv", "test-bucket");
      const started = await runner.startExecution(
        mapping.machine,
        input,
        `local-${workflow}`,
      );
      executions.get(started.executionArn)!.status = "SUCCEEDED";
      const completed = await runner.describeExecution(started.executionArn);
      expect(completed.status).toBe("SUCCEEDED");
      expect(JSON.parse(completed.output!).JobName).toBe(
        `isg-esatp-dv-prep_reclass-gljo-extract_${mapping.jobs.at(-1)}`,
      );
    }
    await inspector.idle(machines, "isg-esatp-dv");
    expect(calls.filter((c) => c.action === "GetJob")).toHaveLength(12);
    expect(calls.filter((c) => c.action === "GetJobRuns")).toHaveLength(12);
    const starts = calls.filter((c) => c.action === "StartExecution");
    expect(starts).toHaveLength(10);
    expect(
      starts.every((c) => c.body.input === '{"env_prefix":"isg-esatp-dv"}'),
    ).toBe(true);
    expect(
      calls.every((c) =>
        [
          "GetCallerIdentity",
          "DescribeStateMachine",
          "StartExecution",
          "DescribeExecution",
          "GetJob",
          "GetJobRuns",
          "ListExecutions",
        ].includes(c.action),
      ),
    ).toBe(true);
    expect(JSON.stringify(calls)).not.toMatch(
      /portalExtraction|--portal_|UpdateStateMachine|UpdateJob/,
    );
  });
  it("recovers a native ExecutionAlreadyExists response only when its input agrees", async () => {
    const machine = sourceWorkflows.ke24.machine;
    const first = await runner.startExecution(
      machine,
      { env_prefix: "isg-esatp-dv" },
      "same-name",
    );
    expect(
      (
        await runner.startExecution(
          machine,
          { env_prefix: "isg-esatp-dv" },
          "same-name",
        )
      ).executionArn,
    ).toBe(first.executionArn);
    await expect(
      runner.startExecution(machine, { env_prefix: "wrong" }, "same-name"),
    ).rejects.toThrow("different input");
    expect(executions.size).toBe(1);
  });
  it("attributes actual Glue run IDs over HTTP and blocks a foreign run of the same job", async () => {
    ownedGlue = true;
    const cohort = {
      executions: {
        callcard_sg:
          "arn:aws:states:us-east-1:123456789012:execution:isg-esatp-dv-prcl_cc_sg-sf:prepaid-source-owned",
      },
      allowOwnedGlue: true,
    };
    await inspector.idle([], "isg-esatp-dv", undefined, cohort);
    expect(calls.some((call) => call.action === "GetExecutionHistory")).toBe(
      true,
    );
    foreignGlue = true;
    await expect(
      inspector.idle([], "isg-esatp-dv", undefined, cohort),
    ).rejects.toThrow("foreign or unverified");
    await expect(
      inspector.idle([], "isg-esatp-dv", undefined, {
        ...cohort,
        allowOwnedGlue: false,
      }),
    ).rejects.toThrow("still active");
    expect(calls.some((call) => /^(Start|Update|Stop)/.test(call.action))).toBe(
      false,
    );
  });
  it("rejects drift and active shared Glue runs through actual SDK HTTP responses", async () => {
    drift = true;
    await expect(
      inspector.verify("ke24", "isg-esatp-dv", "test-bucket"),
    ).rejects.toThrow("differs");
    drift = false;
    activeGlue = true;
    await expect(inspector.idle([], "isg-esatp-dv")).rejects.toThrow(
      "still active",
    );
    expect(calls.some((c) => c.action === "StartExecution")).toBe(false);
  });
});
