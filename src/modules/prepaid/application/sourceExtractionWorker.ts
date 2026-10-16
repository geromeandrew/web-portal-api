import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { GlueClient } from "@aws-sdk/client-glue";
import { SFNClient } from "@aws-sdk/client-sfn";
import { loadConfig } from "../../../config.js";
import { createAwsClientOptions } from "../../../aws.js";
import { datasetSchemas } from "../domain/contracts.js";
import {
  extractionReceiptSchema,
  sourceWorkflows,
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
import {
  AwsSourceJobInspector,
  type SourceJobInspector,
} from "../infrastructure/sourceJobInspector.js";

export class PrepaidSourceExtractionError extends Error {}
type Receipt = z.infer<typeof extractionReceiptSchema>;
type Summary = Pick<Receipt, "workflow" | "executionArn" | "artifacts"> & {
  receiptKey: string;
};
export class PrepaidSourceExtractionWorker {
  readonly normalizer: SourceNormalizer;
  readonly landing: SourceLanding;
  readonly inspector: SourceJobInspector;
  constructor(
    readonly repo: PrepaidRepository,
    readonly storage: PrepaidStorage,
    readonly runner: StepFunctionsRunner,
    dependencies?: {
      normalizer: SourceNormalizer;
      landing: SourceLanding;
      inspector: SourceJobInspector;
    },
  ) {
    this.normalizer = dependencies?.normalizer ?? new BackendSourceNormalizer();
    this.landing = dependencies?.landing ?? storage.legacyLanding();
    if (dependencies) this.inspector = dependencies.inspector;
    else {
      const options = createAwsClientOptions(loadConfig());
      this.inspector = new AwsSourceJobInspector(
        new GlueClient(options),
        new SFNClient(options),
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
    if (settings.sharedWritesApproved !== true)
      throw new PrepaidSourceExtractionError(
        "Unchanged Glue jobs write shared legacy raw tables. An operator must explicitly approve that configuration.",
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
    const definitions = new Map<
      SourceWorkflow,
      Awaited<ReturnType<StepFunctionsRunner["describeStateMachineDefinition"]>>
    >();
    // Read-only inspection, never an AWS deployment. Fail before any shared copy
    // or execution if an unchanged workflow has a known incompatible contract.
    try {
      for (const workflow of Object.keys(sourceWorkflows) as SourceWorkflow[]) {
        const definition = await this.runner.describeStateMachineDefinition(
          sourceWorkflows[workflow].machine,
        );
        if (definition.type !== "STANDARD" || definition.status !== "ACTIVE")
          throw Error(`Source workflow is not active Standard: ${workflow}`);
        validateLegacySourceDefinition(
          workflow,
          definition.definition,
          settings.envPrefix,
        );
        await this.inspector.verify(
          workflow,
          settings.envPrefix,
          this.storage.bucket,
        );
        definitions.set(workflow, definition);
      }
    } catch (e) {
      // Service/network/permission failures remain retryable; only contract
      // validation is definitive. No shared objects or AWS runs were created.
      if ((e as any).$metadata || (e as any).code) throw e;
      throw new PrepaidSourceExtractionError((e as Error).message);
    }
    const machines = [...definitions.values()].map((d) => d.arn);
    const revision = await this.normalizer.revision();
    const receipts: Summary[] = [];
    for (const workflow of Object.keys(sourceWorkflows) as SourceWorkflow[]) {
      await owns();
      const sources = job.source_files
        .filter((f: any) =>
          workflow === "adjustments_308"
            ? /^308_\d{2}$/.test(f.source_code)
            : sourceWorkflows[workflow].sources.some(
                (code) => code === f.source_code,
              ),
        )
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
        (workflow !== "adjustments_308" && sources.length !== 1)
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
        normalizerRevision: revision,
        sources,
      };
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
      const row = (
        await this.repo.pool.query(
          `SELECT * FROM ${this.t("source_extractions")} WHERE preparation_id=$1 AND workflow=$2`,
          [job.id, workflow],
        )
      ).rows[0];
      await owns();
      if (
        !row ||
        !isDeepStrictEqual(row.execution_input, {
          env_prefix: settings.envPrefix,
        })
      )
        throw new PrepaidSourceExtractionError(
          "Historical portal-branch request cannot be dispatched through the unchanged workflows. Reconcile the old execution before creating a new preparation.",
        );
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
      const copyNames = sources.map((s: any) => ({
        name:
          workflow === "adjustments_308"
            ? `308. Billed Adjustments Monthly Summary Report_G_BC${s.code.slice(4)}.xlsx`
            : sourceWorkflows[workflow].inputPattern,
        sha256: s.sha256,
      }));
      if (!row.context) {
        try {
          const artifacts: Receipt["artifacts"] = [];
          for (const source of sources) {
            const bytes = await this.storage.bytes(
              source.key,
              `${this.storage.sessionPrefix(session.id)}sources/${source.id}/`,
              4_500_000,
            );
            if (sha256(bytes) !== source.sha256)
              throw Error("Uploaded source checksum mismatch.");
            const fragments = await this.normalizer.normalize(
              workflow,
              source.code,
              bytes,
            );
            const expectedNames =
              workflow === "adjustments_308"
                ? ["adjustment_headers", "adjustments"]
                : [workflow === "callcard_sg" ? "callcard" : "loadapi"];
            if (
              !isDeepStrictEqual(
                Object.keys(fragments).sort(),
                expectedNames.sort(),
              )
            )
              throw Error("Backend normalizer returned unexpected datasets.");
            for (const [name, values] of Object.entries(fragments)) {
              const artifactName = name as Receipt["artifacts"][number]["name"];
              if (
                ((name === "loadapi" || name === "adjustment_headers") &&
                  values.length !== 1) ||
                (name === "callcard" && values.length !== 2)
              )
                throw Error("Unexpected source aggregate/header row count.");
              for (const value of values)
                this.validateFragment(
                  workflow,
                  source.code,
                  artifactName,
                  value,
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
            staged: false,
            cleaned: false,
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
      const cleanup = async () => {
        if (context.cleaned) return;
        await owns();
        await this.inspector.idle(machines, settings.envPrefix, expectedArn);
        await this.landing.acquire(row.id);
        await this.landing.finish(row.id, workflow, copyNames);
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
          !isDeepStrictEqual(receipt.artifacts, context.artifacts) ||
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
        receipts.push({
          workflow,
          executionArn: expectedArn,
          receiptKey,
          artifacts: receipt.artifacts,
        });
        continue;
      }
      if (!row.execution_arn) {
        await owns();
        await this.landing.acquire(row.id);
        if (!context.staged) {
          await this.inspector.idle(machines, settings.envPrefix, expectedArn);
          const files = [];
          for (const [index, source] of sources.entries()) {
            const bytes = await this.storage.bytes(
              source.key,
              `${this.storage.sessionPrefix(session.id)}sources/${source.id}/`,
              4_500_000,
            );
            if (sha256(bytes) !== source.sha256)
              throw new PrepaidSourceExtractionError(
                "Uploaded source checksum mismatch before dispatch.",
              );
            files.push({ ...copyNames[index], bytes });
          }
          await owns();
          await this.landing.stage(row.id, workflow, files);
          await save(
            `UPDATE ${this.t("source_extractions")} SET context=jsonb_set(context,'{staged}','true') WHERE id=$1`,
            [row.id],
          );
        }
        await owns();
        // Only the original native input goes to AWS. No portal validation,
        // receipt parameters, script overrides or portal state names.
        const started = await this.runner.startExecution(
          sourceWorkflows[workflow].machine,
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
        return undefined; // Sequential: no other portal child runs concurrently.
      }
      const execution = await this.runner.describeExecution(row.execution_arn);
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
            `${settings.envPrefix}-prep_reclass-gljo-extract_${jobs[jobs.length - 1]}`
        )
          throw Error(
            "Source workflow did not return the expected native Glue success metadata.",
          );
        // Verify backend artifacts again before attesting completion. The receipt
        // attests normalized ORIGINALS, not unscoped rows in the shared raw DB.
        for (const artifact of context.artifacts as Receipt["artifacts"]) {
          for await (const value of this.storage.rows(
            artifact.key,
            outputPrefix,
            artifact.sha256,
            artifact.rowCount,
          ))
            this.validateFragment(
              workflow,
              artifact.sourceCode,
              artifact.name,
              value,
            );
        }
      } catch (e) {
        failure = (e as Error).message;
      }
      // Even a failed SFN may leave a Glue cancellation in flight. Do not clean,
      // release or mark a definitive failure until all five Glue jobs are idle.
      await cleanup();
      if (failure) {
        await owns();
        await this.fail(row.id, failure, job.id, token);
        throw new PrepaidSourceExtractionError(failure);
      }
      const receipt = extractionReceiptSchema.parse({
        ...identity,
        executionArn: expectedArn,
        phase: "complete",
        artifacts: context.artifacts,
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
      receipts.push({
        workflow,
        executionArn: expectedArn,
        receiptKey,
        artifacts: receipt.artifacts,
      });
    }
    return receipts;
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
  private validateFragment(
    workflow: SourceWorkflow,
    code: string,
    name: Receipt["artifacts"][number]["name"],
    value: unknown,
  ) {
    if (name === "adjustment_headers") {
      const header = z
        .object({
          cycle: z.string().regex(/^\d{2}$/),
          cycleYear: z.string().regex(/^\d{4}$/),
          cycleInstance: z.string().min(1),
        })
        .parse(value);
      if (header.cycle !== code.slice(4))
        throw Error("308 header cycle mismatch.");
    } else {
      const schemas = {
        callcard: datasetSchemas.callcard.omit({ period: true }),
        loadapi: datasetSchemas.loadapi.omit({ period: true }),
        adjustments: datasetSchemas.adjustments.omit({ period: true }),
      };
      const data = schemas[name].parse(value) as any;
      if (
        name === "loadapi" &&
        data.region !== (workflow === "load_api_eg" ? "eg" : "sg")
      )
        throw Error("Load API region mismatch.");
      if (name === "callcard" && data.region !== "sg")
        throw Error("Call Card region mismatch.");
      if (name === "adjustments" && data.cycle !== code.slice(4))
        throw Error("Adjustment cycle mismatch.");
    }
  }
}
