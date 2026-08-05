import { DescribeLogStreamsCommand, GetLogEventsCommand, type CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { GetJobRunCommand, StartJobRunCommand, type GlueClient } from "@aws-sdk/client-glue";
import { describe, expect, it, vi } from "vitest";
import { AwsGlueJobRunner } from "../src/glueJobRunner.js";

describe("AwsGlueJobRunner", () => {
  it("starts the mapped Glue job with portal-specific runtime arguments", async () => {
    const send = vi.fn().mockResolvedValue({ JobRunId: "jr_123" });
    const runner = new AwsGlueJobRunner({ send } as unknown as Pick<GlueClient, "send">);

    await expect(runner.startJob("MyBSS_Bayan_EOC01_P10_308-Billed-Adjustments-01", { "--input_file_name": "source.xlsx" })).resolves.toEqual({ jobRunId: "jr_123" });
    expect(send.mock.calls[0][0]).toBeInstanceOf(StartJobRunCommand);
    expect((send.mock.calls[0][0] as { input: unknown }).input).toEqual({ JobName: "MyBSS_Bayan_EOC01_P10_308-Billed-Adjustments-01", Arguments: { "--input_file_name": "source.xlsx" } });
  });

  it("rejects a Glue response without a job run ID", async () => {
    const runner = new AwsGlueJobRunner({ send: vi.fn().mockResolvedValue({}) } as unknown as Pick<GlueClient, "send">);
    await expect(runner.startJob("job")).rejects.toThrow("did not return a job run ID");
  });

  it("returns the current Glue job run status", async () => {
    const send = vi.fn().mockResolvedValue({ JobRun: { Id: "jr_123", JobRunState: "RUNNING", StartedOn: new Date("2026-07-31T09:00:00Z") } });
    const runner = new AwsGlueJobRunner({ send } as unknown as Pick<GlueClient, "send">);

    await expect(runner.getJobRun("job", "jr_123")).resolves.toEqual({ jobRunId: "jr_123", jobName: "job", status: "RUNNING", errorMessage: null, startedAt: "2026-07-31T09:00:00.000Z", completedAt: null });
    expect(send.mock.calls[0][0]).toBeInstanceOf(GetJobRunCommand);
    expect((send.mock.calls[0][0] as { input: unknown }).input).toEqual({ JobName: "job", RunId: "jr_123", PredecessorsIncluded: false });
  });

  it("uses the complete CloudWatch error log when Glue truncates its error message", async () => {
    const glueSend = vi.fn().mockResolvedValue({ JobRun: { Id: "jr_123", JobRunState: "FAILED", ErrorMessage: "GLUE_CUSTOM_PAYLOAD|{\"reason\":\"SparkException: Job aborted...\"}|GLUE_CUSTOM_PAYLOAD" } });
    const logsSend = vi.fn()
      .mockResolvedValueOnce({ logStreams: [{ logStreamName: "jr_123-driver" }] })
      .mockResolvedValueOnce({ events: [{ message: "GLUE_CUSTOM_PAYLOAD|{\"reason\":\"SparkException: Job aborted due to stage failure\"}|GLUE_CUSTOM_PAYLOAD" }], nextForwardToken: "token-1" })
      .mockResolvedValueOnce({ events: [], nextForwardToken: "token-1" });
    const runner = new AwsGlueJobRunner(
      { send: glueSend } as unknown as Pick<GlueClient, "send">,
      { send: logsSend } as unknown as Pick<CloudWatchLogsClient, "send">,
    );

    await expect(runner.getJobRun("job", "jr_123")).resolves.toMatchObject({ errorMessage: "GLUE_CUSTOM_PAYLOAD|{\"reason\":\"SparkException: Job aborted due to stage failure\"}|GLUE_CUSTOM_PAYLOAD" });
    expect(logsSend.mock.calls[0][0]).toBeInstanceOf(DescribeLogStreamsCommand);
    expect(logsSend.mock.calls[1][0]).toBeInstanceOf(GetLogEventsCommand);
  });
});
