import {
  sourceMachineName,
  sourceGlueJobName,
  reviewedSourceResources,
} from "../domain/sourceResources.js";
import { randomUUID } from "node:crypto";
import type { Logger } from "../../../platform/logger.js";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { GlueClient } from "@aws-sdk/client-glue";
import { SFNClient } from "@aws-sdk/client-sfn";
import { S3Client } from "@aws-sdk/client-s3";
import { loadConfig } from "../../../config.js";
import { createAwsClientOptions } from "../../../aws.js";
import { periodSchema } from "../domain/contracts.js";
import { prepaidMaximumSourceBytes } from "../domain/limits.js";
import { validateSourceFragment } from "../domain/sourceFragments.js";
import {
  extractionReceiptSchema,
  sourceWorkflows,
  selectedSourceWorkflows,
  sourceBelongsTo,
  sourceLandingName,
  validateLegacySourceDefinition,
  type SourceWorkflow,
  type sourceExtractionSchema,
} from "../domain/sourceExtraction.js";
import type { PrepaidRepository } from "../infrastructure/repository.js";
import { PrepaidStorage, sha256 } from "../infrastructure/prepaidStorage.js";
import type { StepFunctionsRunner } from "../../../stepFunctionsRunner.js";
import {
  BackendSourceNormalizer,
  type SourceNormalizer,
} from "../infrastructure/sourceNormalizer.js";
import { type SourceLanding } from "../infrastructure/legacyLanding.js";
import { boundedRead } from "../infrastructure/boundedRead.js";
import { preparationTiming } from "../domain/preparationTiming.js";
import {
  AwsGlueRawSourceReader,
  glueFinancialSource,
  GlueRawSourceValidationError,
  type GlueRawSourceReader,
} from "../infrastructure/glueRawSourceReader.js";
import { snapshotGlueSources } from "./glueSourceSnapshot.js";
import {
  AwsSourceJobInspector,
  type SourceJobInspector,
} from "../infrastructure/sourceJobInspector.js";

export class PrepaidSourceExtractionError extends Error {}
type Receipt = z.infer<typeof extractionReceiptSchema>;
type Summary = Pick<Receipt, "workflow" | "executionArn" | "artifacts"> & {
  receiptKey: string;
};
function validateNormalizedFragment(
  workflow: SourceWorkflow,
  sourceCode: string,
  name: Receipt["artifacts"][number]["name"],
  values: readonly unknown[],
) {
  if (
    (["loadapi", "loadup", "adjustment_headers", "charge_headers"].includes(
      name,
    ) &&
      values.length !== 1) ||
    (workflow === "callcard_sg" &&
      name === "callcard" &&
      values.length !== 2) ||
    (name === "ke24" && values.length === 0)
  )
    throw Error("Unexpected source aggregate/header row count.");
  for (const value of values)
    validateSourceFragment(workflow, sourceCode, name, value);
}

export class PrepaidSourceExtractionWorker {
  readonly normalizer: SourceNormalizer;
  readonly landing: SourceLanding;
  readonly inspector: SourceJobInspector;
  readonly rawReader: GlueRawSourceReader;
  constructor(
    readonly repo: PrepaidRepository,
    readonly storage: PrepaidStorage,
    readonly runner: StepFunctionsRunner,
    dependencies?: {
      normalizer: SourceNormalizer;
      landing: SourceLanding;
      inspector: SourceJobInspector;
      rawReader?: GlueRawSourceReader;
    },
    private readonly logger?: Logger,
  ) {
    this.normalizer = dependencies?.normalizer ?? new BackendSourceNormalizer();
    this.landing = dependencies?.landing ?? storage.legacyLanding(logger);
    this.rawReader = dependencies?.rawReader ?? AwsGlueRawSourceReader.create();
    if (dependencies) this.inspector = dependencies.inspector;
    else {
      const options = createAwsClientOptions(loadConfig());
      const assetClient = new S3Client(options);
      this.inspector = new AwsSourceJobInspector(
        new GlueClient(options),
        new SFNClient(options),
        (key, bucket = reviewedSourceResources.scriptsBucket) =>
          new PrepaidStorage(assetClient, bucket).bytes(
            key,
            key.slice(0, key.lastIndexOf("/") + 1),
            2 * 1024 * 1024,
          ),
      );
    }
  }
  private t = (name: string) => this.repo.table(name);
  async advance(
    job: any,
    session: any,
    settings: z.infer<typeof sourceExtractionSchema>,
    token: string,
    lost: () => boolean,
  ) {
    const started = Date.now();
    const context: Record<string, unknown> = {
      jobId: job.id,
      sessionId: session.id,
      sourceVersion: job.source_version,
    };
    const progress = (stage: string, fields: Record<string, unknown> = {}) => {
      Object.assign(context, fields, { stage });
      this.logger?.info("prepaid.extraction.progress", {
        ...context,
        ...preparationTiming(job.created_at, started),
      });
    };
    try {
      const receipts = await this.advanceWithProgress(
        job,
        session,
        settings,
        token,
        lost,
        progress,
      );
      if (receipts)
        this.logger?.info("prepaid.extraction.completed", {
          jobId: job.id,
          sessionId: session.id,
          sourceVersion: job.source_version,
          workflowCount: receipts.length,
          ...preparationTiming(job.created_at, started),
        });
      return receipts;
    } catch (error) {
      if ((settings.parallelism ?? 1) > 1) {
        const pending = await this.repo.pool.query(
          `SELECT 1 FROM ${this.t("source_extractions")} WHERE preparation_id=$1 AND (context->>'staged'='true' OR context->>'stagingStarted'='true') AND coalesce(context->>'cleaned','false')<>'true' LIMIT 1`,
          [job.id],
        );
        if (pending.rowCount && error instanceof PrepaidSourceExtractionError)
          // Never fail a parent while another cohort member may still be
          // running (including an acknowledged-but-lost named start).
          error = Object.assign(new Error(error.message, { cause: error }), {
            details: (error as any).details,
          });
        if (!pending.rowCount) await this.landing.release?.(job.id, true);
      }
      if (error && typeof error === "object")
        Object.assign(error, {
          prepaidContext: {
            ...context,
            ...((error as any).details ?? {}),
            ...preparationTiming(job.created_at, started),
          },
        });
      throw error;
    }
  }
  private async advanceWithProgress(
    job: any,
    session: any,
    settings: z.infer<typeof sourceExtractionSchema>,
    token: string,
    lost: () => boolean,
    progress: (stage: string, fields?: Record<string, unknown>) => void,
  ) {
    if (settings.sharedWritesApproved !== true)
      throw new PrepaidSourceExtractionError(
        "Unchanged Glue jobs write shared legacy raw tables. An operator must explicitly approve that configuration.",
      );
    const machine = (workflow: SourceWorkflow) =>
      sourceMachineName(workflow, settings, sourceWorkflows[workflow].machine);
    const idle = (...args: Parameters<SourceJobInspector["idle"]>) =>
      this.inspector.idle(
        args[0],
        args[1],
        args[2],
        args[3],
        settings.resources,
      );
    const parallelism = settings.parallelism ?? 1;
    if (!Number.isInteger(parallelism) || parallelism < 1 || parallelism > 3)
      throw new PrepaidSourceExtractionError(
        "Source parallelism must be between one and three.",
      );
    const parallel = parallelism > 1;
    if (!this.inspector.verifyIsolation)
      throw new PrepaidSourceExtractionError(
        "Reading Glue financial output requires verification of the native scripts and row-identity implementation before dispatch.",
      );
    if (parallel && !this.landing.release)
      throw new PrepaidSourceExtractionError(
        "Parallel extraction requires verified job isolation and preparation-owned landing coordination.",
      );
    const owns = async () => {
      const check = await this.repo.pool.query(
        `SELECT 1 FROM ${this.t("preparation_jobs")} WHERE id=$1 AND lease_token=$2 AND status='running'`,
        [job.id, token],
      );
      if (!check.rowCount || lost())
        throw Error("Source extraction preparation lease lost.");
    };
    const save = async (sql: string, parameters: unknown[]) => {
      const result = await this.repo.pool.query(
        `${sql} AND EXISTS(SELECT 1 FROM ${this.t("preparation_jobs")} WHERE id=$${parameters.length + 1} AND lease_token=$${parameters.length + 2} AND status='running')`,
        [...parameters, job.id, token],
      );
      if (!result.rowCount || lost())
        throw Error("Source extraction preparation lease or context changed.");
    };
    await owns();
    // A running child cannot be finalized, cleaned or followed by another child.
    // Poll it directly instead of downloading/rechecking the entire source set
    // every ten seconds. Terminal/unknown outcomes still take the full verified
    // path below, including contract, checksum, lease and shared-job checks.
    const existing = (
      await this.repo.pool.query(
        `SELECT * FROM ${this.t("source_extractions")} WHERE preparation_id=$1`,
        [job.id],
      )
    ).rows;
    const rowsByWorkflow = new Map(existing.map((row) => [row.workflow, row]));
    const active = existing.filter(
      (row) => row.status === "waiting" && row.execution_arn,
    );
    const workflows = selectedSourceWorkflows(settings);
    const firstPending = workflows.findIndex(
      (workflow) => rowsByWorkflow.get(workflow)?.status !== "completed",
    );
    const wave =
      parallel && firstPending >= 0
        ? workflows.slice(firstPending, firstPending + parallelism)
        : workflows;
    let stopDispatch =
      parallel && existing.some((row) => row.status === "failed");
    let deferredFailure: string | undefined;
    const polled = new Map<
      string,
      Awaited<ReturnType<StepFunctionsRunner["describeExecution"]>>
    >();
    if (active.length > 1 && !parallel)
      throw Error(
        "Multiple active serial extractions require reconciliation; retain the shared-input lock.",
      );
    for (const row of active) {
      if (
        selectedSourceWorkflows(settings).includes(row.workflow) &&
        row.context?.executionArn === row.execution_arn &&
        isDeepStrictEqual(row.execution_input, {
          env_prefix: settings.envPrefix,
        })
      ) {
        progress("poll_step_function", {
          workflow: row.workflow,
          stateMachine: machine(row.workflow as SourceWorkflow),
          extractionId: row.id,
          executionArn: row.execution_arn,
          workflowElapsedMs: Math.max(
            0,
            Date.now() - new Date(row.created_at).getTime(),
          ),
        });
        const execution = await this.runner.describeExecution(
          row.execution_arn,
        );
        polled.set(row.execution_arn, execution);
        progress("step_function_status", { executionStatus: execution.status });
        if (
          !parallel &&
          ["RUNNING", "PENDING_REDRIVE"].includes(execution.status)
        ) {
          await owns();
          return undefined;
        }
        if (
          parallel &&
          ["FAILED", "ABORTED", "TIMED_OUT"].includes(execution.status)
        )
          stopDispatch = true;
        if (
          parallel &&
          ![
            "RUNNING",
            "PENDING_REDRIVE",
            "SUCCEEDED",
            "FAILED",
            "ABORTED",
            "TIMED_OUT",
          ].includes(execution.status)
        )
          throw Error(
            "Unknown source execution state; retain the preparation lock.",
          );
      }
    }
    const unknownStart = existing.some(
      (row) =>
        wave.includes(row.workflow) &&
        row.context?.staged &&
        !row.context.cleaned &&
        !row.execution_arn,
    );
    const waveDispatched = wave.every((workflow) => {
      const row = rowsByWorkflow.get(workflow);
      return (
        row?.execution_arn ||
        row?.status === "failed" ||
        (stopDispatch && !row?.context?.staged)
      );
    });
    const barrierReady =
      parallel &&
      !unknownStart &&
      waveDispatched &&
      active.every((row) =>
        ["SUCCEEDED", "FAILED", "ABORTED", "TIMED_OUT"].includes(
          polled.get(row.execution_arn)?.status ?? "",
        ),
      );
    if (parallel && waveDispatched && !unknownStart && !barrierReady) {
      progress("wait_extraction_wave", {
        parallelism,
        workflows: wave,
        activeWorkflows: active.map((row) => row.workflow),
      });
      await owns();
      return undefined;
    }
    const definitions = new Map<
      SourceWorkflow,
      Awaited<ReturnType<StepFunctionsRunner["describeStateMachineDefinition"]>>
    >();
    // Read-only inspection, never an AWS deployment. Fail before any shared copy
    // or execution if an unchanged workflow has a known incompatible contract.
    try {
      await this.inspector.verifyIsolation!(settings.resources);
      await boundedRead(workflows, async (workflow) => {
        progress("verify_workflow", {
          workflow,
          stateMachine: machine(workflow),
        });
        const definition = await this.runner.describeStateMachineDefinition(
          machine(workflow),
        );
        if (definition.type !== "STANDARD" || definition.status !== "ACTIVE")
          throw Error(`Source workflow is not active Standard: ${workflow}`);
        validateLegacySourceDefinition(
          workflow,
          definition.definition,
          settings.envPrefix,
          settings.resources,
        );
        await this.inspector.verify(
          workflow,
          settings.envPrefix,
          this.storage.bucket,
          true,
          settings.resources,
        );
        definitions.set(workflow, definition);
      });
    } catch (e) {
      // Service/network/permission failures remain retryable; only contract
      // validation is definitive. No shared objects or AWS runs were created.
      if ((e as any).$metadata || (e as any).code) throw e;
      throw Object.assign(
        new PrepaidSourceExtractionError((e as Error).message),
        {
          details: (e as any).details,
        },
      );
    }
    const machines = [...definitions.values()].map((d) => d.arn);
    const cohort = () => ({
      executions: Object.fromEntries(
        [...rowsByWorkflow.entries()]
          .filter(
            ([, row]) =>
              row.context?.staged &&
              !row.context.cleaned &&
              row.context?.executionArn,
          )
          .map(([workflow, row]) => [workflow, row.context.executionArn]),
      ) as Partial<Record<SourceWorkflow, string>>,
      allowOwnedGlue: true,
    });
    const revision = await this.normalizer.revision();
    // The two verification passes share only this tick's verified KE24 period.
    // No cross-session or cross-restart cache can hide a changed artifact.
    const verifiedPeriods = new Map<string, string>();
    // Validate/cache the ENTIRE source set before any shared input or native
    // execution is touched. A valid KE24 must not spend a Glue run only to
    // discover an incompatible EG workbook in the following workflow.
    for (const validateOnly of [true, false]) {
      const receipts: Summary[] = [];
      let accountingPeriod: string | undefined;
      const discoverPeriod = async (artifacts: Receipt["artifacts"]) => {
        const identity = JSON.stringify(artifacts);
        const cached = verifiedPeriods.get(identity);
        if (cached) {
          accountingPeriod = cached;
          return;
        }
        const periods = new Set<string>();
        for (const artifact of artifacts)
          for await (const value of this.storage.rows(
            artifact.key,
            this.storage.sessionPrefix(session.id),
            artifact.sha256,
            artifact.rowCount,
          ))
            periods.add(periodSchema.parse((value as any).period));
        if (periods.size !== 1)
          throw new PrepaidSourceExtractionError(
            "KE24 must identify exactly one accounting period.",
          );
        accountingPeriod = [...periods][0];
        verifiedPeriods.set(identity, accountingPeriod);
      };
      const recordReceipt = async (receipt: Summary) => {
        receipts.push(receipt);
        if (receipt.workflow === "ke24")
          await discoverPeriod(receipt.artifacts);
      };
      for (const workflow of workflows) {
        if (lost()) throw Error("Source extraction preparation lease lost.");
        const sources = job.source_files
          .filter((f: any) => sourceBelongsTo(workflow, f.source_code))
          .map((f: any) => ({
            id: f.id,
            code: f.source_code,
            key: f.object_key,
            sha256: f.sha256,
          }))
          .sort((a: any, b: any) => a.code.localeCompare(b.code));
        if (!sources.length)
          throw new PrepaidSourceExtractionError(
            `Missing source files for ${workflow}.`,
          );
        if (
          new Set(sources.map((s: any) => s.id)).size !== sources.length ||
          new Set(sources.map((s: any) => s.code)).size !== sources.length ||
          (!["adjustments_308", "charges_318"].includes(workflow) &&
            sources.length !== 1)
        )
          throw new PrepaidSourceExtractionError(
            "Duplicate source identities for extraction.",
          );
        for (const source of sources)
          this.storage.assertKey(
            source.key,
            `${this.storage.sessionPrefix(session.id)}sources/${source.id}/`,
          );
        const id = randomUUID(),
          executionName = `prepaid-source-${id}`;
        const outputPrefix = `${this.storage.sessionPrefix(session.id)}preparation/${job.id}/extractions/${workflow}/`;
        const identity = {
          contractVersion: 1 as const,
          workflow,
          sessionId: session.id,
          workspaceId: session.workspace_id,
          preparationId: job.id,
          sourceVersion: job.source_version,
          producer: "backend" as const,
          financialSource: glueFinancialSource,
          normalizerRevision: revision,
          ...(settings.egReportMapping
            ? { egReportMapping: settings.egReportMapping }
            : {}),
          ...(accountingPeriod ? { accountingPeriod } : {}),
          sources,
        };
        let row = rowsByWorkflow.get(workflow);
        if (!row) {
          await this.repo.pool.query(
            `INSERT INTO ${this.t("source_extractions")}(id,preparation_id,workflow,execution_name,execution_input)
         SELECT $1,$2,$3,$4,$5 WHERE EXISTS(SELECT 1 FROM ${this.t("preparation_jobs")} WHERE id=$2 AND lease_token=$6 AND status='running')
         ON CONFLICT(preparation_id,workflow) DO NOTHING`,
            [
              id,
              job.id,
              workflow,
              executionName,
              JSON.stringify({ env_prefix: settings.envPrefix }),
              token,
            ],
          );
          row = (
            await this.repo.pool.query(
              `SELECT * FROM ${this.t("source_extractions")} WHERE preparation_id=$1 AND workflow=$2`,
              [job.id, workflow],
            )
          ).rows[0];
          if (row) rowsByWorkflow.set(workflow, row);
        }
        progress("restore_extraction", {
          workflow,
          extractionId: row?.id,
          stateMachine: machine(workflow),
          executionArn: row?.execution_arn ?? null,
          sourceCodes: sources.map((source: any) => source.code),
        });
        if (
          !row ||
          !isDeepStrictEqual(row.execution_input, {
            env_prefix: settings.envPrefix,
          })
        )
          throw new PrepaidSourceExtractionError(
            "Historical portal-branch request cannot be dispatched through the unchanged workflows. Reconcile the old execution before creating a new preparation.",
          );
        if (
          row.status === "failed" &&
          parallel &&
          row.context?.staged &&
          row.context?.cleaned
        ) {
          deferredFailure = row.error ?? "Source extraction failed.";
          continue;
        }
        if (row.status === "failed")
          throw new PrepaidSourceExtractionError(
            row.error ?? "Source extraction failed.",
          );
        const expectedArn = `${definitions.get(workflow)!.arn.replace(":stateMachine:", ":execution:")}:${row.execution_name}`;
        if (row.execution_arn && row.execution_arn !== expectedArn)
          throw new PrepaidSourceExtractionError(
            "Saved child execution identity differs from its named request.",
          );
        const receiptKey = `${outputPrefix}receipt.json`;
        if (!row.context) {
          progress("normalize_sources");
          try {
            const artifacts: Receipt["artifacts"] = [];
            const nativeInputs: NonNullable<Receipt["nativeInputs"]> = [];
            for (const source of sources) {
              const bytes = await this.storage.bytes(
                source.key,
                `${this.storage.sessionPrefix(session.id)}sources/${source.id}/`,
                prepaidMaximumSourceBytes,
              );
              if (sha256(bytes) !== source.sha256)
                throw Error("Uploaded source checksum mismatch.");
              const prepared = this.normalizer.prepare
                ? await this.normalizer.prepare(
                    workflow,
                    source.code,
                    bytes,
                    accountingPeriod,
                    settings.egReportMapping,
                  )
                : {
                    datasets: await this.normalizer.normalize(
                      workflow,
                      source.code,
                      bytes,
                      accountingPeriod,
                      settings.egReportMapping,
                    ),
                  };
              const fragments = prepared.datasets;
              if ("landing" in prepared && prepared.landing) {
                if (
                  !settings.egReportMapping ||
                  !["callcard_eg", "load_up_eg"].includes(workflow)
                )
                  throw Error("Unexpected native input adaptation.");
                const check = await this.normalizer.normalize(
                  workflow,
                  source.code,
                  prepared.landing,
                  accountingPeriod,
                );
                if (!isDeepStrictEqual(check, fragments))
                  throw Error(
                    "Adapted native input changes source calculations.",
                  );
                const key = `${outputPrefix}${source.id}/native-input.xlsx`;
                await owns();
                const saved = await this.storage.putVerified(
                  key,
                  outputPrefix,
                  prepared.landing,
                  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                );
                nativeInputs.push({
                  sourceId: source.id,
                  sourceCode: source.code,
                  key,
                  sha256: saved.sha256,
                  size: saved.size,
                });
              }
              const expectedNames = [...sourceWorkflows[workflow].artifacts];
              if (
                !isDeepStrictEqual(
                  Object.keys(fragments).sort(),
                  expectedNames.sort(),
                )
              )
                throw Error("Backend normalizer returned unexpected datasets.");
              for (const [name, values] of Object.entries(fragments)) {
                const artifactName =
                  name as Receipt["artifacts"][number]["name"];
                validateNormalizedFragment(
                  workflow,
                  source.code,
                  artifactName,
                  values,
                );
                const body = Buffer.from(
                  values.map((v) => JSON.stringify(v) + "\n").join(""),
                );
                const key = `${outputPrefix}${source.id}/${name}.jsonl`;
                await owns();
                const saved = await this.storage.putVerified(
                  key,
                  outputPrefix,
                  body,
                  "application/x-ndjson",
                );
                artifacts.push({
                  sourceId: source.id,
                  sourceCode: source.code,
                  name: artifactName,
                  key,
                  sha256: saved.sha256,
                  rowCount: values.length,
                });
              }
            }
            row.context = {
              ...identity,
              executionArn: expectedArn,
              outputPrefix,
              receiptKey,
              artifacts,
              ...(nativeInputs.length ? { nativeInputs } : {}),
              staged: false,
              cleaned: false,
              ...(parallel ? { coordinationOwner: job.id } : {}),
            };
            await owns();
            await save(
              `UPDATE ${this.t("source_extractions")} SET context=$2 WHERE id=$1 AND context IS NULL`,
              [row.id, JSON.stringify(row.context)],
            );
          } catch (e) {
            // These operations precede dispatch/landing acquisition. Invalid sources
            // are definitive; storage/runtime outages can be retried safely.
            if ((e as any).$metadata || (e as any).code) throw e;
            await owns();
            await this.fail(row.id, (e as Error).message, job.id, token);
            throw new PrepaidSourceExtractionError((e as Error).message);
          }
        }
        const context = row.context;
        if (context.financialSource !== glueFinancialSource)
          throw new PrepaidSourceExtractionError(
            "This preparation uses the previous calculation pipeline. Finish or reconcile any running extraction, then reset the workspace and upload the files for a new preparation. Existing saved layouts are unchanged.",
          );
        const landingOwner = parallel ? job.id : row.id;
        if (context.coordinationOwner !== (parallel ? job.id : undefined))
          throw new PrepaidSourceExtractionError(
            "Extraction coordination mode changed. Reconcile the original preparation before changing parallelism.",
          );
        const nativeInputs =
          extractionReceiptSchema.shape.nativeInputs.parse(
            context.nativeInputs,
          ) ?? [];
        if (
          new Set(nativeInputs.map((input) => input.sourceId)).size !==
            nativeInputs.length ||
          nativeInputs.some(
            (input) =>
              !settings.egReportMapping ||
              !sources.some(
                (source: any) =>
                  source.id === input.sourceId &&
                  source.code === input.sourceCode,
              ) ||
              input.key !==
                `${outputPrefix}${input.sourceId}/native-input.xlsx`,
          )
        )
          throw new PrepaidSourceExtractionError(
            "Adapted native source identity mismatch.",
          );
        const copyNames = sources.map((source: any) => ({
          name: sourceLandingName(workflow, source.code),
          sha256:
            nativeInputs.find((input) => input.sourceId === source.id)
              ?.sha256 ?? source.sha256,
        }));
        for (const [field, value] of Object.entries(identity))
          if (!isDeepStrictEqual(context[field], value))
            throw new PrepaidSourceExtractionError(
              `Backend source context changed: ${field}. Create a new preparation after reconciliation.`,
            );
        if (
          context.executionArn !== expectedArn ||
          context.receiptKey !== receiptKey ||
          context.outputPrefix !== outputPrefix
        )
          throw new PrepaidSourceExtractionError(
            "Backend extraction output identity mismatch.",
          );
        if (validateOnly) {
          if (workflow === "ke24") await discoverPeriod(context.artifacts);
          progress("source_preflight_validated");
          continue;
        }
        const cleanup = async () => {
          if (context.cleaned) return;
          progress("cleanup_shared_inputs");
          await owns();
          await idle(
            machines,
            settings.envPrefix,
            expectedArn,
            parallel ? { ...cohort(), allowOwnedGlue: false } : undefined,
          );
          await this.landing.acquire(landingOwner);
          await this.landing.finish(
            landingOwner,
            workflow,
            copyNames,
            !parallel,
          );
          // A crash after lock release is safe to recover: acquire/finish are
          // idempotent, and never delete objects owned by a different extraction.
          await save(
            `UPDATE ${this.t("source_extractions")} SET context=jsonb_set(context,'{cleaned}','true') WHERE id=$1`,
            [row.id],
          );
          context.cleaned = true;
        };
        if (row.status === "completed") {
          const receipt = extractionReceiptSchema.parse(row.receipt);
          if (
            !isDeepStrictEqual(receipt.artifacts, context.rawArtifacts) ||
            !isDeepStrictEqual(receipt.rawCapture, context.rawCapture) ||
            !isDeepStrictEqual(receipt.nativeInputs ?? [], nativeInputs) ||
            receipt.producer !== "backend" ||
            receipt.executionArn !== expectedArn
          )
            throw new PrepaidSourceExtractionError(
              "Saved backend receipt differs from its immutable source context.",
            );
          for (const [field, value] of Object.entries(identity))
            if (!isDeepStrictEqual((receipt as any)[field], value))
              throw new PrepaidSourceExtractionError(
                "Saved backend receipt identity mismatch.",
              );
          await cleanup();
          await recordReceipt({
            workflow,
            executionArn: expectedArn,
            receiptKey,
            artifacts: receipt.artifacts,
          });
          continue;
        }
        if (
          parallel &&
          (!wave.includes(workflow) ||
            (row.execution_arn && !barrierReady) ||
            (stopDispatch && !row.execution_arn && !context.staged))
        )
          continue;
        if (!row.execution_arn) {
          await owns();
          if (
            ![...rowsByWorkflow.values()].some(
              (saved) => saved.execution_arn || saved.context?.stagingStarted,
            )
          ) {
            progress("verify_glue_raw_database_access");
            try {
              await this.rawReader.verifyAccess?.(settings);
            } catch (error) {
              throw new Error(
                "Cannot read the extraction database. Check the worker's access to the Glue connection, its credentials and raw tables. No new extraction has started.",
                { cause: error },
              );
            }
          }
          progress("acquire_shared_inputs");
          try {
            await this.landing.acquire(landingOwner);
            if (!context.staged) {
              progress("check_shared_jobs_idle");
              await idle(
                machines,
                settings.envPrefix,
                expectedArn,
                parallel ? cohort() : undefined,
              );
              const files = [];
              for (const [index, source] of sources.entries()) {
                const bytes = await this.storage.bytes(
                  source.key,
                  `${this.storage.sessionPrefix(session.id)}sources/${source.id}/`,
                  prepaidMaximumSourceBytes,
                );
                if (sha256(bytes) !== source.sha256)
                  throw new PrepaidSourceExtractionError(
                    "Uploaded source checksum mismatch before dispatch.",
                  );
                const adapted = nativeInputs.find(
                  (input) => input.sourceId === source.id,
                );
                if (adapted) {
                  const native = await this.storage.bytes(
                    adapted.key,
                    outputPrefix,
                    prepaidMaximumSourceBytes,
                  );
                  if (
                    sha256(native) !== adapted.sha256 ||
                    native.length !== adapted.size
                  )
                    throw new PrepaidSourceExtractionError(
                      "Adapted native input checksum mismatch.",
                    );
                  files.push({
                    ...copyNames[index],
                    bytes: native,
                    original: { bytes, sha256: source.sha256 },
                  });
                } else files.push({ ...copyNames[index], bytes });
              }
              await owns();
              progress("stage_shared_inputs", {
                inputNames: copyNames.map((file: any) => file.name),
              });
              if (!context.stagingStarted) {
                // Persist intent BEFORE the first S3 file mutation. A partial or
                // acknowledged-but-lost stage must keep the landing lock, while
                // staged=false still permits idempotent completion on retry.
                await save(
                  `UPDATE ${this.t("source_extractions")} SET context=jsonb_set(context,'{stagingStarted}','true') WHERE id=$1`,
                  [row.id],
                );
                context.stagingStarted = true;
              }
              await this.landing.stage(landingOwner, workflow, files);
              await save(
                `UPDATE ${this.t("source_extractions")} SET context=jsonb_set(context,'{staged}','true') WHERE id=$1`,
                [row.id],
              );
              context.staged = true;
            }
          } catch (error) {
            // A staged or partially staged workflow owns shared files until cleanup.
            if (
              !parallel &&
              !context.staged &&
              !context.stagingStarted &&
              this.landing.release
            ) {
              try {
                await owns();
                await this.landing.release(landingOwner, true);
              } catch (cleanupError) {
                throw new AggregateError(
                  [error, cleanupError],
                  "Could not release Prepaid landing lock after pre-dispatch failure.",
                );
              }
            }
            throw error;
          }
          await owns();
          progress("start_step_function", {
            executionName: row.execution_name,
          });
          // Only the original native input goes to AWS. No portal validation,
          // receipt parameters, script overrides or portal state names.
          const started = await this.runner.startExecution(
            machine(workflow),
            row.execution_input,
            row.execution_name,
          );
          if (started.executionArn !== expectedArn)
            throw Error(
              "Named source execution ARN differs from the persisted request; retain the coordination lock for reconciliation.",
            );
          await save(
            `UPDATE ${this.t("source_extractions")} SET execution_arn=$2,status='waiting' WHERE id=$1 AND status='queued'`,
            [row.id, started.executionArn],
          );
          row.execution_arn = started.executionArn;
          row.status = "waiting";
          progress("step_function_started", {
            executionArn: started.executionArn,
          });
          if (parallel) continue;
          return undefined;
        }
        progress("poll_step_function");
        const execution =
          polled.get(row.execution_arn) ??
          (await this.runner.describeExecution(row.execution_arn));
        progress("step_function_status", { executionStatus: execution.status });
        if (
          execution.status === "RUNNING" ||
          execution.status === "PENDING_REDRIVE"
        )
          return undefined;
        if (
          !["SUCCEEDED", "FAILED", "ABORTED", "TIMED_OUT"].includes(
            execution.status,
          )
        )
          throw Error(
            "Unknown source execution state; retain the shared-input lock.",
          );
        let failure: string | undefined;
        try {
          if (execution.status !== "SUCCEEDED")
            throw Error(
              `Source workflow failed: ${workflow}. ${execution.errorCode ?? execution.status}`,
            );
          if (
            execution.inputIncluded === false ||
            execution.outputIncluded === false ||
            !execution.input ||
            !execution.output ||
            !isDeepStrictEqual(JSON.parse(execution.input), row.execution_input)
          )
            throw Error(
              "Source workflow execution input/output is unavailable or differs from the named request.",
            );
          const output = JSON.parse(execution.output);
          const jobs = sourceWorkflows[workflow].jobs;
          if (
            output.JobRunState !== "SUCCEEDED" ||
            typeof output.Id !== "string" ||
            !output.Id ||
            output.JobName !==
              sourceGlueJobName(
                jobs[jobs.length - 1],
                settings.envPrefix,
                settings.resources,
              )
          )
            throw Error(
              "Source workflow did not return the expected native Glue success metadata.",
            );
          // Original parsing is preflight/adaptation only. It is never the final
          // financial source; the verified Glue database capture below is.
          for (const artifact of context.artifacts as Receipt["artifacts"]) {
            for await (const value of this.storage.rows(
              artifact.key,
              outputPrefix,
              artifact.sha256,
              artifact.rowCount,
            ))
              validateSourceFragment(
                workflow,
                artifact.sourceCode,
                artifact.name,
                value,
              );
          }
        } catch (e) {
          failure = (e as Error).message;
        }
        if (!failure && !context.rawArtifacts) {
          await owns();
          await idle(
            machines,
            settings.envPrefix,
            expectedArn,
            parallel ? cohort() : undefined,
          );
          progress("capture_glue_raw_output");
          // Keep the lock on capture/storage failure. A retry resumes the same
          // execution or its immutable capture, never a later shared table state.
          try {
            const captured = await snapshotGlueSources(
              {
                workflow,
                executionArn: expectedArn,
                envPrefix: settings.envPrefix,
                resources: settings.resources,
                bucket: this.storage.bucket,
                sources: sources.map((s: any) => ({ id: s.id, code: s.code })),
              },
              outputPrefix,
              this.storage,
              this.rawReader,
              this.normalizer,
              owns,
              accountingPeriod,
            );
            context.rawArtifacts = captured.artifacts;
            context.rawCapture = captured.rawCapture;
            await owns();
            await save(
              `UPDATE ${this.t("source_extractions")} SET context=$2 WHERE id=$1`,
              [row.id, JSON.stringify(context)],
            );
            progress("glue_raw_output_captured", {
              connectionName: captured.connectionName,
              rawRowCount: captured.rawRowCount,
              nativeJobRuns: captured.nativeJobRuns,
              rowCount: captured.artifacts.reduce((n, a) => n + a.rowCount, 0),
            });
          } catch (error) {
            if (!(error instanceof GlueRawSourceValidationError)) throw error;
            failure = error.message;
          }
        }
        // Even a failed SFN may leave a Glue cancellation in flight. Do not clean,
        // release or mark a definitive failure until all twelve Glue jobs are idle.
        await cleanup();
        if (failure) {
          await owns();
          await this.fail(row.id, failure, job.id, token);
          if (parallel) {
            row.status = "failed";
            deferredFailure = failure;
            continue;
          }
          throw new PrepaidSourceExtractionError(failure);
        }
        const receipt = extractionReceiptSchema.parse({
          ...identity,
          executionArn: expectedArn,
          phase: "complete",
          artifacts: context.rawArtifacts,
          rawCapture: context.rawCapture,
          ...(nativeInputs.length ? { nativeInputs } : {}),
        });
        await owns();
        await this.storage.putVerified(
          receiptKey,
          outputPrefix,
          Buffer.from(JSON.stringify(receipt)),
          "application/json",
        );
        await save(
          `UPDATE ${this.t("source_extractions")} SET status='completed',receipt=$2,completed_at=now() WHERE id=$1`,
          [row.id, JSON.stringify(receipt)],
        );
        row.status = "completed";
        row.receipt = receipt;
        await recordReceipt({
          workflow,
          executionArn: expectedArn,
          receiptKey,
          artifacts: receipt.artifacts,
        });
        progress("extraction_completed");
      }
      if (!validateOnly) {
        if (
          parallel &&
          (deferredFailure || receipts.length === workflows.length)
        ) {
          await owns();
          await idle(machines, settings.envPrefix);
          await this.landing.release!(job.id);
        }
        if (deferredFailure)
          throw new PrepaidSourceExtractionError(deferredFailure);
        if (parallel && receipts.length !== workflows.length) return undefined;
        return receipts;
      }
    }
  }
  private async fail(
    id: string,
    message: string,
    preparationId: string,
    token: string,
  ) {
    await this.repo.pool.query(
      `UPDATE ${this.t("source_extractions")} SET status='failed',error=$2,completed_at=now() WHERE id=$1 AND EXISTS(SELECT 1 FROM ${this.t("preparation_jobs")} WHERE id=$3 AND lease_token=$4 AND status='running')`,
      [id, message, preparationId, token],
    );
  }
}
