import {
  DescribeExecutionCommand,
  DescribeStateMachineCommand,
  GetExecutionHistoryCommand,
  StartExecutionCommand,
  type SFNClient,
} from "@aws-sdk/client-sfn";
import { GetCallerIdentityCommand, type STSClient } from "@aws-sdk/client-sts";
import { describe, expect, it, vi } from "vitest";
import { AwsStepFunctionsRunner } from "../src/stepFunctionsRunner.js";

describe("AwsStepFunctionsRunner", () => {
  it("uses the newest import stage from execution history without reading its data", async () => {
    const send = vi.fn().mockResolvedValue({
      events: [
        { stateEnteredEventDetails: { name: "eg_import" } },
        { stateEnteredEventDetails: { name: "Import" } },
        { stateEnteredEventDetails: { name: "Refresh_ZTF0455S" } },
        { stateEnteredEventDetails: { name: "Extract_All" } },
      ],
    });
    const runner = new AwsStepFunctionsRunner(
      { send } as unknown as SFNClient,
      { send: vi.fn() } as unknown as STSClient,
      "us-east-1",
    );
    await expect(runner.prepaidImportStage("execution-arn")).resolves.toBe("importing-layouts");
    const command = send.mock.calls[0][0];
    expect(command).toBeInstanceOf(GetExecutionHistoryCommand);
    expect(command.input).toMatchObject({ reverseOrder: true, includeExecutionData: false });
  });

  it("recovers a named execution after jsonb key reordering but rejects changed values", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("exists"), { name: "ExecutionAlreadyExists" }),
      )
      .mockResolvedValueOnce({
        status: "RUNNING",
        input: '{"b":2,"a":1}',
        startDate: new Date("2026-10-16T00:00:00Z"),
      });
    const runner = new AwsStepFunctionsRunner(
      { send } as any,
      {
        send: vi.fn().mockResolvedValue({
          Account: "123456789012",
          Arn: "arn:aws:sts::123456789012:assumed-role/test/test",
        }),
      } as any,
      "us-east-1",
    );
    expect(
      (await runner.startExecution("source", { a: 1, b: 2 }, "persisted-name"))
        .executionArn,
    ).toBe(
      "arn:aws:states:us-east-1:123456789012:execution:source:persisted-name",
    );
    send
      .mockRejectedValueOnce(
        Object.assign(new Error("exists"), { name: "ExecutionAlreadyExists" }),
      )
      .mockResolvedValueOnce({ status: "RUNNING", input: '{"b":999,"a":1}' });
    await expect(
      runner.startExecution("source", { a: 1, b: 2 }, "persisted-name"),
    ).rejects.toThrow("different input");
  });
  it("retrieves executable definitions explicitly before source extraction", async () => {
    const send = vi.fn().mockResolvedValue({
      stateMachineArn:
        "arn:aws:states:us-east-1:123456789012:stateMachine:source",
      type: "STANDARD",
      status: "ACTIVE",
      definition: '{"StartAt":"PortalEntry"}',
    });
    const runner = new AwsStepFunctionsRunner(
      { send } as any,
      {
        send: vi.fn().mockResolvedValue({
          Account: "123456789012",
          Arn: "arn:aws:sts::123456789012:assumed-role/test/test",
        }),
      } as any,
      "us-east-1",
    );
    expect(
      (await runner.describeStateMachineDefinition("source")).definition,
    ).toContain("PortalEntry");
    expect(send.mock.calls[0][0].input.includedData).toBe("ALL_DATA");
  });
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

    stepFunctionsSend.mockResolvedValueOnce({
      name: "machine",
      stateMachineArn: "arn:aws:states:us-east-1:123456789012:stateMachine:machine",
      type: "STANDARD",
      creationDate: new Date("2026-08-01T00:00:00Z"),
    });
    await expect(runner.describeStateMachine("machine")).rejects.toThrow(
      "AWS Step Functions returned a different state machine.",
    );
  });
});
