import { randomUUID } from "node:crypto";
import {
  referenceRefreshRequestSchema,
  referenceRefreshJob,
  referenceTerminalStates,
  type ReferenceRefreshRequest,
} from "../domain/referenceRefresh.js";
import { convertLegacyReference } from "../domain/referenceConverter.js";
import { PrepaidRepository } from "../infrastructure/repository.js";
import { PrepaidStorage, sha256 } from "../infrastructure/prepaidStorage.js";
import type { ReferenceRefreshRunner } from "../infrastructure/referenceRefreshRunner.js";
import type { ReferenceSource } from "../infrastructure/referenceSource.js";
import { SharedExtractionBusy } from "../infrastructure/legacyLanding.js";
import type { Logger } from "../../../platform/logger.js";

type Job = {
  id: string;
  request: ReferenceRefreshRequest;
  status: string;
  phase: string;
  glue_run_id: string | null;
  source_bytes: Buffer | null;
  provenance: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  error: string | null;
  outcome: "completed" | "failed" | null;
  lease_token: string;
  attempts: number;
};
interface Coordination {
  acquire(owner: string): Promise<void>;
  release(owner: string): Promise<void>;
}

/** Durable opt-in reference supply. Glue has no StartJobRun idempotency token:
 * persist dispatch intent, send once, then discover the marked original run.
 * A lost response is UNKNOWN, never permission to send a duplicate overwrite.
 */
export class PrepaidReferenceRefreshWorker {
  constructor(
    readonly repo: PrepaidRepository,
    readonly storage: PrepaidStorage,
    readonly runner: ReferenceRefreshRunner,
    readonly source: ReferenceSource,
    readonly coordination: Coordination,
    readonly idleSources: () => Promise<void>,
    readonly logger: Logger,
  ) {}
  private t = () => this.repo.table("reference_refreshes");
  private async save(job: Job, patch: Record<string, unknown>) {
    const allowed = new Set([
      "phase",
      "status",
      "glue_run_id",
      "source_bytes",
      "provenance",
      "result",
      "error",
      "outcome",
    ]);
    const entries = Object.entries(patch);
    if (!entries.length || entries.some(([name]) => !allowed.has(name)))
      throw Error("Invalid reference job update.");
    const result = await this.repo.pool.query(
      `UPDATE ${this.t()} SET ${entries.map(([name], n) => `${name}=$${n + 3}`).join(",")},updated_at=now()
      WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_until>now() RETURNING *`,
      [
        job.id,
        job.lease_token,
        ...entries.map(([name, value]) =>
          ["provenance", "result"].includes(name) && value !== null
            ? JSON.stringify(value)
            : value,
        ),
      ],
    );
    if (!result.rows[0]) throw Error("Reference job lease lost.");
    Object.assign(job, result.rows[0]);
  }
  private async wait(job: Job, error: string | null = null, unknown = false) {
    await this.repo.pool.query(
      `UPDATE ${this.t()} SET status=$3,error=$4,available_at=now()+interval '15 seconds',lease_until=NULL,updated_at=now()
      WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_until>now()`,
      [job.id, job.lease_token, unknown ? "unknown" : "waiting", error],
    );
  }
  private async finish(
    job: Job,
    outcome: "completed" | "failed",
    error: string | null = null,
  ) {
    await this.save(job, { phase: "releasing", outcome, error });
    await this.release(job);
  }
  private async release(job: Job) {
    await this.coordination.release(`reference:${job.id}`);
    await this.save(job, {
      status: job.outcome!,
      phase: "complete",
      source_bytes: null,
    });
    await this.repo.pool.query(
      `UPDATE ${this.t()} SET lease_until=NULL WHERE id=$1 AND lease_token=$2`,
      [job.id, job.lease_token],
    );
  }
  async tick() {
    const token = randomUUID();
    const row = await this.repo.pool.query(
      `WITH candidate AS (
      SELECT id FROM ${this.t()} WHERE status IN ('queued','running','waiting') AND available_at<=now()
        AND (lease_until IS NULL OR lease_until<now()) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
      ) UPDATE ${this.t()} j SET status='running',lease_token=$1,lease_until=now()+interval '60 seconds',attempts=attempts+1,updated_at=now()
        FROM candidate c WHERE j.id=c.id RETURNING j.*`,
      [token],
    );
    const job = row.rows[0] as Job | undefined;
    if (!job) return false;
    let lost = false;
    const heartbeat = setInterval(() => {
      void this.repo.pool
        .query(
          `UPDATE ${this.t()} SET lease_until=now()+interval '60 seconds' WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_until>now()`,
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
      referenceRefreshRequestSchema.parse(job.request);
      if (job.phase === "releasing") {
        await this.release(job);
        return true;
      }
      await this.coordination.acquire(`reference:${job.id}`);
      if (job.phase === "queued") {
        await this.runner.verify(await this.source.identity());
        await this.idleSources();
        await this.runner.idle();
        if (job.request.mode === "refresh_and_export") {
          // Check the fencing token immediately before the only destructive dispatch.
          if (lost) throw Error("Reference job lease lost.");
          await this.save(job, { phase: "dispatching" });
          const run = await this.runner.start(job.id);
          await this.save(job, { phase: "running", glue_run_id: run });
          await this.wait(job);
          return true;
        }
        await this.save(job, { phase: "exporting" });
      } else if (job.phase === "dispatching") {
        // Recovered dispatch intent: never call StartJobRun here, even if no run is found.
        const run = await this.runner.find(job.id);
        if (!run) {
          await this.wait(
            job,
            "Dispatch outcome is unknown. No matching Glue run is visible; reconcile later or investigate the original request. No replacement was started.",
            true,
          );
          return true;
        }
        await this.save(job, { phase: "running", glue_run_id: run });
      }
      if (job.phase === "running") {
        if (!job.glue_run_id) throw Error("Reference Glue run ID is missing.");
        const state = await this.runner.describe(job.id, job.glue_run_id);
        if (!referenceTerminalStates.has(state)) {
          await this.wait(job);
          return true;
        }
        if (state !== "SUCCEEDED") {
          await this.finish(
            job,
            "failed",
            `SAP reference Glue run ended ${state}. The table may be incomplete; do not use it until the owner verifies recovery.`,
          );
          return true;
        }
        await this.save(job, { phase: "exporting" });
      }
      if (job.phase === "exporting") {
        await this.runner.verify(await this.source.identity());
        await this.runner.idle(job.glue_run_id ?? undefined);
        await this.idleSources();
        const snapshot = await this.source.snapshot(job.request.period);
        // Persist exact bytes before S3: retries cannot capture a changed shared table.
        const converted = convertLegacyReference(
          snapshot.bytes,
          job.request.period,
        );
        if (
          snapshot.rowCount !== converted.report.inputRows ||
          snapshot.rowCount !== converted.report.rowCount
        )
          throw Error(
            "Reference snapshot count/scope does not match validated rows.",
          );
        const provenance = {
          source: `${referenceRefreshJob.schema}.${referenceRefreshJob.table}`,
          sapSource: "SAPPRD.ZTF0455S",
          jobName:
            job.request.mode === "refresh_and_export"
              ? referenceRefreshJob.name
              : null,
          glueRunId: job.glue_run_id,
          scriptSha256: referenceRefreshJob.scriptSha256,
          period: job.request.period,
          client: "300",
          company: "GLOB",
          rowCount: snapshot.rowCount,
          sha256: sha256(snapshot.bytes),
          capturedAt: new Date().toISOString(),
          scopeApproved: true,
          mappingApproved: false,
          refreshExecutionVerified: job.request.mode === "refresh_and_export",
          sourceFreshnessVerified: false,
        };
        await this.save(job, {
          phase: "publishing",
          source_bytes: snapshot.bytes,
          provenance,
        });
      }
      if (job.phase === "publishing") {
        if (!job.source_bytes || !job.provenance)
          throw Error("Durable reference snapshot is missing.");
        const prefix = `prepaid_reclass/reference-exports/${job.id}/`;
        const object = await this.storage.putVerified(
          `${prefix}ztf0455s.jsonl`,
          prefix,
          job.source_bytes,
          "application/x-ndjson",
        );
        if (object.sha256 !== job.provenance.sha256)
          throw Error(
            "Reference publication checksum differs from its durable snapshot.",
          );
        await this.storage.putVerified(
          `${prefix}provenance.json`,
          prefix,
          Buffer.from(JSON.stringify(job.provenance)),
          "application/json",
        );
        await this.save(job, {
          result: {
            referenceExport: {
              key: object.key,
              prefix,
              sha256: object.sha256,
              rowCount: job.provenance.rowCount,
            },
            mappingApprovalRequired: true,
          },
        });
        await this.finish(job, "completed");
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Reference preparation failed.";
      this.logger.error("prepaid.reference.error", {
        id: job.id,
        phase: job.phase,
        message,
      });
      if (!lost) {
        if (
          error instanceof SharedExtractionBusy ||
          ["releasing", "publishing"].includes(job.phase)
        )
          await this.wait(job, message);
        else if (["dispatching", "running"].includes(job.phase))
          await this.wait(
            job,
            message,
            job.phase === "dispatching" || job.attempts >= 20,
          );
        else {
          try {
            await this.finish(job, "failed", message);
          } catch {
            await this.wait(job, message);
          }
        }
      }
    } finally {
      clearInterval(heartbeat);
    }
    return true;
  }
}
