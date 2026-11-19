import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { StepFunctionsRunner } from "../../../stepFunctionsRunner.js";
import { PrepaidRepository } from "../infrastructure/repository.js";
import { PrepaidStorage } from "../infrastructure/prepaidStorage.js";
import {
  datasetSchemas,
  manifestSchema,
  integrationSchema,
  manualIntegrationSchema,
  upstreamManifestSchema,
  jvHeaders,
  encodeDelimited,
  billingCoverageMatches,
  expectedReportCycles,
  type Dataset,
} from "../domain/contracts.js";
import type { Logger } from "../../../platform/logger.js";

type Job = {
  id: string;
  run_id: string;
  revision_id: string | null;
  kind: "ingest" | "delivery";
  phase: string;
  execution_arn: string | null;
  execution_name: string;
  payload: Record<string, any>;
  lease_token: string;
  attempts: number;
};
const receiptSchema = z.object({
  contractVersion: z.literal(1),
  deliveryId: z.string().uuid(),
  exportId: z.string().uuid(),
  sha256: z.string(),
  executionArn: z.string(),
  kind: z.enum(["reversal", "replacement"]),
  outcome: z.enum(["delivered", "not_delivered", "unknown"]),
  remoteFile: z.string().optional(),
  receiptId: z.string().min(1),
  confirmedAt: z.string().datetime(),
});

export class PrepaidWorker {
  constructor(
    readonly repo: PrepaidRepository,
    readonly storage: PrepaidStorage,
    readonly runner: StepFunctionsRunner,
    readonly logger: Logger,
  ) {}
  private t = (name: string) => this.repo.table(name);
  private async assertStandardMachine(name: string) {
    const machine = await this.runner.describeStateMachine(name);
    if (machine.type !== "STANDARD" || machine.status !== "ACTIVE")
      throw new Error(
        "Prepaid processing requires an active Standard Step Functions state machine.",
      );
  }
  async tick(allowLegacyDelivery = false): Promise<boolean> {
    const token = randomUUID();
    const result = await this.repo.pool.query(
      `WITH candidate AS (SELECT id FROM ${this.t("jobs")} WHERE (kind='ingest' OR $2::boolean) AND status IN('queued','running','waiting') AND available_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE ${this.t("jobs")} j SET lease_token=$1,lease_until=now()+interval '60 seconds',status='running',attempts=attempts+1,updated_at=now() FROM candidate c WHERE j.id=c.id RETURNING j.*`,
      [token, allowLegacyDelivery],
    );
    const job = result.rows[0] as Job | undefined;
    if (!job) return false;
    // Renew leases even while S3 is streaming or AWS is responding. Publication checks the token.
    let leaseLost = false;
    const heartbeat = setInterval(() => {
      void this.repo.pool
        .query(
          `UPDATE ${this.t("jobs")} SET lease_until=now()+interval '60 seconds' WHERE id=$1 AND lease_token=$2 AND status='running'`,
          [job.id, token],
        )
        .then((r) => {
          if (!r.rowCount) leaseLost = true;
        })
        .catch(() => {
          leaseLost = true;
        });
    }, 15_000);
    try {
      if (job.kind === "ingest") await this.ingest(job, () => leaseLost);
      else await this.deliver(job, () => leaseLost);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Prepaid job failed";
      this.logger.error("prepaid.job.error", {
        jobId: job.id,
        kind: job.kind,
        phase: job.phase,
        message,
      });
      // A transport failure after dispatch might hide a successful remote push.
      // Named executions are reconciled on a later tick; do not send another copy.
      const uncertain =
        job.kind === "delivery" &&
        (job.phase.endsWith("starting") || !!job.execution_arn);
      if (!leaseLost)
        await this.repo.transaction(async (db) => {
          await db.query(
            `SELECT id FROM ${this.t("runs")} WHERE id=$1 FOR UPDATE`,
            [job.run_id],
          );
          const locked = (
            await db.query(
              `SELECT * FROM ${this.t("jobs")} WHERE id=$1 AND lease_token=$2 AND status='running' FOR UPDATE`,
              [job.id, token],
            )
          ).rows[0];
          if (!locked) return;
          const consecutiveFailures =
            Number(locked.error?.consecutiveFailures ?? 0) + 1;
          if (uncertain && consecutiveFailures < 20) {
            await db.query(
              `UPDATE ${this.t("jobs")} SET status='waiting',error=$3,available_at=now()+interval '30 seconds',lease_until=NULL WHERE id=$1 AND lease_token=$2`,
              [
                job.id,
                token,
                JSON.stringify({
                  message,
                  reconciling: true,
                  consecutiveFailures,
                }),
              ],
            );
          } else {
            const status = uncertain ? "unknown" : "failed";
            await db.query(
              `UPDATE ${this.t("jobs")} SET status=$3,error=$4,lease_until=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2`,
              [
                job.id,
                token,
                status,
                JSON.stringify({ message, consecutiveFailures }),
              ],
            );
            if (job.kind === "ingest")
              await db.query(
                `UPDATE ${this.t("source_snapshots")} SET status='failed' WHERE id=$1`,
                [job.payload.snapshotId],
              );
            else
              await db.query(
                `UPDATE ${this.t("deliveries")} SET status=$2 WHERE id=$1`,
                [job.payload.deliveryId, status],
              );
            await this.repo.event(
              db,
              job.run_id,
              `job.${status}`,
              { message },
              undefined,
              job.revision_id ?? undefined,
              job.id,
            );
          }
        });
    } finally {
      clearInterval(heartbeat);
    }
    return true;
  }
  private async persist(
    job: Job,
    patch: {
      phase?: string;
      executionArn?: string | null;
      payload?: Record<string, unknown>;
      status?: string;
      delay?: number;
    },
  ) {
    const result = await this.repo.pool.query(
      `UPDATE ${this.t("jobs")} SET phase=coalesce($3,phase),execution_arn=CASE WHEN $4 THEN $5 ELSE execution_arn END,payload=coalesce($6,payload),status=coalesce($7,status),error=CASE WHEN $7 IS NOT NULL THEN NULL ELSE error END,available_at=now()+($8::integer*interval '1 second'),lease_until=CASE WHEN $7 IS NULL THEN lease_until ELSE NULL END,updated_at=now() WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_until>now() RETURNING *`,
      [
        job.id,
        job.lease_token,
        patch.phase ?? null,
        "executionArn" in patch,
        patch.executionArn ?? null,
        patch.payload ? JSON.stringify(patch.payload) : null,
        patch.status ?? null,
        patch.delay ?? 10,
      ],
    );
    if (!result.rows[0]) throw new Error("Prepaid job lease was lost");
    Object.assign(job, result.rows[0]);
  }
  private async ingestionStart(
    job: Job,
    snapshot: Record<string, any>,
    run: Record<string, any>,
  ) {
    const config = manualIntegrationSchema.parse(snapshot.configuration);
    if (
      !config.ingestStateMachine ||
      config.preparationMode === "native_sources"
    )
      throw Error(
        "Run-scoped adapter ingestion is unavailable in native_sources mode; use workspace source preparation.",
      );
    const prefix = `${this.storage.prefix(job.run_id)}ingestion/${snapshot.id}/`;
    if (snapshot.upstream_source) {
      const m = upstreamManifestSchema.parse(snapshot.upstream_source.manifest);
      const execution = await this.runner.describeExecution(m.executionArn);
      if (
        execution.status !== "SUCCEEDED" ||
        !execution.outputIncluded ||
        !execution.output
      )
        throw new Error(
          "Upstream billing execution is not confirmed successful.",
        );
      const proof = z
        .object({
          contractVersion: z.literal(1),
          period: z.string(),
          workspaceId: z.string(),
          manifestKey: z.string(),
        })
        .parse(JSON.parse(execution.output));
      if (
        proof.period !== run.period ||
        proof.workspaceId !== run.workspace_id ||
        proof.manifestKey !== snapshot.upstream_source.manifest_key
      )
        throw new Error(
          "Upstream execution does not attest the supplied manifest.",
        );
    }
    const input = {
      contractVersion: 1,
      runId: run.id,
      workspaceId: run.workspace_id,
      period: run.period,
      ingestionId: snapshot.id,
      bucket: this.storage.bucket,
      outputPrefix: prefix,
      expectedCycles: config.expectedCycles,
      sources: snapshot.source_files.map((f: any) => ({
        id: f.id,
        code: f.source_code,
        key: f.object_key,
        sha256: f.sha256,
      })),
      upstream: snapshot.upstream_source
        ? {
            manifestKey: snapshot.upstream_source.manifest_key,
            executionArn: snapshot.upstream_source.manifest.executionArn,
          }
        : null,
    };
    if (job.phase !== "ingest-starting")
      await this.assertStandardMachine(config.ingestStateMachine);
    await this.persist(job, {
      phase: "ingest-starting",
      payload: { ...job.payload, executionInput: input },
    });
    const started = await this.runner.startExecution(
      config.ingestStateMachine,
      input,
      job.execution_name,
    );
    await this.persist(job, {
      phase: "ingest-running",
      executionArn: started.executionArn,
      status: "waiting",
    });
  }
  private async ingest(job: Job, lost: () => boolean) {
    const snapshot = (
      await this.repo.pool.query(
        `SELECT * FROM ${this.t("source_snapshots")} WHERE id=$1`,
        [job.payload.snapshotId],
      )
    ).rows[0];
    const run = (
      await this.repo.pool.query(
        `SELECT * FROM ${this.t("runs")} WHERE id=$1`,
        [job.run_id],
      )
    ).rows[0];
    if (!snapshot || !run) throw new Error("Ingestion context is missing");
    if (!job.execution_arn) {
      await this.ingestionStart(job, snapshot, run);
      return;
    }
    const execution = await this.runner.describeExecution(job.execution_arn);
    if (
      execution.status === "RUNNING" ||
      execution.status === "PENDING_REDRIVE"
    ) {
      await this.persist(job, { status: "waiting" });
      return;
    }
    if (
      execution.status !== "SUCCEEDED" ||
      !execution.outputIncluded ||
      !execution.output
    )
      throw new Error(
        `Ingestion failed: ${execution.errorMessage ?? execution.status}`,
      );
    const output = z
      .object({ contractVersion: z.literal(1), manifestKey: z.string() })
      .parse(JSON.parse(execution.output));
    const prefix = `${this.storage.prefix(job.run_id)}ingestion/${snapshot.id}/`;
    const manifest = manifestSchema.parse(
      await this.storage.json(output.manifestKey, prefix),
    );
    const config = manualIntegrationSchema.parse(snapshot.configuration);
    if (
      manifest.runId !== run.id ||
      manifest.workspaceId !== run.workspace_id ||
      manifest.period !== run.period ||
      manifest.ingestionId !== snapshot.id ||
      manifest.executionArn !== job.execution_arn
    )
      throw new Error(
        "Ingestion manifest identifies a different run, period or execution",
      );
    if (!billingCoverageMatches(config, manifest.coverage))
      throw new Error("Incomplete or duplicate billing-cycle coverage");
    if (
      manifest.sourceFiles.length !== snapshot.source_files.length ||
      new Set(manifest.sourceFiles.map((f) => f.id)).size !==
        manifest.sourceFiles.length ||
      !snapshot.source_files.every((f: any) =>
        manifest.sourceFiles.some(
          (m) => m.id === f.id && m.sha256 === f.sha256,
        ),
      )
    )
      throw new Error(
        "Ingestion manifest does not attest the exact uploaded sources",
      );
    const expected = Object.keys(datasetSchemas);
    if (
      manifest.datasets.length !== expected.length ||
      new Set(manifest.datasets.map((d) => d.name)).size !== expected.length ||
      !expected.every((n) => manifest.datasets.some((d) => d.name === n))
    )
      throw new Error("Ingestion manifest is missing required datasets");
    if (
      manifest.datasets.some(
        (d) => ["ke24", "reference"].includes(d.name) && d.rowCount === 0,
      )
    )
      throw new Error("KE24 and SAP reference datasets cannot be empty");
    if (snapshot.upstream_source) {
      const upstream = upstreamManifestSchema.parse(
        snapshot.upstream_source.manifest,
      );
      for (const original of upstream.datasets) {
        const copy = manifest.datasets.find((d) => d.name === original.name);
        if (
          !copy ||
          copy.sha256 !== original.sha256 ||
          copy.rowCount !== original.rowCount
        )
          throw new Error(
            "AMAXCE datasets differ from the attested upstream snapshot",
          );
      }
    }
    // Use a transaction: a failed checksum/row count cannot publish partial staging.
    await this.repo.transaction(async (db) => {
      await db.query(
        `SELECT id FROM ${this.t("runs")} WHERE id=$1 FOR UPDATE`,
        [job.run_id],
      );
      const owned = await db.query(
        `SELECT id FROM ${this.t("jobs")} WHERE id=$1 AND lease_token=$2 AND status='running' FOR UPDATE`,
        [job.id, job.lease_token],
      );
      if (!owned.rowCount || lost()) throw new Error("Ingestion lease lost");
      for (const descriptor of manifest.datasets) {
        await db.query(
          `DELETE FROM ${this.t(`stage_${descriptor.name}`)} WHERE snapshot_id=$1`,
          [snapshot.id],
        );
        let number = 0;
        let batch: { n: number; data: unknown }[] = [];
        const flush = async () => {
          if (!batch.length) return;
          await db.query(
            `INSERT INTO ${this.t(`stage_${descriptor.name}`)}(snapshot_id,row_number,data) SELECT $1,(v->>'n')::bigint,v->'data' FROM jsonb_array_elements($2::jsonb) v`,
            [snapshot.id, JSON.stringify(batch)],
          );
          batch = [];
        };
        for await (const value of this.storage.rows(
          descriptor.key,
          prefix,
          descriptor.sha256,
          descriptor.rowCount,
        )) {
          const data = datasetSchemas[descriptor.name].parse(value);
          if (data.period !== run.period)
            throw new Error(
              `Dataset ${descriptor.name} contains a different accounting period`,
            );
          if (
            descriptor.name === "callcard" &&
            Number(run.period.slice(5)) !==
              (data as z.infer<typeof datasetSchemas.callcard>).month_no
          )
            throw new Error("Call Card month differs from accounting period");
          if (
            (descriptor.name === "adjustments" ||
              descriptor.name === "charges") &&
            !expectedReportCycles(config, descriptor.name).includes(
              (data as z.infer<typeof datasetSchemas.adjustments>).cycle,
            )
          )
            throw new Error(
              "Dataset contains a billing cycle outside the run coverage",
            );
          batch.push({ n: ++number, data });
          if (batch.length >= 500) await flush();
          if (lost()) throw new Error("Ingestion lease lost");
        }
        await flush();
      }
      await db.query(
        `UPDATE ${this.t("source_snapshots")} SET status='ready',manifest=$2,completed_at=now() WHERE id=$1`,
        [snapshot.id, JSON.stringify(manifest)],
      );
      await db.query(
        `UPDATE ${this.t("jobs")} SET status='completed',phase='complete',lease_until=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2`,
        [job.id, job.lease_token],
      );
      await this.repo.event(
        db,
        job.run_id,
        "ingestion.completed",
        { snapshotId: snapshot.id },
        undefined,
        undefined,
        job.id,
      );
    });
  }
  private async artifact(
    job: Job,
    delivery: Record<string, any>,
    kind: "replacement" | "reversal",
    revisionId: string,
    configuration: unknown,
  ) {
    const existing = (
      await this.repo.pool.query(
        `SELECT * FROM ${this.t("exports")} WHERE delivery_id=$1 AND kind=$2`,
        [delivery.id, kind],
      )
    ).rows[0];
    if (existing) return existing;
    const config = integrationSchema.parse(configuration);
    const rows =
      kind === "replacement"
        ? (
            await this.repo.pool.query(
              `SELECT fields FROM ${this.t("jv_lines")} WHERE revision_id=$1 ORDER BY id`,
              [revisionId],
            )
          ).rows.map((x) => x.fields)
        : (
            await this.repo.pool.query(
              `SELECT ${this.repo.schema}.prepaid_reversal_lines($1) fields`,
              [revisionId],
            )
          ).rows.map((x) => x.fields);
    const bytes = encodeDelimited(
      rows,
      jvHeaders,
      config.format.delimiter,
      config.format.lineEnding,
      config.format.encoding,
    );
    // Deterministic key and bytes let recovery adopt an object uploaded before DB commit.
    const key = `${this.storage.prefix(job.run_id)}exports/${delivery.id}/${kind}/txPrepaid_JV_${delivery.region.toUpperCase()}Sel.txt`;
    let saved;
    try {
      saved = await this.storage.put(key, bytes, "text/plain");
    } catch (error) {
      if (
        !["PreconditionFailed", "ConditionalRequestConflict"].includes(
          (error as { name?: string }).name ?? "",
        )
      )
        throw error;
      const existingObject = await this.storage.get(
        key,
        this.storage.prefix(job.run_id),
      );
      const buffer = await existingObject.Body?.transformToByteArray();
      if (!buffer || !Buffer.from(buffer).equals(bytes))
        throw new Error("Existing export differs from frozen JV bytes");
      const { sha256 } = await import("../infrastructure/prepaidStorage.js");
      saved = { key, sha256: sha256(bytes), size: bytes.byteLength };
    }
    const exportId = randomUUID();
    const q = await this.repo.pool.query(
      `INSERT INTO ${this.t("exports")}(id,revision_id,delivery_id,kind,object_key,sha256,byte_size,profile) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(delivery_id,kind) DO NOTHING RETURNING *`,
      [
        exportId,
        revisionId,
        delivery.id,
        kind,
        saved.key,
        saved.sha256,
        saved.size,
        config.format.profile,
      ],
    );
    return (
      q.rows[0] ??
      (
        await this.repo.pool.query(
          `SELECT * FROM ${this.t("exports")} WHERE delivery_id=$1 AND kind=$2`,
          [delivery.id, kind],
        )
      ).rows[0]
    );
  }
  private async predecessor(
    delivery: Record<string, any>,
  ): Promise<Record<string, any> | null | "waiting"> {
    let id = delivery.predecessor_delivery_id;
    while (id) {
      const previous = (
        await this.repo.pool.query(
          `SELECT * FROM ${this.t("deliveries")} WHERE id=$1`,
          [id],
        )
      ).rows[0];
      if (!previous) throw new Error("SAP predecessor delivery is missing");
      if (previous.status === "delivered") return previous;
      if (previous.status === "cancelled") {
        id = previous.predecessor_delivery_id;
        continue;
      }
      // A confirmed no-delivery failure of an initial posting can be replaced.
      if (previous.status === "failed" && !previous.correction) {
        id = previous.predecessor_delivery_id;
        continue;
      }
      return "waiting";
    }
    return null;
  }
  private async deliver(job: Job, lost: () => boolean) {
    const delivery = (
      await this.repo.pool.query(
        `SELECT * FROM ${this.t("deliveries")} WHERE id=$1`,
        [job.payload.deliveryId],
      )
    ).rows[0];
    const run = (
      await this.repo.pool.query(
        `SELECT * FROM ${this.t("runs")} WHERE id=$1`,
        [job.run_id],
      )
    ).rows[0];
    if (!delivery || !run) throw new Error("Delivery context is missing");
    const config = integrationSchema.parse(run.configuration);
    if (job.phase === "initial") {
      const previous = await this.predecessor(delivery);
      if (previous === "waiting") {
        await this.repo.pool.query(
          `UPDATE ${this.t("deliveries")} SET status='waiting' WHERE id=$1`,
          [delivery.id],
        );
        await this.persist(job, { status: "waiting", delay: 30 });
        return;
      }
      await this.repo.pool.query(
        `UPDATE ${this.t("deliveries")} SET correction=$2 WHERE id=$1`,
        [delivery.id, !!previous],
      );
      const replacement = await this.artifact(
        job,
        delivery,
        "replacement",
        job.revision_id!,
        config,
      );
      const reversal = previous
        ? await this.artifact(
            job,
            { ...delivery, predecessor_delivery_id: previous.id },
            "reversal",
            previous.revision_id,
            config,
          )
        : null;
      await this.persist(job, {
        phase: previous ? "reversal-ready" : "replacement-ready",
        payload: {
          ...job.payload,
          replacementId: replacement.id,
          reversalId: reversal?.id ?? null,
          reversedDeliveryId: previous?.id ?? null,
        },
      });
    }
    const kind: "reversal" | "replacement" = job.phase.startsWith("reversal")
      ? "reversal"
      : "replacement";
    if (job.phase.endsWith("ready") || job.phase.endsWith("starting")) {
      const artifactId =
        kind === "reversal"
          ? job.payload.reversalId
          : job.payload.replacementId;
      const artifact = (
        await this.repo.pool.query(
          `SELECT * FROM ${this.t("exports")} WHERE id=$1`,
          [artifactId],
        )
      ).rows[0];
      if (!artifact || lost())
        throw new Error("Delivery export or lease missing");
      const input =
        job.payload.executionInput && job.phase.endsWith("starting")
          ? job.payload.executionInput
          : {
              contractVersion: 1,
              runId: run.id,
              workspaceId: run.workspace_id,
              period: run.period,
              region: delivery.region,
              deliveryId: delivery.id,
              predecessorDeliveryId: job.payload.reversedDeliveryId,
              kind,
              exportId: artifact.id,
              sha256: artifact.sha256,
              bucket: this.storage.bucket,
              key: artifact.object_key,
              target: config.target,
              formatProfile: config.format.profile,
              receiptPrefix: `${this.storage.prefix(job.run_id)}receipts/${delivery.id}/`,
            };
      if (job.phase.endsWith("ready"))
        await this.assertStandardMachine(config.deliveryStateMachine);
      await this.persist(job, {
        phase: `${kind}-starting`,
        payload: { ...job.payload, executionInput: input },
      });
      const legAttempt = job.payload[`${kind}Attempt`] ?? 0;
      const started = await this.runner.startExecution(
        config.deliveryStateMachine,
        input,
        `${job.execution_name}-${kind}-${legAttempt}`,
      );
      await this.repo.pool.query(
        `UPDATE ${this.t("deliveries")} SET status='sending' WHERE id=$1`,
        [delivery.id],
      );
      await this.persist(job, {
        phase: `${kind}-running`,
        executionArn: started.executionArn,
        status: "waiting",
      });
      return;
    }
    if (!job.execution_arn) throw new Error("Delivery execution ARN missing");
    const execution = await this.runner.describeExecution(job.execution_arn);
    if (
      execution.status === "RUNNING" ||
      execution.status === "PENDING_REDRIVE"
    ) {
      await this.persist(job, { status: "waiting" });
      return;
    }
    // Terminal success without an attested delivery receipt is UNKNOWN, not delivered.
    let receipt: z.infer<typeof receiptSchema> | null = null;
    try {
      const body =
        execution.outputIncluded && execution.output
          ? JSON.parse(execution.output)
          : JSON.parse(execution.errorMessage ?? "{}");
      const result = job.payload.receiptOverrideKey
        ? { receiptKey: job.payload.receiptOverrideKey }
        : z.object({ receiptKey: z.string() }).parse(body);
      receipt = receiptSchema.parse(
        await this.storage.json(
          result.receiptKey,
          `${this.storage.prefix(job.run_id)}receipts/${delivery.id}/`,
        ),
      );
      if (
        receipt.deliveryId !== delivery.id ||
        receipt.executionArn !== job.execution_arn ||
        receipt.kind !== kind ||
        receipt.exportId !== job.payload.executionInput.exportId ||
        receipt.sha256 !== job.payload.executionInput.sha256
      )
        receipt = null;
    } catch {
      /* Missing/invalid receipt must never authorize retry or completion. */
    }
    const outcome = receipt?.outcome ?? "unknown";
    await this.repo.transaction(async (db) => {
      await db.query(
        `SELECT id FROM ${this.t("runs")} WHERE id=$1 FOR UPDATE`,
        [job.run_id],
      );
      if (
        lost() ||
        !(
          await db.query(
            `SELECT id FROM ${this.t("jobs")} WHERE id=$1 AND lease_token=$2 AND status='running' FOR UPDATE`,
            [job.id, job.lease_token],
          )
        ).rowCount
      )
        throw new Error("Delivery lease lost");
      await this.repo.event(
        db,
        job.run_id,
        `sap.${kind}.${outcome}`,
        { receipt },
        undefined,
        job.revision_id ?? undefined,
        job.id,
      );
      if (outcome === "delivered" && kind === "reversal") {
        await db.query(
          `UPDATE ${this.t("deliveries")} SET status='reversed' WHERE id=$1`,
          [job.payload.reversedDeliveryId],
        );
        await db.query(
          `UPDATE ${this.t("jobs")} SET phase='replacement-ready',execution_arn=NULL,payload=payload-'executionInput'-'receiptOverrideKey',status='queued',available_at=now(),lease_until=NULL,updated_at=now() WHERE id=$1`,
          [job.id],
        );
      } else if (outcome === "delivered") {
        await db.query(
          `UPDATE ${this.t("deliveries")} SET status='delivered',completed_at=now() WHERE id=$1`,
          [delivery.id],
        );
        await db.query(
          `UPDATE ${this.t("jobs")} SET phase='complete',status='completed',lease_until=NULL,updated_at=now() WHERE id=$1`,
          [job.id],
        );
      } else {
        const status = outcome === "not_delivered" ? "failed" : "unknown";
        await db.query(
          `UPDATE ${this.t("deliveries")} SET status=$2 WHERE id=$1`,
          [delivery.id, status],
        );
        await db.query(
          `UPDATE ${this.t("jobs")} SET status=$2,error=$3,lease_until=NULL,updated_at=now() WHERE id=$1`,
          [
            job.id,
            status,
            JSON.stringify({
              code:
                outcome === "not_delivered"
                  ? "CONFIRMED_NOT_DELIVERED"
                  : "DELIVERY_OUTCOME_UNKNOWN",
              receipt,
            }),
          ],
        );
      }
    });
  }
}
