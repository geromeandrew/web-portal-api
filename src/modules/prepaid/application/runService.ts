import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { AppError } from "../../../errors.js";
import { prepaidMaximumSourceBytes } from "../domain/limits.js";
import { assertAdministrator } from "../../../rbac.js";
import {
  manualIntegrationSchema,
  sourceCodes,
  expectedName,
  upstreamManifestSchema,
  type Region,
  type Integration,
  type editSchema,
} from "../domain/contracts.js";
import type { z } from "zod";
import { PrepaidRepository } from "../infrastructure/repository.js";
import { PrepaidStorage } from "../infrastructure/prepaidStorage.js";
import { prepaidConfigurationReadiness } from "../domain/integrationReadiness.js";

export class PrepaidRunService {
  constructor(
    readonly repo: PrepaidRepository,
    readonly storage: PrepaidStorage,
  ) {}
  private t = (name: string) => this.repo.table(name);
  async readiness() {
    const objects = [
      "runs",
      "upload_sessions",
      "snapshot_context",
      "integrations",
      "source_totals",
      "source_extractions",
      "reference_refreshes",
    ];
    const present = await this.repo.pool.query(
      "SELECT name,to_regclass(name) IS NOT NULL present FROM unnest($1::text[]) name UNION ALL SELECT 'backend_source_context',EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass($2) AND attname='context' AND NOT attisdropped) UNION ALL SELECT 'all_source_workflows',EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass($2) AND conname='prepaid_source_extractions_workflow_check' AND pg_get_constraintdef(oid) LIKE '%charges_318%')",
      [objects.map((x) => this.t(x)), this.t("source_extractions")],
    );
    // Migration 009 is an additive admin capability. Existing installations
    // using an approved external reference export do not lose their upload path.
    const referenceExportsAvailable = !!present.rows.find(
      (r) => r.name === this.t("reference_refreshes"),
    )?.present;
    const schemaInstalled = present.rows
      .filter((r) => r.name !== this.t("reference_refreshes"))
      .every((r) => r.present);
    const hasIntegration = present.rows[3]?.present;
    const stored = hasIntegration
      ? (
          await this.repo.pool.query(
            `SELECT configuration FROM ${this.t("integrations")} WHERE id=true`,
          )
        ).rows[0]?.configuration
      : undefined;
    const configuration = prepaidConfigurationReadiness(stored);
    const checks = [
      {
        code: "schema",
        status: schemaInstalled ? "configured" : "missing",
        message: schemaInstalled
          ? "Prepaid schema is installed."
          : "Install Prepaid migrations 001 through 008.",
      },
      ...configuration.checks,
      {
        code: "referenceExports",
        status: referenceExportsAvailable ? "configured" : "missing",
        message: referenceExportsAvailable
          ? "Administrator reference refresh/export is available; live data and mapping approval still require verification."
          : "Install additive migration 009 to enable administrator SAP reference refresh/export. Existing approved external reference exports remain supported.",
      },
      {
        code: "externalVerification",
        status: "not_verified",
        message:
          "Configuration alone does not verify report parsing, live reference data, AWS execution or SAP acceptance.",
      },
    ];
    return {
      schemaInstalled,
      referenceExportsAvailable,
      integrationConfigured: configuration.integrationConfigured,
      readyForUploads: schemaInstalled && configuration.integrationConfigured,
      legacyBasis: configuration.legacyBasis,
      externalVerification: "not_verified",
      checks,
    };
  }
  async integration() {
    const result = await this.repo.pool.query(
      `SELECT configuration FROM ${this.t("integrations")} WHERE id=true`,
    );
    if (!result.rows[0])
      throw new AppError(
        409,
        "PREPAID_INTEGRATION_NOT_CONFIGURED",
        "Prepaid processing is not configured. An administrator must configure ingestion, billing-cycle coverage and an approved manual export format. Preparation starts automatically after all required uploads.",
      );
    return manualIntegrationSchema.parse(result.rows[0].configuration);
  }
  async configure(
    userId: string,
    configuration: z.infer<typeof manualIntegrationSchema>,
  ) {
    await assertAdministrator(this.repo.pool, userId);
    await this.repo.pool.query(
      `INSERT INTO ${this.t("integrations")}(id,configuration,updated_by) VALUES(true,$1,$2) ON CONFLICT(id) DO UPDATE SET configuration=excluded.configuration,updated_by=excluded.updated_by,updated_at=now()`,
      [JSON.stringify(manualIntegrationSchema.parse(configuration)), userId],
    );
    return { configured: true };
  }
  async create(userId: string, period: string) {
    const configuration = await this.integration();
    const id = randomUUID();
    await this.repo.transaction(async (db) => {
      const workspace = await this.repo.workspace(db, userId);
      await db.query(
        `INSERT INTO ${this.t("runs")}(id,workspace_id,period,created_by,configuration) VALUES($1,$2,$3,$4,$5)`,
        [id, workspace, period, userId, JSON.stringify(configuration)],
      );
      for (const region of ["eg", "sg"]) {
        const revision = randomUUID();
        await db.query(
          `INSERT INTO ${this.t("region_revisions")}(id,run_id,region,revision,status) VALUES($1,$2,$3,1,'draft')`,
          [revision, id, region],
        );
        await db.query(
          `SELECT ${this.repo.schema}.prepaid_initialize_layout($1)`,
          [revision],
        );
      }
      await db.query(
        `INSERT INTO ${this.t("workspace_selection")}(workspace_id,run_id) VALUES($1,$2) ON CONFLICT(workspace_id) DO UPDATE SET run_id=excluded.run_id`,
        [workspace, id],
      );
      await this.repo.event(db, id, "run.created", { period }, userId);
    });
    return this.get(userId, id);
  }
  async list(userId: string) {
    return (
      await this.repo.pool.query(
        `SELECT r.* FROM ${this.t("runs")} r JOIN ${this.repo.schema}.workspaces w ON w.id=r.workspace_id WHERE w.user_id=$1 ORDER BY r.period DESC`,
        [userId],
      )
    ).rows;
  }
  async select(userId: string, runId: string) {
    const run = await this.repo.own(this.repo.pool, userId, runId);
    await this.repo.pool.query(
      `INSERT INTO ${this.t("workspace_selection")}(workspace_id,run_id) VALUES($1,$2) ON CONFLICT(workspace_id) DO UPDATE SET run_id=excluded.run_id`,
      [run.workspace_id, runId],
    );
    return this.get(userId, runId);
  }
  async active(userId: string) {
    const q = await this.repo.pool.query(
      `SELECT s.run_id FROM ${this.t("workspace_selection")} s JOIN ${this.repo.schema}.workspaces w ON w.id=s.workspace_id WHERE w.user_id=$1`,
      [userId],
    );
    if (!q.rows[0])
      throw new AppError(
        409,
        "PREPAID_RUN_REQUIRED",
        "Create or select an accounting-period run first.",
      );
    return q.rows[0].run_id as string;
  }
  async get(userId: string, runId: string) {
    const run = await this.repo.own(this.repo.pool, userId, runId);
    const [revisions, files, snapshots, jobs, deliveries] = await Promise.all([
      this.repo.pool.query(
        `SELECT * FROM ${this.t("region_revisions")} WHERE run_id=$1 ORDER BY region,revision DESC`,
        [runId],
      ),
      this.repo.pool.query(
        `SELECT * FROM ${this.t("source_files")} WHERE run_id=$1 AND active ORDER BY source_code`,
        [runId],
      ),
      this.repo.pool.query(
        `SELECT id,status,created_at,completed_at FROM ${this.t("source_snapshots")} WHERE run_id=$1 ORDER BY created_at DESC`,
        [runId],
      ),
      this.repo.pool.query(
        `SELECT id,kind,status,phase,execution_arn,error,created_at,updated_at FROM ${this.t("jobs")} WHERE run_id=$1 ORDER BY created_at DESC`,
        [runId],
      ),
      this.repo.pool.query(
        `SELECT d.* FROM ${this.t("deliveries")} d JOIN ${this.t("region_revisions")} r ON r.id=d.revision_id WHERE r.run_id=$1 ORDER BY d.created_at DESC`,
        [runId],
      ),
    ]);
    return {
      ...run,
      revisions: revisions.rows,
      files: files.rows,
      snapshots: snapshots.rows,
      jobs: jobs.rows,
      deliveries: deliveries.rows,
    };
  }
  private async mutableSources(db: PoolClient, userId: string, runId: string) {
    const run = await this.repo.own(db, userId, runId, true);
    if (
      (
        await db.query(
          `SELECT 1 FROM ${this.t("upload_sessions")} WHERE workspace_id=$1 AND active`,
          [run.workspace_id],
        )
      ).rowCount
    )
      throw new AppError(
        409,
        "PREPAID_WORKSPACE_SOURCE_API_REQUIRED",
        "Use the workspace source APIs while an upload session owns this workspace.",
      );
    if (
      (
        await db.query(
          `SELECT 1 FROM ${this.t("source_snapshots")} WHERE run_id=$1 AND status='pending' UNION ALL SELECT 1 FROM ${this.t("upload_sessions")} WHERE run_id=$1 AND active AND status='pending'`,
          [runId],
        )
      ).rowCount
    )
      throw new AppError(
        409,
        "PREPAID_INGESTION_RUNNING",
        "Wait for the current ingestion attempt before changing sources.",
      );
    if (
      (
        await db.query(
          `SELECT 1 FROM ${this.t("region_revisions")} r WHERE run_id=$1 AND status='frozen' AND NOT EXISTS(SELECT 1 FROM ${this.t("region_revisions")} n WHERE n.run_id=r.run_id AND n.region=r.region AND n.revision>r.revision)`,
          [runId],
        )
      ).rowCount
    )
      throw new AppError(
        409,
        "PREPAID_EDIT_REQUIRED",
        "Trigger Edit on the frozen region before changing its source inputs.",
      );
    return run;
  }
  async upload(
    userId: string,
    runId: string,
    code: string,
    file: { originalname: string; buffer: Buffer; mimetype: string },
  ) {
    if (file.buffer.length > prepaidMaximumSourceBytes)
      throw new AppError(
        413,
        "PREPAID_SOURCE_TOO_LARGE",
        "Prepaid sources must not exceed 100 MiB.",
      );
    const run = await this.repo.own(this.repo.pool, userId, runId);
    const config = manualIntegrationSchema.parse(run.configuration);
    if (
      !sourceCodes.includes(code as (typeof sourceCodes)[number]) &&
      !config.expectedCycles.includes(code.split("_")[1])
    )
      throw new AppError(
        400,
        "PREPAID_CYCLE_NOT_REQUIRED",
        "This cycle is not configured for the run.",
      );
    const name = expectedName(code);
    if (file.originalname.toLowerCase() !== name.toLowerCase())
      throw new AppError(400, "PREPAID_FILE_NAME_INVALID", `Expected ${name}.`);
    if (!file.buffer.length)
      throw new AppError(
        400,
        "PREPAID_EMPTY_FILE",
        "The uploaded file is empty.",
      );
    if (/\.xlsx$/i.test(name) && file.buffer.subarray(0, 2).toString() !== "PK")
      throw new AppError(
        400,
        "PREPAID_FILE_TYPE_INVALID",
        "Excel inputs must be XLSX workbooks.",
      );
    const id = randomUUID();
    const key = `${this.storage.prefix(runId)}sources/${id}/${name}`;
    // Validate before the upload, then revalidate under a lock before publishing.
    await this.repo.transaction((db) => this.mutableSources(db, userId, runId));
    const saved = await this.storage.put(key, file.buffer, file.mimetype);
    await this.repo.transaction(async (db) => {
      await this.mutableSources(db, userId, runId);
      await db.query(
        `UPDATE ${this.t("source_files")} SET active=false WHERE run_id=$1 AND source_code=$2 AND active`,
        [runId, code],
      );
      await db.query(
        `INSERT INTO ${this.t("source_files")}(id,run_id,source_code,original_name,object_key,sha256,size_bytes,uploaded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          id,
          runId,
          code,
          file.originalname,
          key,
          saved.sha256,
          saved.size,
          userId,
        ],
      );
      await this.repo.event(
        db,
        runId,
        "source.uploaded",
        { sourceCode: code, sourceFileId: id, sha256: saved.sha256 },
        userId,
      );
    });
    return { id, ...saved };
  }
  async remove(userId: string, runId: string, code?: string) {
    return this.repo.transaction(async (db) => {
      await this.mutableSources(db, userId, runId);
      const q = await db.query(
        `UPDATE ${this.t("source_files")} SET active=false WHERE run_id=$1 AND active ${code ? "AND source_code=$2" : ""} RETURNING id`,
        code ? [runId, code] : [runId],
      );
      await this.repo.event(
        db,
        runId,
        "source.detached",
        { sourceCode: code, removedCount: q.rowCount },
        userId,
      );
      return { removedCount: q.rowCount };
    });
  }
  async attachUpstream(userId: string, runId: string, key: string) {
    const run = await this.repo.own(this.repo.pool, userId, runId);
    const config = manualIntegrationSchema.parse(run.configuration);
    if (!config.upstreamPrefix)
      throw new AppError(
        409,
        "PREPAID_UPSTREAM_NOT_CONFIGURED",
        "The legacy upstream adapter is not configured for this run.",
      );
    const manifest = upstreamManifestSchema.parse(
      await this.storage.json(key, config.upstreamPrefix),
    );
    if (
      manifest.period !== run.period ||
      manifest.workspaceId !== run.workspace_id ||
      manifest.coverage.length !== config.expectedCycles.length ||
      !config.expectedCycles.every((c) =>
        manifest.coverage.some((x) => x.cycle === c),
      )
    )
      throw new AppError(
        400,
        "PREPAID_UPSTREAM_COVERAGE_INVALID",
        "Upstream period, workspace or billing-cycle coverage does not match this run.",
      );
    for (const d of manifest.datasets)
      this.storage.assertKey(d.key, config.upstreamPrefix);
    // AWS provenance is verified by the worker before the snapshot becomes usable.
    const id = randomUUID();
    await this.repo.transaction(async (db) => {
      await this.mutableSources(db, userId, runId);
      await db.query(
        `UPDATE ${this.t("upstream_sources")} SET active=false WHERE run_id=$1 AND active`,
        [runId],
      );
      await db.query(
        `INSERT INTO ${this.t("upstream_sources")}(id,run_id,manifest_key,manifest) VALUES($1,$2,$3,$4)`,
        [id, runId, key, JSON.stringify(manifest)],
      );
      await this.repo.event(
        db,
        runId,
        "source.upstream-attached",
        { id, key, provider: manifest.provider },
        userId,
      );
    });
    return { id, status: "pending_verification" };
  }
  async removeUpstream(userId: string, runId: string) {
    return this.repo.transaction(async (db) => {
      await this.mutableSources(db, userId, runId);
      const result = await db.query(
        `UPDATE ${this.t("upstream_sources")} SET active=false WHERE run_id=$1 AND active RETURNING id`,
        [runId],
      );
      await this.repo.event(
        db,
        runId,
        "source.upstream-detached",
        { removedCount: result.rowCount },
        userId,
      );
      return { removedCount: result.rowCount };
    });
  }
  async sources(
    userId: string,
    runId: string,
    db = this.repo.pool as import("../infrastructure/repository.js").Queryable,
  ) {
    const run = await this.repo.own(db, userId, runId);
    const snapshot = (
      await db.query(
        `SELECT configuration FROM ${this.t("source_snapshots")} WHERE run_id=$1 AND status='ready' ORDER BY completed_at DESC,id LIMIT 1`,
        [runId],
      )
    ).rows[0];
    const config = manualIntegrationSchema.parse(
      snapshot?.configuration ?? run.configuration,
    );
    const files = (
      await db.query(
        `SELECT * FROM ${this.t("source_files")} WHERE run_id=$1 AND active ORDER BY source_code`,
        [runId],
      )
    ).rows;
    const upstream =
      (
        await db.query(
          `SELECT * FROM ${this.t("upstream_sources")} WHERE run_id=$1 AND active`,
          [runId],
        )
      ).rows[0] ?? null;
    const required: string[] = [...sourceCodes];
    if (!upstream)
      for (const cycle of config.expectedCycles)
        required.push(`308_${cycle}`, `318_${cycle}`);
    const missing = required.filter(
      (code) => !files.some((f) => f.source_code === code),
    );
    return {
      valid: !missing.length,
      required: required.map((code) => ({
        code,
        fileName: expectedName(code),
      })),
      missing,
      files: files.filter((f) => required.includes(f.source_code)),
      upstream,
      config,
      run,
    };
  }
  async process(userId: string, runId: string) {
    return this.repo.transaction(async (db) => {
      await this.mutableSources(db, userId, runId);
      const source = await this.sources(userId, runId, db);
      if (source.config.preparationMode === "native_sources")
        throw new AppError(
          409,
          "PREPAID_NATIVE_WORKSPACE_REQUIRED",
          "Use workspace upload/prepare for native sources; run-scoped external ingestion is not configured.",
        );
      if (!source.valid)
        throw new AppError(
          400,
          "PREPAID_SOURCE_INCOMPLETE",
          "Upload the missing source files or attach verified upstream billing results.",
          { missing: source.missing.join(",") },
        );
      const snapshotId = randomUUID(),
        jobId = randomUUID();
      await db.query(
        `INSERT INTO ${this.t("source_snapshots")}(id,run_id,status,source_files,upstream_source,configuration) VALUES($1,$2,'pending',$3,$4,$5)`,
        [
          snapshotId,
          runId,
          JSON.stringify(source.files),
          source.upstream ? JSON.stringify(source.upstream) : null,
          JSON.stringify(source.config),
        ],
      );
      await db.query(
        `INSERT INTO ${this.t("jobs")}(id,run_id,kind,payload,status,execution_name) VALUES($1,$2,'ingest',$3,'queued',$4)`,
        [
          jobId,
          runId,
          JSON.stringify({ snapshotId }),
          `prepaid-ingest-${jobId}`,
        ],
      );
      await this.repo.event(
        db,
        runId,
        "ingestion.queued",
        { snapshotId },
        userId,
        undefined,
        jobId,
      );
      return { id: jobId, snapshotId, status: "queued" };
    });
  }
  async layout(userId: string, runId: string, region: Region) {
    await this.repo.own(this.repo.pool, userId, runId);
    const revision = await this.repo.revision(this.repo.pool, runId, region);
    const rows = (
      await this.repo.pool.query(
        `SELECT * FROM ${this.t("layout_rows")} WHERE revision_id=$1 ORDER BY layout_number`,
        [revision.id],
      )
    ).rows;
    const validation =
      (
        await this.repo.pool.query(
          `SELECT * FROM ${this.t("validation_results")} WHERE revision_id=$1`,
          [revision.id],
        )
      ).rows[0] ?? null;
    const sourcePolicy = revision.imported
      ? (
          await this.repo.pool.query(
            `SELECT configuration->>'sourceSplitPolicy' policy FROM ${this.t("source_snapshots")} WHERE id=$1`,
            [revision.source_snapshot_id],
          )
        ).rows[0]?.policy
      : null;
    let sourcesCurrent = false;
    if (revision.imported) {
      try {
        await this.assertCurrentSources(
          this.repo.pool,
          userId,
          runId,
          revision.source_snapshot_id,
        );
        sourcesCurrent = true;
      } catch (error) {
        if (!(error instanceof AppError) || error.status !== 409) throw error;
      }
    }
    return {
      ...revision,
      frozen: revision.status === "frozen",
      rows: rows.map((row) => ({
        ...row,
        editable_fields: !row.editable
          ? []
          : sourcePolicy === "legacy_eg_total" &&
              region === "eg" &&
              [8, 9, 10].includes(row.layout_number)
            ? ["hy_mt_gross", "gp_bb_gross"]
            : ["gp_mt_gross", "hy_mt_gross", "gp_bb_gross"],
      })),
      validation,
      canEdit: true,
      canFreeze:
        sourcesCurrent &&
        revision.status === "draft" &&
        revision.imported &&
        validation?.valid === true,
    };
  }
  async command(
    userId: string,
    runId: string,
    region: Region,
    action: "import" | "reset" | "validate",
    version: number,
  ) {
    await this.repo.transaction(async (db) => {
      await this.repo.own(db, userId, runId, true);
      const rev = await this.repo.revision(db, runId, region, true);
      this.repo.checkVersion(rev, version);
      if (action === "validate")
        await this.assertCurrentSources(
          db,
          userId,
          runId,
          rev.source_snapshot_id,
        );
      if (action === "import") {
        const snapshot = (
          await db.query(
            `SELECT id FROM ${this.t("source_snapshots")} WHERE run_id=$1 AND status='ready' ORDER BY completed_at DESC LIMIT 1`,
            [runId],
          )
        ).rows[0];
        if (!snapshot)
          throw new AppError(
            409,
            "PREPAID_SOURCE_NOT_READY",
            "Complete source ingestion before importing.",
          );
        await this.assertCurrentSources(db, userId, runId, snapshot.id);
        await db.query(
          `SELECT ${this.repo.schema}.prepaid_import_layout($1,$2)`,
          [rev.id, snapshot.id],
        );
        await db.query(
          `SELECT ${this.repo.schema}.prepaid_capture_source_totals($1)`,
          [rev.id],
        );
      } else
        await db.query(
          `SELECT ${this.repo.schema}.${action === "reset" ? "prepaid_reset_layout" : "prepaid_build_outputs"}($1)`,
          [rev.id],
        );
      await this.repo.event(db, runId, `layout.${action}`, {}, userId, rev.id);
    });
    return this.layout(userId, runId, region);
  }
  async save(
    userId: string,
    runId: string,
    region: Region,
    input: z.infer<typeof editSchema>,
  ) {
    await this.repo.transaction(async (db) => {
      await this.repo.own(db, userId, runId, true);
      const rev = await this.repo.revision(db, runId, region, true);
      this.repo.checkVersion(rev, input.version);
      await this.assertCurrentSources(
        db,
        userId,
        runId,
        rev.source_snapshot_id,
      );
      const policy = (
        await db.query(
          `SELECT configuration->>'sourceSplitPolicy' policy FROM ${this.t("source_snapshots")} WHERE id=$1`,
          [rev.source_snapshot_id],
        )
      ).rows[0]?.policy;
      if (
        region === "eg" &&
        policy === "legacy_eg_total" &&
        input.changes.some(
          (c) =>
            [8, 9, 10].includes(c.layoutNumber) && c.field === "gp_mt_gross",
        )
      )
        throw new AppError(
          409,
          "PREPAID_SPLIT_REMAINDER_READ_ONLY",
          "GP MT is derived from the original source total under the selected legacy split policy. Edit HY MT or GP BB instead.",
        );
      await db.query(
        `SELECT ${this.repo.schema}.prepaid_save_layout_cells($1,$2,$3,$4)`,
        [rev.id, userId, input.reason, JSON.stringify(input.changes)],
      );
      await db.query(
        `SELECT ${this.repo.schema}.prepaid_capture_source_totals($1)`,
        [rev.id],
      );
      await db.query(
        `SELECT ${this.repo.schema}.prepaid_preserve_source_totals($1,$2)`,
        [rev.id, userId],
      );
      await this.repo.event(
        db,
        runId,
        "layout.saved",
        { reason: input.reason, changes: input.changes },
        userId,
        rev.id,
      );
      await db.query(`SELECT ${this.repo.schema}.prepaid_build_outputs($1)`, [
        rev.id,
      ]);
    });
    return this.layout(userId, runId, region);
  }
  async edit(
    userId: string,
    runId: string,
    region: Region,
    version: number,
    reason: string,
  ) {
    await this.repo.transaction(async (db) => {
      await this.repo.own(db, userId, runId, true);
      const previous = await this.repo.revision(db, runId, region, true);
      await this.assertCurrentSources(
        db,
        userId,
        runId,
        previous.source_snapshot_id,
      );
      await this.openDraft(db, userId, runId, region, version, reason);
    });
    return this.layout(userId, runId, region);
  }
  private async openDraft(
    db: PoolClient,
    userId: string,
    runId: string,
    region: Region,
    version: number,
    reason: string,
  ) {
    const previous = await this.repo.revision(db, runId, region, true);
    this.repo.checkVersion(previous, version);
    if (previous.status === "draft") return;
    const id = randomUUID();
    const deliveries = await db.query(
      `SELECT d.* FROM ${this.t("deliveries")} d WHERE revision_id=$1 FOR UPDATE`,
      [previous.id],
    );
    for (const d of deliveries.rows) {
      // Only an unclaimed, never-started outbox job can be cancelled safely.
      const cancelled = await db.query(
        `UPDATE ${this.t("jobs")} SET status='cancelled',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE payload->>'deliveryId'=$1 AND execution_arn IS NULL AND phase='initial' AND status IN('queued','waiting') AND (lease_until IS NULL OR lease_until<now()) RETURNING id`,
        [d.id],
      );
      if (cancelled.rowCount)
        await db.query(
          `UPDATE ${this.t("deliveries")} SET status='cancelled' WHERE id=$1`,
          [d.id],
        );
    }
    await db.query(
      `INSERT INTO ${this.t("region_revisions")}(id,run_id,region,revision,status,source_snapshot_id,predecessor_id,imported,tax_rate) VALUES($1,$2,$3,$4,'draft',$5,$6,$7,$8)`,
      [
        id,
        runId,
        region,
        previous.revision + 1,
        previous.source_snapshot_id,
        previous.id,
        previous.imported,
        previous.tax_rate,
      ],
    );
    await db.query(
      `INSERT INTO ${this.t("layout_rows")} SELECT $1,layout_number,label,tier,editable,gp_mt_gross,hy_mt_gross,gp_bb_gross,total_gross,gp_mt_net,hy_mt_net,gp_bb_net,total_net FROM ${this.t("layout_rows")} WHERE revision_id=$2`,
      [id, previous.id],
    );
    if (previous.imported)
      await db.query(
        `SELECT ${this.repo.schema}.prepaid_capture_source_totals($1)`,
        [id],
      );
    await db.query(`SELECT ${this.repo.schema}.prepaid_build_outputs($1)`, [
      id,
    ]);
    await this.repo.event(
      db,
      runId,
      "layout.edit-opened",
      { predecessorId: previous.id, reason },
      userId,
      id,
    );
  }
  async resetWorkspace(
    userId: string,
    runId: string,
    versions: { eg: number; sg: number },
    beforeReset?: (db: PoolClient) => Promise<void>,
  ) {
    await this.repo.transaction(async (db) => {
      if (beforeReset) {
        await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `prepaid.workspace.${userId}`,
        ]);
        await beforeReset(db);
      }
      await this.repo.own(db, userId, runId, true);
      const pending = await db.query(
        `SELECT 1 FROM ${this.t("source_snapshots")} WHERE run_id=$1 AND status='pending'`,
        [runId],
      );
      if (pending.rowCount)
        throw new AppError(
          409,
          "PREPAID_INGESTION_RUNNING",
          "Wait for ingestion before resetting the workspace.",
        );
      for (const region of ["eg", "sg"] as const) {
        await this.openDraft(
          db,
          userId,
          runId,
          region,
          versions[region],
          "Workspace reset",
        );
        const revision = await this.repo.revision(db, runId, region, true);
        await db.query(`SELECT ${this.repo.schema}.prepaid_reset_layout($1)`, [
          revision.id,
        ]);
      }
      await db.query(
        `UPDATE ${this.t("source_files")} SET active=false WHERE run_id=$1 AND active`,
        [runId],
      );
      await db.query(
        `UPDATE ${this.t("upstream_sources")} SET active=false WHERE run_id=$1 AND active`,
        [runId],
      );
      await this.repo.event(db, runId, "workspace.reset", {}, userId);
    });
    return this.get(userId, runId);
  }
  async freeze(userId: string, runId: string, region: Region, version: number) {
    return this.repo.transaction(async (db) => {
      const run = await this.repo.own(db, userId, runId, true);
      const rev = await this.repo.revision(db, runId, region, true);
      this.repo.checkVersion(rev, version);
      await this.assertCurrentSources(
        db,
        userId,
        runId,
        rev.source_snapshot_id,
      );
      const snapshot = (
        await db.query(
          `SELECT configuration FROM ${this.t("source_snapshots")} WHERE id=$1`,
          [rev.source_snapshot_id],
        )
      ).rows[0];
      const config = manualIntegrationSchema.parse(snapshot.configuration);
      await db.query(
        `SELECT ${this.repo.schema}.prepaid_freeze_layout($1,$2)`,
        [rev.id, userId],
      );
      await db.query(
        `INSERT INTO ${this.t("frozen_report_formats")}(revision_id,format) VALUES($1,$2)`,
        [rev.id, JSON.stringify(config.format)],
      );
      await this.repo.event(
        db,
        runId,
        "layout.frozen",
        { revision: rev.revision, mode: "manual" },
        userId,
        rev.id,
      );
      return { revisionId: rev.id, status: "staged", canEdit: true };
    });
  }

  async output(
    userId: string,
    runId: string,
    region: Region,
    kind: "allocations" | "reconciliation_rows" | "jv_lines",
    variant?: string,
    limit = 100,
    offset = 0,
    revisionId?: string,
  ) {
    await this.repo.own(this.repo.pool, userId, runId);
    const rev = revisionId
      ? (
          await this.repo.pool.query(
            `SELECT * FROM ${this.t("region_revisions")} WHERE id=$1 AND run_id=$2 AND region=$3`,
            [revisionId, runId, region],
          )
        ).rows[0]
      : await this.repo.revision(this.repo.pool, runId, region);
    if (!rev)
      throw new AppError(
        404,
        "PREPAID_REVISION_NOT_FOUND",
        "Revision not found.",
      );
    const filter = variant ? "AND variant=$4" : "";
    const order =
      kind === "reconciliation_rows"
        ? "revenue_type,allocation_type,tax_rate"
        : "id";
    const result = await this.repo.pool.query(
      `SELECT *,count(*) OVER() total_count FROM ${this.t(kind)} WHERE revision_id=$1 ${filter} ORDER BY ${order} LIMIT $2 OFFSET $3`,
      variant ? [rev.id, limit, offset, variant] : [rev.id, limit, offset],
    );
    const total =
      result.rows[0]?.total_count ??
      (
        await this.repo.pool.query(
          `SELECT count(*) total FROM ${this.t(kind)} WHERE revision_id=$1 ${variant ? "AND variant=$2" : ""}`,
          variant ? [rev.id, variant] : [rev.id],
        )
      ).rows[0].total;
    return {
      revisionId: rev.id,
      status: rev.status,
      rows: result.rows,
      limit,
      offset,
      total: Number(total),
    };
  }
  async referenceMembership(
    userId: string,
    runId: string,
    region: Region,
    mode: "all" | "gp-non-bb",
    limit = 100,
    offset = 0,
    revisionId?: string,
  ) {
    const selected = await this.output(
      userId,
      runId,
      region,
      "allocations",
      undefined,
      1,
      0,
      revisionId,
    );
    const revision = (
      await this.repo.pool.query(
        `SELECT * FROM ${this.t("region_revisions")} WHERE id=$1`,
        [selected.revisionId],
      )
    ).rows[0];
    const evidence = (
      await this.repo.pool.query(
        `SELECT count(*)::int total,count(*) FILTER(WHERE nullif(trim(data->>'source_brand'),'') IS NULL)::int unknown FROM ${this.t("stage_reference")} WHERE snapshot_id=$1`,
        [revision.source_snapshot_id],
      )
    ).rows[0];
    if (!evidence.total || evidence.unknown)
      return {
        revisionId: selected.revisionId,
        mode,
        complete: false,
        reason: "REFERENCE_MEMBERSHIP_SOURCE_BRAND_UNVERIFIED",
        unknownRows: evidence.unknown,
        total: 0,
        rows: [] as Record<string, unknown>[],
        limit,
        offset,
      };
    const table = mode === "all" ? "membership_report" : "membership_report_v2";
    const rows = (
      await this.repo.pool.query(
        `SELECT * FROM ${this.t(table)} WHERE revision_id=$1 ORDER BY revenue_type,sub_product,cost_element ${mode === "all" ? ",id" : ""} LIMIT $2 OFFSET $3`,
        [selected.revisionId, limit, offset],
      )
    ).rows;
    const total = Number(
      (
        await this.repo.pool.query(
          `SELECT count(*) n FROM ${this.t(table)} WHERE revision_id=$1`,
          [selected.revisionId],
        )
      ).rows[0].n,
    );
    return {
      revisionId: selected.revisionId,
      mode,
      complete: true,
      reason: null,
      unknownRows: 0,
      total,
      rows,
      limit,
      offset,
    };
  }
  async allocationSummary(
    userId: string,
    runId: string,
    region: Region,
    variant: "mt" | "bb",
    revisionId?: string,
  ) {
    const output = await this.output(
      userId,
      runId,
      region,
      "reconciliation_rows",
      undefined,
      1,
      0,
      revisionId,
    );
    const rows = await this.repo.pool.query(
      `
      WITH detail AS (
        SELECT revenue_type,allocation_type,tax_rate,gross,amount,tax_amount,total_gross,difference,
          CASE WHEN allocation_type='' THEN revenue_type ELSE allocation_type END label
        FROM ${this.t("reconciliation_rows")} r WHERE revision_id=$1
        AND EXISTS(SELECT 1 FROM ${this.t("allocations")} a WHERE a.revision_id=r.revision_id AND a.revenue_type=r.revenue_type AND a.allocation_type=r.allocation_type AND a.tax_rate=r.tax_rate AND a.variant=$2)
      ), combined AS (
        SELECT replace(label,'_',' ') AS type, CASE WHEN row_number() OVER(PARTITION BY label ORDER BY tax_rate)=1 THEN gross END AS gross, tax_rate*100 AS tax_rate, amount, tax_amount AS vat_oct,total_gross,NULL::numeric AS difference, label AS sort_label,0 AS sort_kind FROM detail
        UNION ALL
        SELECT replace(label,'_',' ')||' Difference',max(gross),0,NULL,NULL,sum(total_gross),max(gross)-sum(total_gross),label,1 FROM detail GROUP BY label
        UNION ALL
        SELECT 'Posting Key '||posting_key,NULL,0,sum(abs(round(amount2,2))),NULL,NULL,NULL,'ZZ'||posting_key,2
        FROM ${this.t("allocations")} WHERE revision_id=$1 AND variant=$2 AND abs(round(amount2,2))>=0.01 GROUP BY posting_key
      ) SELECT type,gross,tax_rate,amount,vat_oct,total_gross,difference FROM combined ORDER BY sort_label,sort_kind,tax_rate`,
      [output.revisionId, variant],
    );
    return { revisionId: output.revisionId, rows: rows.rows };
  }
  async reportHistory(
    userId: string,
    date: string | undefined,
    limit: number,
    offset: number,
  ) {
    const result = await this.repo.pool.query(
      `
      WITH grouped AS (
        SELECT r.id AS run_id,r.period,s.id AS snapshot_id,
          COALESCE((SELECT max((f->>'created_at')::timestamptz) FROM jsonb_array_elements(s.source_files) f),s.created_at) AS uploaded_at,
          COALESCE(NULLIF(u.display_name,''),u.email) AS uploaded_by,
          jsonb_agg(jsonb_build_object('id',v.id,'region',v.region,'revision',v.revision,'frozen_at',v.frozen_at,
            'exports',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',e.id,'kind',e.kind)) FROM ${this.t("exports")} e WHERE e.revision_id=v.id),'[]'::jsonb)) ORDER BY v.region,v.revision) AS revisions
        FROM ${this.t("runs")} r JOIN ${this.repo.schema}.workspaces w ON w.id=r.workspace_id
        JOIN ${this.t("region_revisions")} v ON v.run_id=r.id AND v.status IN ('frozen','superseded')
        JOIN ${this.t("source_snapshots")} s ON s.id=v.source_snapshot_id
        JOIN ${this.repo.schema}.app_user u ON u.id=w.user_id
        WHERE w.user_id=$1 GROUP BY r.id,s.id,u.display_name,u.email
      ) SELECT *,count(*) OVER() AS total_count FROM grouped
        WHERE ($2::date IS NULL OR (uploaded_at AT TIME ZONE 'Asia/Singapore')::date=$2::date)
        ORDER BY uploaded_at DESC,snapshot_id LIMIT $3 OFFSET $4`,
      [userId, date ?? null, limit, offset],
    );
    return {
      rows: result.rows,
      limit,
      offset,
      hasMore: result.rows.length === limit,
    };
  }
  async history(userId: string, runId: string) {
    await this.repo.own(this.repo.pool, userId, runId);
    return (
      await this.repo.pool.query(
        `SELECT * FROM ${this.t("events")} WHERE run_id=$1 ORDER BY id DESC LIMIT 1000`,
        [runId],
      )
    ).rows;
  }
  async exports(userId: string, runId: string) {
    await this.repo.own(this.repo.pool, userId, runId);
    return (
      await this.repo.pool.query(
        `SELECT e.* FROM ${this.t("exports")} e JOIN ${this.t("region_revisions")} r ON r.id=e.revision_id WHERE r.run_id=$1 ORDER BY e.created_at DESC`,
        [runId],
      )
    ).rows;
  }
  async download(userId: string, runId: string, exportId: string) {
    const record = (await this.exports(userId, runId)).find(
      (x) => x.id === exportId,
    );
    if (!record)
      throw new AppError(
        404,
        "PREPAID_EXPORT_NOT_FOUND",
        "Export not found in this run.",
      );
    return this.storage.get(record.object_key, this.storage.prefix(runId));
  }
  async retry(userId: string, runId: string, jobId: string) {
    return this.repo.transaction(async (db) => {
      await this.repo.own(db, userId, runId, true);
      const job = (
        await db.query(
          `SELECT * FROM ${this.t("jobs")} WHERE id=$1 AND run_id=$2 FOR UPDATE`,
          [jobId, runId],
        )
      ).rows[0];
      if (!job || job.status !== "failed" || job.kind === "ingest")
        throw new AppError(
          409,
          "PREPAID_JOB_NOT_RETRYABLE",
          "Only a delivery failure with a confirmed outcome can be retried. Failed ingestion requires a new processing attempt.",
        );
      const delivery = (
        await db.query(
          `SELECT * FROM ${this.t("deliveries")} WHERE id=$1 FOR UPDATE`,
          [job.payload.deliveryId],
        )
      ).rows[0];
      const slot = (
        await db.query(
          `SELECT * FROM ${this.t("delivery_slots")} WHERE target=$1 AND period=$2 AND region=$3 FOR UPDATE`,
          [delivery.target, delivery.period, delivery.region],
        )
      ).rows[0];
      if (!delivery.correction && slot.last_delivery_id !== delivery.id)
        throw new AppError(
          409,
          "PREPAID_DELIVERY_SUPERSEDED",
          "A newer revision replaced this failed initial posting. Retry the current posting instead.",
        );
      let phase = job.phase;
      const payload = { ...job.payload };
      if (job.execution_arn || phase.endsWith("starting")) {
        if (job.error?.code !== "CONFIRMED_NOT_DELIVERED")
          throw new AppError(
            409,
            "PREPAID_DELIVERY_RECONCILE_REQUIRED",
            "Confirm the remote outcome before sending another copy.",
          );
        const kind = phase.startsWith("reversal") ? "reversal" : "replacement";
        phase = `${kind}-ready`;
        payload[`${kind}Attempt`] = (payload[`${kind}Attempt`] ?? 0) + 1;
        delete payload.executionInput;
        delete payload.receiptOverrideKey;
      }
      await db.query(
        `UPDATE ${this.t("deliveries")} SET status='queued' WHERE id=$1`,
        [delivery.id],
      );
      await db.query(
        `UPDATE ${this.t("jobs")} SET status='queued',phase=$2,payload=$3,execution_arn=NULL,error=NULL,available_at=now(),lease_until=NULL,updated_at=now() WHERE id=$1`,
        [jobId, phase, JSON.stringify(payload)],
      );
      await this.repo.event(
        db,
        runId,
        "job.retry-requested",
        {},
        userId,
        job.revision_id,
        jobId,
      );
      return { id: jobId, status: "queued" };
    });
  }
  async reconcile(
    userId: string,
    runId: string,
    jobId: string,
    receiptKey?: string,
  ) {
    return this.repo.transaction(async (db) => {
      await this.repo.own(db, userId, runId, true);
      const job = (
        await db.query(
          `SELECT * FROM ${this.t("jobs")} WHERE id=$1 AND run_id=$2 FOR UPDATE`,
          [jobId, runId],
        )
      ).rows[0];
      if (!job || job.kind !== "delivery" || job.status !== "unknown")
        throw new AppError(
          409,
          "PREPAID_RECONCILIATION_NOT_REQUIRED",
          "Only an unknown delivery outcome can be reconciled.",
        );
      if (receiptKey)
        this.storage.assertKey(
          receiptKey,
          `${this.storage.prefix(runId)}receipts/${job.payload.deliveryId}/`,
        );
      const payload = {
        ...job.payload,
        ...(receiptKey ? { receiptOverrideKey: receiptKey } : {}),
      };
      await db.query(
        `UPDATE ${this.t("jobs")} SET status='waiting',payload=$2,error=NULL,available_at=now(),lease_until=NULL,attempts=0,updated_at=now() WHERE id=$1`,
        [jobId, JSON.stringify(payload)],
      );
      await this.repo.event(
        db,
        runId,
        "job.reconciliation-requested",
        { receiptKey },
        userId,
        job.revision_id,
        jobId,
      );
      return { id: jobId, status: "waiting" };
    });
  }
  private async assertCurrentSources(
    db: import("../infrastructure/repository.js").Queryable,
    userId: string,
    runId: string,
    snapshotId: string | null,
  ) {
    const snapshot = (
      await db.query(
        `SELECT * FROM ${this.t("source_snapshots")} WHERE id=$1 AND run_id=$2 AND status='ready'`,
        [snapshotId, runId],
      )
    ).rows[0];
    const session = (
      await db.query(
        `SELECT s.* FROM ${this.t("upload_sessions")} s JOIN ${this.repo.schema}.workspaces w ON w.id=s.workspace_id WHERE w.user_id=$1 AND s.active`,
        [userId],
      )
    ).rows[0];
    if (snapshot?.manifest?.contractVersion === 2 || session) {
      const context = (
        await db.query(
          `SELECT * FROM ${this.t("snapshot_context")} WHERE snapshot_id=$1`,
          [snapshotId],
        )
      ).rows[0];
      const files = session
        ? (
            await db.query(
              `SELECT id,sha256 FROM ${this.t("session_files")} WHERE session_id=$1 AND active`,
              [session.id],
            )
          ).rows
        : [];
      if (
        !context ||
        !session ||
        session.run_id !== runId ||
        session.status !== "ready" ||
        context.session_id !== session.id ||
        context.source_version !== session.version ||
        files.length !== snapshot?.source_files.length ||
        !files.every((f) =>
          snapshot.source_files.some(
            (s: { id: string; sha256: string }) =>
              s.id === f.id && s.sha256 === f.sha256,
          ),
        )
      )
        throw new AppError(
          409,
          "PREPAID_SOURCE_STALE",
          "The reviewed inputs no longer match the active upload session. Complete fresh preparation before reviewing or freezing.",
        );
    }
    const current = await this.sources(userId, runId, db);
    const latest = (
      await db.query(
        `SELECT id FROM ${this.t("source_snapshots")} WHERE run_id=$1 AND status='ready' ORDER BY completed_at DESC LIMIT 1`,
        [runId],
      )
    ).rows[0];
    const sameFiles =
      snapshot &&
      snapshot.source_files.length === current.files.length &&
      current.files.every((f) =>
        snapshot.source_files.some(
          (s: { id: string; sha256: string }) =>
            s.id === f.id && s.sha256 === f.sha256,
        ),
      );
    if (
      !current.valid ||
      latest?.id !== snapshotId ||
      !sameFiles ||
      (snapshot.upstream_source?.id ?? null) !== (current.upstream?.id ?? null)
    )
      throw new AppError(
        409,
        "PREPAID_SOURCE_STALE",
        "The imported snapshot no longer matches the active sources. Process and import the new inputs before freezing.",
      );
    if (
      (
        await db.query(
          `SELECT 1 FROM ${this.t("source_snapshots")} WHERE run_id=$1 AND status='pending' UNION ALL SELECT 1 FROM ${this.t("upload_sessions")} WHERE run_id=$1 AND active AND status='pending'`,
          [runId],
        )
      ).rowCount
    )
      throw new AppError(
        409,
        "PREPAID_INGESTION_RUNNING",
        "Wait for source ingestion before importing or freezing.",
      );
  }
}
