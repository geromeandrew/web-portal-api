import { DescribeExecutionCommand, DescribeStateMachineCommand, SFNClient, StartExecutionCommand, type SFNClient as SFNClientType } from "@aws-sdk/client-sfn";
import { GetCallerIdentityCommand, STSClient, type STSClient as STSClientType } from "@aws-sdk/client-sts";
import type { Config } from "./config.js";

type StepFunctionsSender = Pick<SFNClientType, "send">;
type StsSender = Pick<STSClientType, "send">;

export type StepFunctionsRunner = {
  startExecution(stateMachineName: string, input: Record<string, unknown>): Promise<{ executionArn: string; startedAt: string }>;
  describeExecution(executionArn: string): Promise<{ status: string; errorCode: string | null; errorMessage: string | null; input: string | null; inputIncluded: boolean | null; output: string | null; outputIncluded: boolean | null; mapRunArn: string | null; traceHeader: string | null; startedAt: string | null; completedAt: string | null }>;
  describeStateMachine(stateMachineName: string): Promise<{ name: string; arn: string; status: string | null; type: string; revisionId: string | null; createdAt: string; logging: { level: string | null; includeExecutionData: boolean | null; logGroupArn: string | null }; tracingEnabled: boolean | null }>;
};

export class AwsStepFunctionsRunner implements StepFunctionsRunner {
  private identity: Promise<{ partition: string; accountId: string }> | undefined;

  constructor(private readonly client: StepFunctionsSender, private readonly stsClient: StsSender, private readonly region: string) {}

  async startExecution(stateMachineName: string, input: Record<string, unknown>) {
    const response = await this.client.send(new StartExecutionCommand({ stateMachineArn: await this.stateMachineArn(stateMachineName), input: JSON.stringify(input) }));
    if (!response.executionArn || !response.startDate) throw new Error("AWS Step Functions did not return an execution ARN and start time.");
    return { executionArn: response.executionArn, startedAt: response.startDate.toISOString() };
  }

  async describeExecution(executionArn: string) {
    const response = await this.client.send(new DescribeExecutionCommand({ executionArn }));
    if (!response.status) throw new Error("AWS Step Functions did not return execution status.");
    return { status: response.status, errorCode: response.error ?? null, errorMessage: response.cause ?? null, input: response.input ?? null, inputIncluded: response.inputDetails?.included ?? null, output: response.output ?? null, outputIncluded: response.outputDetails?.included ?? null, mapRunArn: response.mapRunArn ?? null, traceHeader: response.traceHeader ?? null, startedAt: response.startDate?.toISOString() ?? null, completedAt: response.stopDate?.toISOString() ?? null };
  }

  async describeStateMachine(stateMachineName: string) {
    const response = await this.client.send(new DescribeStateMachineCommand({ stateMachineArn: await this.stateMachineArn(stateMachineName), includedData: "METADATA_ONLY" }));
    if (!response.name || !response.stateMachineArn || !response.type || !response.creationDate) throw new Error("AWS Step Functions did not return complete state machine metadata.");
    const logging = response.loggingConfiguration;
    return {
      name: response.name,
      arn: response.stateMachineArn,
      status: response.status ?? null,
      type: response.type,
      revisionId: response.revisionId ?? null,
      createdAt: response.creationDate.toISOString(),
      logging: { level: logging?.level ?? null, includeExecutionData: logging?.includeExecutionData ?? null, logGroupArn: logging?.destinations?.[0]?.cloudWatchLogsLogGroup?.logGroupArn ?? null },
      tracingEnabled: response.tracingConfiguration?.enabled ?? null,
    };
  }

  private async stateMachineArn(stateMachineName: string) {
    const identity = await (this.identity ??= this.loadIdentity());
    return `arn:${identity.partition}:states:${this.region}:${identity.accountId}:stateMachine:${stateMachineName}`;
  }

  private async loadIdentity() {
    const response = await this.stsClient.send(new GetCallerIdentityCommand({}));
    const arn = response.Arn?.split(":");
    const partition = arn?.[1];
    const accountId = response.Account ?? arn?.[4];
    if (!partition || !accountId) throw new Error("AWS STS did not return the current account identity.");
    return { partition, accountId };
  }
}

export function createStepFunctionsRunner(config: Config): StepFunctionsRunner {
  return new AwsStepFunctionsRunner(new SFNClient({ region: config.AWS_REGION }), new STSClient({ region: config.AWS_REGION }), config.AWS_REGION);
}
