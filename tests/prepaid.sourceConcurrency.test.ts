import { describe, expect, it, vi } from "vitest";
import { AwsSourceJobInspector } from "../src/modules/prepaid/infrastructure/sourceJobInspector.js";
import { sourceIsolationLibraries } from "../src/modules/prepaid/domain/sourceIsolation.js";
import { nativeJobFixture } from "./fixtures/prepaidSource.js";
import { sourceWorkflows } from "../src/modules/prepaid/domain/sourceExtraction.js";

const arn =
  "arn:aws:states:us-east-1:123456789012:execution:isg-esatp-dv-prcl_cc_sg-sf:prepaid-source-owned";
function fixture(
  options: {
    foreignRun?: boolean;
    truncate?: boolean;
    noId?: boolean;
    foreignExecution?: boolean;
    historyFailure?: boolean;
  } = {},
) {
  const glue = {
    send: vi.fn(async (command: any) => ({
      JobRuns: command.input.JobName.endsWith("_1")
        ? [
            {
              Id: options.noId ? undefined : "jr_owned",
              JobRunState: "RUNNING",
            },
            ...(options.foreignRun
              ? [{ Id: "jr_foreign", JobRunState: "RUNNING" }]
              : []),
          ]
        : [],
    })),
  };
  const sfn = {
    send: vi.fn(async (command: any) => {
      if (command.constructor.name === "ListExecutionsCommand")
        return {
          executions: [
            { executionArn: arn },
            ...(options.foreignExecution
              ? [{ executionArn: arn + "foreign" }]
              : []),
          ],
        };
      if (options.historyFailure) throw Error("History permission denied");
      return {
        events: [
          {
            taskSubmittedEventDetails: {
              resourceType: "glue",
              resource: "startJobRun.sync",
              outputDetails: { truncated: !!options.truncate },
              output: JSON.stringify({
                JobName: "isg-esatp-dv-prep_reclass-gljo-extract_1",
                JobRunId: "jr_owned",
              }),
            },
          },
        ],
      };
    }),
  };
  const inspector = new AwsSourceJobInspector(glue as any, sfn as any);
  const cohort = { executions: { callcard_sg: arn }, allowOwnedGlue: true };
  return { inspector, glue, sfn, cohort };
}
describe("Parallel extraction ownership", () => {
  it("allows only an active Glue run attested by the exact named cohort execution", async () => {
    const c = fixture();
    await c.inspector.idle(["machine"], "isg-esatp-dv", undefined, c.cohort);
    expect(
      c.sfn.send.mock.calls.some(
        ([cmd]) => cmd.constructor.name === "GetExecutionHistoryCommand",
      ),
    ).toBe(true);
    expect(
      c.glue.send.mock.calls.every(
        ([cmd]) => cmd.constructor.name === "GetJobRunsCommand",
      ),
    ).toBe(true);
  });
  it.each([
    "foreignRun",
    "truncate",
    "noId",
    "foreignExecution",
    "historyFailure",
  ] as const)(
    "blocks %s without allowing a job-name-based bypass",
    async (option) => {
      const c = fixture({ [option]: true });
      await expect(
        c.inspector.idle(["machine"], "isg-esatp-dv", undefined, c.cohort),
      ).rejects.toThrow();
    },
  );
  it("never permits cleanup while even an owned Glue run is active", async () => {
    const c = fixture();
    await expect(
      c.inspector.idle([], "isg-esatp-dv", undefined, {
        ...c.cohort,
        allowOwnedGlue: false,
      }),
    ).rejects.toThrow("still active");
    expect(c.sfn.send).not.toHaveBeenCalled();
  });
  it("requires reviewed shared asset contents before parallel dispatch", async () => {
    const inspector = new AwsSourceJobInspector(
      {} as any,
      {} as any,
      async () => Buffer.from("changed"),
    );
    await expect(inspector.verifyIsolation()).rejects.toThrow(
      "implementation changed",
    );
    await expect(
      new AwsSourceJobInspector({} as any, {} as any).verifyIsolation(),
    ).rejects.toThrow("read-only verification");
  });
  it("rejects an extra Python dependency even when ordinary parsing arguments match", async () => {
    const mapping = sourceWorkflows.callcard_sg,
      original = nativeJobFixture(1);
    const libs = sourceIsolationLibraries(false).join(",");
    let extra = "";
    const glue = {
      send: vi.fn(async () => ({
        Job: {
          Command: original.command,
          DefaultArguments: {
            ...original.arguments,
            "--folder_location": "test/prepaid_reclass/",
            "--input_file_name": mapping.inputPattern,
            "--target_table": `sdbtdir1_prepaid_dbo.${mapping.targets[0]}`,
            "--extra-py-files": libs + extra,
          },
        },
      })),
    };
    const inspector = new AwsSourceJobInspector(glue as any, {} as any);
    await inspector.verify("callcard_sg", "isg-esatp-dv", "test", true);
    extra = ",s3://unreviewed/override.py";
    await expect(
      inspector.verify("callcard_sg", "isg-esatp-dv", "test", true),
    ).rejects.toThrow("differs");
  });
});
