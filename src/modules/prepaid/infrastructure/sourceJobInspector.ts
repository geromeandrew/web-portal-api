import {
  GlueClient,
  GetJobCommand,
  GetJobRunsCommand,
} from "@aws-sdk/client-glue";
import { SFNClient, ListExecutionsCommand } from "@aws-sdk/client-sfn";
import {
  sourceWorkflows,
  type SourceWorkflow,
} from "../domain/sourceExtraction.js";
import { SharedExtractionBusy } from "./legacyLanding.js";

export interface SourceJobInspector {
  verify(
    workflow: SourceWorkflow,
    envPrefix: string,
    bucket: string,
  ): Promise<void>;
  idle(
    machines: string[],
    envPrefix: string,
    ownExecution?: string,
  ): Promise<void>;
}
/** Read-only inspection: no job/state-machine/script updates or deployments. */
export class AwsSourceJobInspector implements SourceJobInspector {
  constructor(
    private readonly glue: Pick<GlueClient, "send">,
    private readonly sfn: Pick<SFNClient, "send">,
  ) {}
  async verify(workflow: SourceWorkflow, envPrefix: string, bucket: string) {
    const mapping = sourceWorkflows[workflow];
    for (const [index, number] of mapping.jobs.entries()) {
      const name = `${envPrefix}-prep_reclass-gljo-extract_${number}`;
      const job = (await this.glue.send(new GetJobCommand({ JobName: name })))
        .Job;
      const args = {
        ...job?.DefaultArguments,
        ...job?.NonOverridableArguments,
      };
      if (
        job?.Command?.Name !== "glueetl" ||
        args["--folder_location"] !== `${bucket}/prepaid_reclass/` ||
        args["--input_file_name"] !== mapping.inputPattern ||
        args["--target_table"] !==
          `sdbtdir1_prepaid_dbo.${mapping.targets[index]}` ||
        (index === 0 &&
          mapping.jobs.length > 1 &&
          args["--move_to_success"] !== "false") ||
        Object.keys(args).some((key) => key.startsWith("--portal_"))
      )
        throw Error(
          `Existing Glue job input/target contract differs from the backend mapping: ${name}. No AWS configuration was changed.`,
        );
    }
  }
  async idle(machines: string[], envPrefix: string, ownExecution?: string) {
    for (const arn of machines) {
      let token: string | undefined;
      do {
        const page = await this.sfn.send(
          new ListExecutionsCommand({
            stateMachineArn: arn,
            statusFilter: "RUNNING",
            nextToken: token,
          }),
        );
        if (page.executions?.some((e) => e.executionArn !== ownExecution))
          throw new SharedExtractionBusy(
            "Another source workflow is running against shared legacy inputs.",
          );
        token = page.nextToken;
      } while (token);
    }
    for (const number of [
      ...new Set(
        Object.values(sourceWorkflows).flatMap((mapping) => [...mapping.jobs]),
      ),
    ]) {
      let token: string | undefined;
      do {
        const page = await this.glue.send(
          new GetJobRunsCommand({
            JobName: `${envPrefix}-prep_reclass-gljo-extract_${number}`,
            NextToken: token,
            MaxResults: 200,
          }),
        );
        if (
          page.JobRuns?.some(
            (run) =>
              ![
                "SUCCEEDED",
                "FAILED",
                "TIMEOUT",
                "STOPPED",
                "ERROR",
                "EXPIRED",
              ].includes(run.JobRunState ?? ""),
          )
        )
          throw new SharedExtractionBusy(
            "A Glue extraction is still active. Shared input cleanup/dispatch must wait.",
          );
        token = page.NextToken;
      } while (token);
    }
  }
}
