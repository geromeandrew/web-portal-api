import {
  GlueClient,
  GetJobCommand,
  GetJobRunsCommand,
} from "@aws-sdk/client-glue";
import {
  SFNClient,
  ListExecutionsCommand,
  GetExecutionHistoryCommand,
} from "@aws-sdk/client-sfn";
import { createHash } from "node:crypto";
import {
  sourceIsolationAssets,
  sourceIsolationLibraries,
  isReviewedSourceAsset,
} from "../domain/sourceIsolation.js";
import {
  sourceWorkflows,
  type SourceWorkflow,
} from "../domain/sourceExtraction.js";
import {
  sourceJobArgumentDrift,
  sourceJobScript,
} from "../domain/sourceJobContracts.js";
import { SharedExtractionBusy } from "./legacyLanding.js";
import { boundedRead } from "./boundedRead.js";
import {
  reviewedSourceResources,
  sourceGlueJobName,
  type SourceResources,
} from "../domain/sourceResources.js";

export interface SourceJobInspector {
  verify(
    workflow: SourceWorkflow,
    envPrefix: string,
    bucket: string,
    parallel?: boolean,
    resources?: SourceResources,
  ): Promise<void>;
  verifyIsolation?(resources?: SourceResources): Promise<void>;
  idle(
    machines: string[],
    envPrefix: string,
    ownExecution?: string,
    cohort?: {
      executions: Partial<Record<SourceWorkflow, string>>;
      allowOwnedGlue: boolean;
    },
    resources?: SourceResources,
  ): Promise<void>;
}
/** Read-only inspection: no job/state-machine/script updates or deployments. */
export class AwsSourceJobInspector implements SourceJobInspector {
  constructor(
    private readonly glue: Pick<GlueClient, "send">,
    private readonly sfn: Pick<SFNClient, "send">,
    private readonly readAsset?: (
      key: string,
      bucket?: string,
    ) => Promise<Uint8Array>,
  ) {}
  private async verifyAsset(
    bucket: string,
    objectKey: string,
    reviewedKey: string,
  ) {
    const bytes = await this.readAsset!(objectKey, bucket);
    const actualSha256 = createHash("sha256").update(bytes).digest("hex");
    if (!isReviewedSourceAsset(reviewedKey, actualSha256))
      throw Object.assign(
        new Error(
          `Shared Glue implementation changed: ${reviewedKey} (version ${actualSha256.slice(0, 12)}). This version needs a backend compatibility review before extraction can continue.`,
        ),
        {
          details: {
            sourceAssetKey: objectKey,
            sourceAssetBucket: bucket,
            sourceAssetSha256: actualSha256,
            sourceAssetExpectedSha256: sourceIsolationAssets[reviewedKey],
          },
        },
      );
  }
  async verifyIsolation(resources: SourceResources = reviewedSourceResources) {
    if (!this.readAsset)
      throw Error(
        "Parallel extraction requires read-only verification of the shared Glue implementation.",
      );
    const mappings = Object.values(sourceWorkflows);
    const targets = mappings.flatMap((m) => [...m.targets]);
    const jobs = mappings.flatMap((m) => [...m.jobs]);
    if (
      new Set(targets).size !== targets.length ||
      new Set(jobs).size !== jobs.length
    )
      throw Error("Parallel extraction target/job identities overlap.");
    // The entry point is checked against each job's actual ScriptLocation.
    await boundedRead(
      Object.keys(sourceIsolationAssets).filter(
        (key) => !key.startsWith("scripts/"),
      ),
      (key) =>
        this.verifyAsset(
          resources.scriptsBucket,
          resources.scriptsPrefix + key,
          key,
        ),
    );
  }
  async verify(
    workflow: SourceWorkflow,
    envPrefix: string,
    bucket: string,
    parallel = false,
    resources: SourceResources = reviewedSourceResources,
  ) {
    const mapping = sourceWorkflows[workflow];
    for (const [index, number] of mapping.jobs.entries()) {
      const name = sourceGlueJobName(number, envPrefix, resources);
      const job = (await this.glue.send(new GetJobCommand({ JobName: name })))
        .Job;
      const args = {
        ...job?.DefaultArguments,
        ...job?.NonOverridableArguments,
      };
      const drift = sourceJobArgumentDrift(number, args, envPrefix, resources);
      const scriptBucket = resources.scriptsBucket;
      const scriptPrefix = `s3://${scriptBucket}/`;
      const script = job?.Command?.ScriptLocation;
      const canonical = sourceJobScript(number, resources);
      const reviewedKey = canonical.slice(
        scriptPrefix.length + resources.scriptsPrefix.length,
      );
      const sandboxRelease =
        number !== 9 &&
        envPrefix === "isg-esatp-dv" &&
        scriptBucket === reviewedSourceResources.scriptsBucket &&
        resources.scriptsPrefix === reviewedSourceResources.scriptsPrefix
          ? "s3://isg-esatp-rcc-scripts-os/glue/dv-v0.0.1/prepaid_reclass/a27a81d36f2eb42c/GlueSpreadsheetWildcard.py"
          : undefined;
      const libraries = (args["--extra-py-files"] ?? "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
        .sort();
      if (
        job?.Command?.Name !== "glueetl" ||
        !script ||
        (script !== canonical && script !== sandboxRelease) ||
        args["--folder_location"] !== `${bucket}/prepaid_reclass/` ||
        args["--input_file_name"] !== mapping.inputPattern ||
        args["--target_table"] !==
          `sdbtdir1_prepaid_dbo.${mapping.targets[index]}` ||
        (index === 0 &&
          mapping.jobs.length > 1 &&
          args["--move_to_success"] !== "false") ||
        Object.keys(args).some((key) => key.startsWith("--portal_")) ||
        !!args["--scriptLocation"] ||
        drift.length > 0 ||
        (parallel &&
          JSON.stringify(libraries) !==
            JSON.stringify(sourceIsolationLibraries(number === 9, resources)))
      )
        throw Error(
          `Existing Glue job input/target contract differs from the backend mapping: ${name}${drift.length ? ` (${drift.join(", ")})` : ""}. No AWS configuration was changed.`,
        );
      if (this.readAsset)
        await this.verifyAsset(
          scriptBucket,
          script.slice(scriptPrefix.length),
          reviewedKey,
        );
    }
  }
  async idle(
    machines: string[],
    envPrefix: string,
    ownExecution?: string,
    cohort?: {
      executions: Partial<Record<SourceWorkflow, string>>;
      allowOwnedGlue: boolean;
    },
    resources?: SourceResources,
  ) {
    const allowed = new Set(
      [ownExecution, ...Object.values(cohort?.executions ?? {})].filter(
        Boolean,
      ),
    );
    await boundedRead(machines, async (arn) => {
      let token: string | undefined;
      do {
        const page = await this.sfn.send(
          new ListExecutionsCommand({
            stateMachineArn: arn,
            statusFilter: "RUNNING",
            nextToken: token,
          }),
        );
        if (
          page.executions?.some(
            (e) => !e.executionArn || !allowed.has(e.executionArn),
          )
        )
          throw new SharedExtractionBusy(
            "Another source workflow is running against shared legacy inputs.",
          );
        token = page.nextToken;
      } while (token);
    });
    const active: { job: string; id?: string }[] = [];
    await boundedRead(
      [
        ...new Set(
          Object.values(sourceWorkflows).flatMap((mapping) => [
            ...mapping.jobs,
          ]),
        ),
      ],
      async (number) => {
        let token: string | undefined;
        do {
          const page = await this.glue.send(
            new GetJobRunsCommand({
              JobName: sourceGlueJobName(number, envPrefix, resources),
              NextToken: token,
              MaxResults: 200,
            }),
          );
          for (const run of page.JobRuns ?? []) {
            if (
              ![
                "SUCCEEDED",
                "FAILED",
                "TIMEOUT",
                "STOPPED",
                "ERROR",
                "EXPIRED",
              ].includes(run.JobRunState ?? "")
            )
              active.push({
                job: sourceGlueJobName(number, envPrefix, resources),
                id: run.Id,
              });
          }
          token = page.NextToken;
        } while (token);
      },
    );
    if (!active.length) return;
    if (!cohort?.allowOwnedGlue)
      throw new SharedExtractionBusy(
        "A Glue extraction is still active. Shared input cleanup/dispatch must wait.",
      );
    // Job names alone are not ownership. Obtain each actual Glue run ID from
    // the persisted named execution's native TaskSubmitted event. Foreign runs,
    // truncated histories and unknown identities remain blocking.
    const ownedRuns = new Set<string>();
    await boundedRead(
      Object.entries(cohort.executions),
      async ([workflow, executionArn]) => {
        const jobs = sourceWorkflows[workflow as SourceWorkflow].jobs.map(
          (number) => sourceGlueJobName(number, envPrefix, resources),
        );
        let nextToken: string | undefined,
          pages = 0;
        do {
          if (++pages > 20)
            throw Error(
              "Source execution history exceeds the ownership verification limit.",
            );
          const page = await this.sfn.send(
            new GetExecutionHistoryCommand({
              executionArn,
              maxResults: 1000,
              includeExecutionData: true,
              nextToken,
            }),
          );
          for (const event of page.events ?? []) {
            const detail = event.taskSubmittedEventDetails;
            if (
              detail?.resourceType !== "glue" ||
              detail.resource !== "startJobRun.sync"
            )
              continue;
            if (detail.outputDetails?.truncated || !detail.output)
              throw Error(
                "Glue ownership history is incomplete; retain the shared-input lock.",
              );
            const output = JSON.parse(detail.output);
            if (
              jobs.includes(output.JobName) &&
              typeof output.JobRunId === "string" &&
              output.JobRunId
            )
              ownedRuns.add(`${output.JobName}:${output.JobRunId}`);
          }
          nextToken = page.nextToken;
        } while (nextToken);
      },
    );
    if (active.some((run) => !run.id || !ownedRuns.has(`${run.job}:${run.id}`)))
      throw new SharedExtractionBusy(
        "A foreign or unverified Glue run is active. Parallel dispatch must wait.",
      );
  }
}
