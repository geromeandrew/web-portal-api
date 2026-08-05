import { CloudWatchLogsClient, DescribeLogStreamsCommand, GetLogEventsCommand, type CloudWatchLogsClient as CloudWatchLogsClientType } from "@aws-sdk/client-cloudwatch-logs";
import { GetJobRunCommand, GlueClient, StartJobRunCommand } from "@aws-sdk/client-glue";
import type { Config } from "./config.js";

type GlueSender = Pick<GlueClient, "send">;
type CloudWatchLogsSender = Pick<CloudWatchLogsClientType, "send">;

const glueErrorLogGroups = ["/aws-glue/jobs/error", "/aws-glue/jobs/logs-v2"];

export type GlueJobRunner = {
  startJob(jobName: string, jobArguments?: Record<string, string>): Promise<{ jobRunId: string }>;
  getJobRun(jobName: string, jobRunId: string): Promise<{ jobRunId: string; jobName: string; status: string; errorMessage: string | null; startedAt: string | null; completedAt: string | null }>;
};

export class AwsGlueJobRunner implements GlueJobRunner {
  constructor(private readonly client: GlueSender, private readonly logsClient?: CloudWatchLogsSender) {}

  async startJob(jobName: string, jobArguments?: Record<string, string>) {
    const response = await this.client.send(new StartJobRunCommand({ JobName: jobName, ...(jobArguments ? { Arguments: jobArguments } : {}) }));
    if (!response.JobRunId) throw new Error("AWS Glue did not return a job run ID.");
    return { jobRunId: response.JobRunId };
  }

  async getJobRun(jobName: string, jobRunId: string) {
    const response = await this.client.send(new GetJobRunCommand({ JobName: jobName, RunId: jobRunId, PredecessorsIncluded: false }));
    const run = response.JobRun;
    if (!run?.JobRunState) throw new Error("AWS Glue did not return job run status.");
    return {
      jobRunId: run.Id ?? jobRunId,
      jobName,
      status: run.JobRunState,
      errorMessage: await this.getFullErrorMessage(run.ErrorMessage ?? null, run.Id ?? jobRunId),
      startedAt: run.StartedOn?.toISOString() ?? null,
      completedAt: run.CompletedOn?.toISOString() ?? null,
    };
  }

  private async getFullErrorMessage(errorMessage: string | null, jobRunId: string) {
    if (!errorMessage?.includes("...") || !this.logsClient) return errorMessage;
    const untruncatedPrefix = errorMessage.slice(0, errorMessage.indexOf("..."));

    try {
      for (const logGroupName of glueErrorLogGroups) {
        const streams = await this.logsClient.send(new DescribeLogStreamsCommand({ logGroupName, logStreamNamePrefix: jobRunId }));
        const stream = streams.logStreams?.find((candidate) => candidate.logStreamName?.endsWith("-driver")) ?? streams.logStreams?.[0];
        if (!stream?.logStreamName) continue;

        const messages: string[] = [];
        let nextToken: string | undefined;
        do {
          const events = await this.logsClient.send(new GetLogEventsCommand({ logGroupName, logStreamName: stream.logStreamName, startFromHead: true, nextToken }));
          messages.push(...(events.events ?? []).flatMap((event) => event.message ? [event.message] : []));
          if (events.nextForwardToken === nextToken) break;
          nextToken = events.nextForwardToken;
        } while (nextToken);

        const completeMessage = messages.find((message) => message.includes(untruncatedPrefix));
        if (completeMessage) return completeMessage;
      }
    } catch {
      // CloudWatch access and log delivery are optional; keep Glue's message as a fallback.
    }

    return errorMessage;
  }
}

export function createGlueJobRunner(config: Config): GlueJobRunner {
  return new AwsGlueJobRunner(new GlueClient({ region: config.AWS_REGION }), new CloudWatchLogsClient({ region: config.AWS_REGION }));
}
