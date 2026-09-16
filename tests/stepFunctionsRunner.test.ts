import {
  DescribeExecutionCommand,
  DescribeStateMachineCommand,
  StartExecutionCommand,
  type SFNClient,
} from "@aws-sdk/client-sfn";
import { GetCallerIdentityCommand, type STSClient } from "@aws-sdk/client-sts";
import { describe, expect, it, vi } from "vitest";
import { AwsStepFunctionsRunner } from "../src/stepFunctionsRunner.js";

describe("AwsStepFunctionsRunner", () => {
  it("starts the mapped state machine with the exact batch-cycle input", async () => {
    const stepFunctionsSend = vi.fn().mockResolvedValue({
      executionArn:
        "arn:aws:states:ap-southeast-1:123456789012:execution:machine:run",
      startDate: new Date("2026-08-07T07:00:00Z"),
    });
    const stsSend = vi.fn().mockResolvedValue({
      Account: "123456789012",
      Arn: "arn:aws:sts::123456789012:assumed-role/portal/api",
    });
    const runner = new AwsStepFunctionsRunner(
      { send: stepFunctionsSend } as unknown as Pick<SFNClient, "send">,
      { send: stsSend } as unknown as Pick<STSClient, "send">,
      "ap-southeast-1",
    );

    await expect(
      runner.startExecution(
        "isg-esatp-dv-bss_billcycle_bayn_308_preload-state_machine",
        { cycle: "01" },
      ),
    ).resolves.toEqual({
      executionArn:
        "arn:aws:states:ap-southeast-1:123456789012:execution:machine:run",
      startedAt: "2026-08-07T07:00:00.000Z",
    });
    expect(stsSend.mock.calls[0][0]).toBeInstanceOf(GetCallerIdentityCommand);
    expect(stepFunctionsSend.mock.calls[0][0]).toBeInstanceOf(
      StartExecutionCommand,
    );
    expect(
      (stepFunctionsSend.mock.calls[0][0] as { input: unknown }).input,
    ).toEqual({
      stateMachineArn:
        "arn:aws:states:ap-southeast-1:123456789012:stateMachine:isg-esatp-dv-bss_billcycle_bayn_308_preload-state_machine",
      input: '{"cycle":"01"}',
    });
  });

  it("returns Standard Step Functions execution status", async () => {
    const stepFunctionsSend = vi.fn().mockResolvedValue({
      status: "SUCCEEDED",
      startDate: new Date("2026-08-07T07:00:00Z"),
      stopDate: new Date("2026-08-07T07:02:00Z"),
    });
    const runner = new AwsStepFunctionsRunner(
      { send: stepFunctionsSend } as unknown as Pick<SFNClient, "send">,
      { send: vi.fn() } as unknown as Pick<STSClient, "send">,
      "ap-southeast-1",
    );

    await expect(
      runner.describeExecution(
        "arn:aws:states:ap-southeast-1:123456789012:execution:machine:run",
      ),
    ).resolves.toEqual({
      status: "SUCCEEDED",
      errorCode: null,
      errorMessage: null,
      input: null,
      inputIncluded: null,
      output: null,
      outputIncluded: null,
      mapRunArn: null,
      traceHeader: null,
      startedAt: "2026-08-07T07:00:00.000Z",
      completedAt: "2026-08-07T07:02:00.000Z",
    });
    expect(stepFunctionsSend.mock.calls[0][0]).toBeInstanceOf(
      DescribeExecutionCommand,
    );
  });

  it("keeps a future mapping's static input unchanged", async () => {
    const stepFunctionsSend = vi.fn().mockResolvedValue({
      executionArn:
        "arn:aws:states:ap-southeast-1:123456789012:execution:machine:run",
      startDate: new Date("2026-08-07T07:00:00Z"),
    });
    const stsSend = vi.fn().mockResolvedValue({
      Account: "123456789012",
      Arn: "arn:aws:sts::123456789012:assumed-role/portal/api",
    });
    const runner = new AwsStepFunctionsRunner(
      { send: stepFunctionsSend } as unknown as Pick<SFNClient, "send">,
      { send: stsSend } as unknown as Pick<STSClient, "send">,
      "ap-southeast-1",
    );

    await runner.startExecution("future-state-machine", {
      report_month: "202608",
      reprocess: true,
    });

    expect(
      (stepFunctionsSend.mock.calls[0][0] as { input: { input: string } }).input
        .input,
    ).toBe('{"report_month":"202608","reprocess":true}');
  });

  it("retrieves metadata only for the mapped state machine", async () => {
    const stepFunctionsSend = vi.fn().mockResolvedValue({
      stateMachineArn:
        "arn:aws:states:ap-southeast-1:123456789012:stateMachine:machine",
      name: "machine",
      status: "ACTIVE",
      type: "STANDARD",
      creationDate: new Date("2026-08-01T00:00:00Z"),
      revisionId: "revision-1",
      loggingConfiguration: {
        level: "ERROR",
        includeExecutionData: false,
        destinations: [
          {
            cloudWatchLogsLogGroup: {
              logGroupArn:
                "arn:aws:logs:ap-southeast-1:123456789012:log-group:machine",
            },
          },
        ],
      },
      tracingConfiguration: { enabled: true },
    });
    const stsSend = vi.fn().mockResolvedValue({
      Account: "123456789012",
      Arn: "arn:aws:sts::123456789012:assumed-role/portal/api",
    });
    const runner = new AwsStepFunctionsRunner(
      { send: stepFunctionsSend } as unknown as Pick<SFNClient, "send">,
      { send: stsSend } as unknown as Pick<STSClient, "send">,
      "ap-southeast-1",
    );

    await expect(runner.describeStateMachine("machine")).resolves.toMatchObject(
      {
        name: "machine",
        arn: "arn:aws:states:ap-southeast-1:123456789012:stateMachine:machine",
        status: "ACTIVE",
        type: "STANDARD",
        revisionId: "revision-1",
        logging: { level: "ERROR", includeExecutionData: false },
        tracingEnabled: true,
      },
    );
    expect(stepFunctionsSend.mock.calls[0][0]).toBeInstanceOf(
      DescribeStateMachineCommand,
    );
    expect(
      (stepFunctionsSend.mock.calls[0][0] as { input: unknown }).input,
    ).toEqual({
      stateMachineArn:
        "arn:aws:states:ap-southeast-1:123456789012:stateMachine:machine",
      includedData: "METADATA_ONLY",
    });
  });
});
