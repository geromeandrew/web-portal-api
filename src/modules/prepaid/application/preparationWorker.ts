import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  datasetSchemas,
  manualIntegrationSchema,
  sessionManifestSchema,
} from "../domain/contracts.js";
import { PrepaidRepository } from "../infrastructure/repository.js";
import { PrepaidStorage } from "../infrastructure/prepaidStorage.js";
import type { StepFunctionsRunner } from "../../../stepFunctionsRunner.js";
import type { Logger } from "../../../platform/logger.js";
import {
  PrepaidSourceExtractionError,
  PrepaidSourceExtractionWorker,
} from "./sourceExtractionWorker.js";

import { PrepaidNativeManifestBuilder } from "./nativeManifestBuilder.js";
import { verifiedExtractionBridge } from "./sourceExtractionBridge.js";

/** Version 2 normalization discovers the period; it never dispatches SAP. */
export class PrepaidPreparationWorker {
  private sourceWorker?: PrepaidSourceExtractionWorker;
  constructor(
    readonly repo: PrepaidRepository,
    readonly storage: PrepaidStorage,
    readonly runner: StepFunctionsRunner,
    readonly logger: Logger,
  ) {}
  private t = (name: string) => this.repo.table(name);
  async tick(): Promise<boolean> {
    const token = randomUUID();
    const job = (
      await this.repo.pool.query(
        `WITH candidate AS (SELECT id FROM ${this.t("preparation_jobs")} WHERE status IN('queued','running','waiting') AND available_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
       UPDATE ${this.t("preparation_jobs")} j SET lease_token=$1,lease_until=now()+interval '60 seconds',status='running' FROM candidate c WHERE j.id=c.id RETURNING j.*`,
        [token],
      )
    ).rows[0];
    if (!job) return false;
    let lost = false,
      knownOutcome = false;
    const heartbeat = setInterval(() => {
      void this.repo.pool
        .query(
          `UPDATE ${this.t("preparation_jobs")} SET lease_until=now()+interval '60 seconds' WHERE id=$1 AND lease_token=$2 AND status='running'`,
          [job.id, token],
        )
        .then((r) => {
          if (!r.rowCount) lost = true;
        })
        .catch(() => {
          lost = true;
        });
    }, 15000);
    try {
      const session = (
        await this.repo.pool.query(
          `SELECT * FROM ${this.t("upload_sessions")} WHERE id=$1`,
          [job.session_id],
        )
      ).rows[0];
      if (
        !session?.active ||
        session.status !== "pending" ||
        session.version !== job.source_version
      ) {
        knownOutcome = true;
        throw Error("Upload session changed before preparation.");
      }
      const config = manualIntegrationSchema.parse(session.configuration);
      const prefix = `${this.storage.sessionPrefix(session.id)}preparation/${job.id}/`;
      const native = config.preparationMode === "native_sources";
      let extractionReceipts = job.execution_input?.extractionReceipts;
      const owns = async () => {
        const result = await this.repo.pool.query(
          `SELECT 1 FROM ${this.t("preparation_jobs")} WHERE id=$1 AND lease_token=$2 AND status='running'`,
          [job.id, token],
        );
        if (!result.rowCount || lost) throw Error("Preparation lease lost.");
      };
      if (
        config.sourceExtraction &&
        !job.execution_arn &&
        !(native && job.execution_input?.manifestKey)
      ) {
        // Child inputs are persisted separately, so a lost dispatch response is
        // recoverable even before the final V2 ingestion request exists.
        job.source_extraction_pending = true;
        extractionReceipts = await (this.sourceWorker ??=
          new PrepaidSourceExtractionWorker(
            this.repo,
            this.storage,
            this.runner,
          )).advance(job, session, config.sourceExtraction, token, () => lost);
        if (!extractionReceipts) {
          await this.repo.pool.query(
            `UPDATE ${this.t("preparation_jobs")} SET status='waiting',lease_until=NULL,available_at=now()+interval '10 seconds' WHERE id=$1 AND lease_token=$2 AND status='running'`,
            [job.id, token],
          );
          return true;
        }
      }
      let manifest: ReturnType<typeof sessionManifestSchema.parse>;
      if (native) {
        if (!job.execution_input) {
          job.execution_input = {
            contractVersion: 2,
            preparationMode: "native_sources",
            sessionId: session.id,
            workspaceId: session.workspace_id,
            preparationId: job.id,
            sourceVersion: job.source_version,
            sources: job.source_files.map((f: any) => ({
              id: f.id,
              code: f.source_code,
              key: f.object_key,
              sha256: f.sha256,
            })),
            extractionReceipts,
            manifestKey: `${prefix}native-manifest.json`,
          };
          await owns();
          const saved = await this.repo.pool.query(
            `UPDATE ${this.t("preparation_jobs")} SET execution_input=$3 WHERE id=$1 AND lease_token=$2 AND status='running'`,
            [job.id, token, JSON.stringify(job.execution_input)],
          );
          if (!saved.rowCount || lost)
            throw Error(
              "Preparation lease lost before native output assembly.",
            );
        }
        let built;
        try {
          built = await new PrepaidNativeManifestBuilder(this.storage).build(
            job,
            session,
            config,
            job.execution_input.extractionReceipts,
            owns,
          );
        } catch (error) {
          if ((error as any).$metadata || (error as any).code) throw error;
          throw new PrepaidSourceExtractionError((error as Error).message);
        }
        manifest = sessionManifestSchema.parse(
          await this.storage.json(built.manifestKey, prefix),
        );
        knownOutcome = true;
        if (
          manifest.producer !== "backend" ||
          manifest.executionArn !== `backend:preparation:${job.id}` ||
          !isDeepStrictEqual(manifest.referenceSource, config.referenceExport)
        )
          throw Error("Native manifest backend/reference identity mismatch.");
      } else {
        if (!job.execution_arn) {
          if (!job.execution_input) {
            const machine = await this.runner.describeStateMachine(
              config.ingestStateMachine!,
            );
            if (machine.type !== "STANDARD" || machine.status !== "ACTIVE") {
              knownOutcome = true;
              throw Error(
                "Preparation requires an active Standard state machine with the version-2 session contract.",
              );
            }
            job.execution_input = {
              contractVersion: 2,
              sessionId: session.id,
              workspaceId: session.workspace_id,
              preparationId: job.id,
              sourceVersion: job.source_version,
              bucket: this.storage.bucket,
              outputPrefix: prefix,
              expectedCycles: config.expectedCycles,
              discoverPeriodFrom: "ke24",
              sources: job.source_files.map((f: any) => ({
                id: f.id,
                code: f.source_code,
                key: f.object_key,
                sha256: f.sha256,
              })),
              ...(extractionReceipts ? { extractionReceipts } : {}),
            };
            const saved = await this.repo.pool.query(
              `UPDATE ${this.t("preparation_jobs")} SET execution_input=$3 WHERE id=$1 AND lease_token=$2 AND status='running'`,
              [job.id, token, JSON.stringify(job.execution_input)],
            );
            if (!saved.rowCount || lost) throw Error("Preparation lease lost.");
          }
          const started = await this.runner.startExecution(
            config.ingestStateMachine!,
            job.execution_input,
            job.execution_name,
          );
          await this.repo.pool.query(
            `UPDATE ${this.t("preparation_jobs")} SET execution_arn=$3,status='waiting',lease_until=NULL,available_at=now()+interval '10 seconds' WHERE id=$1 AND lease_token=$2 AND status='running'`,
            [job.id, token, started.executionArn],
          );
          return true;
        }
        const execution = await this.runner.describeExecution(
          job.execution_arn,
        );
        if (execution.status === "RUNNING") {
          await this.repo.pool.query(
            `UPDATE ${this.t("preparation_jobs")} SET status='waiting',lease_until=NULL,available_at=now()+interval '10 seconds' WHERE id=$1 AND lease_token=$2 AND status='running'`,
            [job.id, token],
          );
          return true;
        }
        knownOutcome = true;
        if (
          !execution.inputIncluded ||
          !execution.input ||
          !isDeepStrictEqual(JSON.parse(execution.input), job.execution_input)
        )
          throw Error(
            "Source preparation execution input does not match the persisted request.",
          );
        if (
          execution.status !== "SUCCEEDED" ||
          !execution.outputIncluded ||
          !execution.output
        )
          throw Error(
            "Source preparation failed or returned no attested output.",
          );
        const output = JSON.parse(execution.output);
        if (
          output.contractVersion !== 2 ||
          typeof output.manifestKey !== "string"
        )
          throw Error(
            "The ingestion adapter must implement the version-2 source-driven period contract.",
          );

        manifest = sessionManifestSchema.parse(
          await this.storage.json(output.manifestKey, prefix),
        );
      }
      if (
        config.sourceExtraction &&
        !isDeepStrictEqual(
          manifest.extractionReceipts,
          job.execution_input.extractionReceipts,
        )
      )
        throw Error(
          "The final ingestion manifest must attest the verified native-source extraction receipts.",
        );
      if (
        manifest.sessionId !== session.id ||
        manifest.workspaceId !== session.workspace_id ||
        manifest.preparationId !== job.id ||
        manifest.sourceVersion !== job.source_version ||
        manifest.executionArn !==
          (native ? `backend:preparation:${job.id}` : job.execution_arn)
      )
        throw Error(
          "Preparation manifest identifies another session or execution.",
        );
      if (
        manifest.sourceFiles.length !== job.source_files.length ||
        new Set(manifest.sourceFiles.map((f) => f.id)).size !==
          manifest.sourceFiles.length ||
        !job.source_files.every((f: any) =>
          manifest.sourceFiles.some(
            (m) => m.id === f.id && m.sha256 === f.sha256,
          ),
        )
      )
        throw Error("Manifest does not attest the exact uploaded sources.");
      if (
        manifest.coverage.length !== config.expectedCycles.length ||
        new Set(manifest.coverage.map((c) => c.cycle)).size !==
          config.expectedCycles.length ||
        !config.expectedCycles.every((c) =>
          manifest.coverage.some((x) => x.cycle === c),
        )
      )
        throw Error("Incomplete or duplicate billing-cycle coverage.");
      const expected = Object.keys(datasetSchemas);
      if (
        manifest.datasets.length !== expected.length ||
        new Set(manifest.datasets.map((d) => d.name)).size !==
          expected.length ||
        !expected.every((n) => manifest.datasets.some((d) => d.name === n))
      )
        throw Error("Missing canonical legacy source datasets.");
      if (
        manifest.datasets.some(
          (d) => ["ke24", "reference"].includes(d.name) && d.rowCount === 0,
        )
      )
        throw Error("KE24 and SAP reference data cannot be empty.");
      const extractionBridge = config.sourceExtraction
        ? await verifiedExtractionBridge(
            this.storage,
            manifest.extractionReceipts!,
            manifest.period,
            prefix,
          )
        : undefined;
      await this.repo.transaction(async (db) => {
        const owner = (
          await db.query(
            `SELECT user_id FROM ${this.repo.schema}.workspaces WHERE id=$1`,
            [session.workspace_id],
          )
        ).rows[0];
        await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `prepaid.workspace.${owner.user_id}`,
        ]);
        const current = (
          await db.query(
            `SELECT * FROM ${this.t("upload_sessions")} WHERE id=$1 FOR UPDATE`,
            [session.id],
          )
        ).rows[0];
        if (
          lost ||
          !current.active ||
          current.version !== job.source_version ||
          current.status !== "pending"
        )
          throw Error("Preparation context or lease changed.");
        let run = (
          await db.query(
            `SELECT * FROM ${this.t("runs")} WHERE workspace_id=$1 AND period=$2 FOR UPDATE`,
            [session.workspace_id, manifest.period],
          )
        ).rows[0];
        if (!run)
          run = (
            await db.query(
              `INSERT INTO ${this.t("runs")}(id,workspace_id,period,created_by,configuration) VALUES($1,$2,$3,$4,$5) RETURNING *`,
              [
                randomUUID(),
                session.workspace_id,
                manifest.period,
                owner.user_id,
                JSON.stringify(config),
              ],
            )
          ).rows[0];
        const claimed = await db.query(
          `SELECT 1 FROM ${this.t("preparation_jobs")} WHERE id=$1 AND lease_token=$2 AND status='running' FOR UPDATE`,
          [job.id, token],
        );
        if (!claimed.rowCount || lost)
          throw Error("Preparation lease changed.");
        if (
          (
            await db.query(
              `SELECT 1 FROM ${this.t("source_snapshots")} WHERE run_id=$1 AND status='pending'`,
              [run.id],
            )
          ).rowCount
        )
          throw Error(
            "An existing ingestion attempt is still running for this period.",
          );
        if (current.run_id && current.run_id !== run.id)
          throw Error(
            "Reset the workspace before changing its accounting period.",
          );
        const snapshotId = randomUUID();
        await db.query(
          `UPDATE ${this.t("source_files")} SET active=false WHERE run_id=$1 AND active`,
          [run.id],
        );
        await db.query(
          `UPDATE ${this.t("upstream_sources")} SET active=false WHERE run_id=$1 AND active`,
          [run.id],
        );
        for (const f of job.source_files)
          await db.query(
            `INSERT INTO ${this.t("source_files")}(id,run_id,source_code,original_name,object_key,sha256,size_bytes,uploaded_by,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO UPDATE SET active=true WHERE ${this.t("source_files")}.run_id=excluded.run_id AND ${this.t("source_files")}.object_key=excluded.object_key`,
            [
              f.id,
              run.id,
              f.source_code,
              f.original_name,
              f.object_key,
              f.sha256,
              f.size_bytes,
              f.uploaded_by,
              f.created_at,
            ],
          );
        await db.query(
          `INSERT INTO ${this.t("source_snapshots")}(id,run_id,status,source_files,configuration) VALUES($1,$2,'pending',$3,$4)`,
          [
            snapshotId,
            run.id,
            JSON.stringify(job.source_files),
            JSON.stringify(config),
          ],
        );
        await db.query(
          `INSERT INTO ${this.t("snapshot_context")}(snapshot_id,session_id,source_version) VALUES($1,$2,$3)`,
          [snapshotId, session.id, job.source_version],
        );
        const periods = new Set<string>();
        let sgMaximum = 0;
        for (const descriptor of manifest.datasets) {
          let number = 0;
          const batch: { n: number; data: unknown }[] = [];
          const flush = async () => {
            if (!batch.length) return;
            await db.query(
              `INSERT INTO ${this.t(`stage_${descriptor.name}`)}(snapshot_id,row_number,data) SELECT $1,(v->>'n')::bigint,v->'data' FROM jsonb_array_elements($2::jsonb) v`,
              [snapshotId, JSON.stringify(batch)],
            );
            batch.length = 0;
          };
          for await (const value of this.storage.rows(
            descriptor.key,
            prefix,
            descriptor.sha256,
            descriptor.rowCount,
          )) {
            const data = datasetSchemas[descriptor.name].parse(value);
            if (descriptor.name === "ke24") periods.add(data.period);
            if (data.period !== manifest.period)
              throw Error(
                `Dataset ${descriptor.name} disagrees with the KE24 period.`,
              );
            extractionBridge?.match(descriptor.name, data);
            if (descriptor.name === "callcard") {
              const card = datasetSchemas.callcard.parse(value);
              if (card.region === "sg") {
                sgMaximum = Math.max(sgMaximum, card.month_no);
                if (card.month_no !== Number(manifest.period.slice(5)))
                  continue;
              } else if (card.month_no !== Number(manifest.period.slice(5)))
                throw Error("Call Card month disagrees with KE24.");
            }
            if (
              (descriptor.name === "adjustments" ||
                descriptor.name === "charges") &&
              "cycle" in data &&
              !config.expectedCycles.includes(data.cycle)
            )
              throw Error(
                "A billing cycle is outside the configured coverage.",
              );
            batch.push({ n: ++number, data });
            if (batch.length >= 500) await flush();
            if (lost) throw Error("Preparation lease lost.");
          }
          await flush();
        }
        extractionBridge?.assertComplete();
        if (periods.size !== 1 || !periods.has(manifest.period))
          throw Error("KE24 must contain exactly one accounting period.");
        if (sgMaximum && sgMaximum !== Number(manifest.period.slice(5)))
          throw Error("The latest SG Call Card month disagrees with KE24.");
        await db.query(
          `UPDATE ${this.t("source_snapshots")} SET status='ready',manifest=$2,completed_at=now() WHERE id=$1`,
          [snapshotId, JSON.stringify(manifest)],
        );
        for (const region of ["eg", "sg"]) {
          let revision = (
            await db.query(
              `SELECT * FROM ${this.t("region_revisions")} WHERE run_id=$1 AND region=$2 ORDER BY revision DESC LIMIT 1 FOR UPDATE`,
              [run.id, region],
            )
          ).rows[0];
          if (!revision || revision.status !== "draft") {
            const old = revision;
            revision = (
              await db.query(
                `INSERT INTO ${this.t("region_revisions")}(id,run_id,region,revision,status,predecessor_id) VALUES($1,$2,$3,$4,'draft',$5) RETURNING *`,
                [
                  randomUUID(),
                  run.id,
                  region,
                  (old?.revision ?? 0) + 1,
                  old?.id ?? null,
                ],
              )
            ).rows[0];
            await db.query(
              `SELECT ${this.repo.schema}.prepaid_initialize_layout($1)`,
              [revision.id],
            );
          }
          await db.query(
            `SELECT ${this.repo.schema}.prepaid_import_layout($1,$2)`,
            [revision.id, snapshotId],
          );
          await db.query(
            `SELECT ${this.repo.schema}.prepaid_capture_source_totals($1)`,
            [revision.id],
          );
          await db.query(
            `SELECT ${this.repo.schema}.prepaid_build_outputs($1)`,
            [revision.id],
          );
        }
        await db.query(
          `INSERT INTO ${this.t("workspace_selection")}(workspace_id,run_id) VALUES($1,$2) ON CONFLICT(workspace_id) DO UPDATE SET run_id=excluded.run_id`,
          [session.workspace_id, run.id],
        );
        await db.query(
          `UPDATE ${this.t("upload_sessions")} SET status='ready',run_id=$2,error=NULL WHERE id=$1`,
          [session.id, run.id],
        );
        await db.query(
          `UPDATE ${this.t("preparation_jobs")} SET status='completed',lease_until=NULL,error=NULL WHERE id=$1 AND lease_token=$2`,
          [job.id, token],
        );
        await this.repo.event(
          db,
          run.id,
          "workspace.prepared",
          {
            sessionId: session.id,
            snapshotId,
            period: manifest.period,
            preparationId: job.id,
          },
          owner.user_id,
        );
      });
    } catch (e) {
      if (e instanceof PrepaidSourceExtractionError) knownOutcome = true;
      const message =
        e instanceof Error ? e.message : "Source preparation failed.";
      this.logger.error("prepaid.preparation.failed", {
        jobId: job.id,
        message,
      });
      await this.repo.transaction(async (db) => {
        const changed = await db.query(
          `UPDATE ${this.t("preparation_jobs")} SET status=$3,error=$4,lease_until=NULL,available_at=now()+interval '30 seconds' WHERE id=$1 AND lease_token=$2 AND status='running' RETURNING id`,
          [
            job.id,
            token,
            !knownOutcome &&
            (job.execution_input || job.source_extraction_pending)
              ? "waiting"
              : "failed",
            message,
          ],
        );
        if (
          changed.rowCount &&
          ((!job.execution_input && !job.source_extraction_pending) ||
            knownOutcome)
        )
          await db.query(
            `UPDATE ${this.t("upload_sessions")} SET status='failed',error=$2 WHERE id=$1 AND active AND version=$3`,
            [job.session_id, message, job.source_version],
          );
      });
    } finally {
      clearInterval(heartbeat);
    }
    return true;
  }
}
