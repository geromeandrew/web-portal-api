import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sha256 } from "../infrastructure/prepaidStorage.js";
import type { PoolClient } from "pg";
import { AppError } from "../../../errors.js";
import { prepaidMaximumSourceBytes } from "../domain/limits.js";
import {
  expectedName,
  sourceCodes,
  manualIntegrationSchema,
  requiredBillingSources,
  matchesSourceName,
  sourceFileRequirement,
  prepaidBatchBillCycles,
} from "../domain/contracts.js";
import type { PrepaidFullBatch } from "./fullBatch.js";
import { PrepaidRunService } from "./runService.js";
import {
  sourceWorkflows,
  selectedSourceWorkflows,
  unprovidedExtractionDependencies,
} from "../domain/sourceExtraction.js";
import {
  isUploadCollection,
  uploadCollectionConfiguration,
  uploadCollectionMessage,
  uploadCollectionSources,
  uploadCollectionGuidelines,
} from "../domain/uploadCollection.js";

/** Upload ownership exists before a financial period/run is known. */
export class PrepaidWorkspaceService {
  constructor(readonly runs: PrepaidRunService, readonly fullBatch?: PrepaidFullBatch) {}
  private t = (name: string) => this.runs.repo.table(name);
  async extractions(userId: string) {
    const repo = this.runs.repo;
    const rows = await repo.pool.query(
      `SELECT x.workflow,x.status,x.execution_arn,x.receipt,x.error,x.created_at,x.completed_at,
      p.id preparation_id,p.source_version FROM ${this.t("source_extractions")} x
      JOIN ${this.t("preparation_jobs")} p ON p.id=x.preparation_id
      JOIN ${this.t("upload_sessions")} s ON s.id=p.session_id
      JOIN ${repo.schema}.workspaces w ON w.id=s.workspace_id
      WHERE w.user_id=$1 AND s.active ORDER BY p.created_at,x.workflow`,
      [userId],
    );
    const preparation =
      (
        await repo.pool.query(
          `SELECT p.id,p.status,p.error,p.source_version,p.available_at,p.lease_until,p.created_at,s.configuration->'sourceExtraction' source_settings
         FROM ${this.t("preparation_jobs")} p JOIN ${this.t("upload_sessions")} s ON s.id=p.session_id
         JOIN ${repo.schema}.workspaces w ON w.id=s.workspace_id
         WHERE w.user_id=$1 AND s.active ORDER BY p.created_at DESC LIMIT 1`,
          [userId],
        )
      ).rows[0] ?? null;
    const expectedWorkflows = preparation?.source_settings
      ? selectedSourceWorkflows(preparation.source_settings)
      : [];
    if (preparation) delete preparation.source_settings;
    return {
      workflows: sourceWorkflows,
      expectedWorkflows,
      executions: rows.rows,
      preparation,
      remainingDependencies: unprovidedExtractionDependencies,
    };
  }
  private async lock(db: PoolClient, userId: string) {
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `prepaid.workspace.${userId}`,
    ]);
  }
  private required(configuration: unknown) {
    if (this.fullBatch)
      return [...sourceCodes, ...prepaidBatchBillCycles.flatMap((cycle) => [`308_${cycle}`, `318_${cycle}`])]
        .map(sourceFileRequirement);
    if (isUploadCollection(configuration))
      return sourceCodes.map(sourceFileRequirement);
    const config = manualIntegrationSchema.parse(configuration);
    return [...sourceCodes, ...requiredBillingSources(config)].map(
      sourceFileRequirement,
    );
  }
  private accepted(configuration: unknown) {
    if (this.fullBatch) return this.required(configuration);
    return isUploadCollection(configuration)
      ? uploadCollectionSources()
      : this.required(configuration);
  }
  private preparation(configuration: unknown) {
    if (this.fullBatch) return { configured: true, message: null };
    return {
      configured: !isUploadCollection(configuration),
      message: isUploadCollection(configuration)
        ? uploadCollectionMessage
        : null,
    };
  }
  async state(userId: string) {
    const repo = this.runs.repo;
    const session =
      (
        await repo.pool.query(
          `SELECT s.* FROM ${this.t("upload_sessions")} s JOIN ${repo.schema}.workspaces w ON w.id=s.workspace_id WHERE w.user_id=$1 AND s.active`,
          [userId],
        )
      ).rows[0] ?? null;
    if (session) {
      const files = (
        await repo.pool.query(
          `SELECT * FROM ${this.t("session_files")} WHERE session_id=$1 AND active ORDER BY source_code`,
          [session.id],
        )
      ).rows;
      const required = this.required(session.configuration);
      const missing = this.fullBatch ? [] : required
        .filter((x) => !files.some((f) => f.source_code === x.code))
        .map((x) => x.code);
      const collectionOnly = !this.fullBatch && isUploadCollection(session.configuration);
      const unexpected = collectionOnly
        ? []
        : files
            .filter((f) => !required.some((x) => x.code === f.source_code))
            .map((f) => f.source_code);
      // A source change hides the review run, but Reset still needs its
      // versioned regional context. Do not discard that context with the UI.
      const runId = session.run_id as string | null;
      const [resetContext, run] = await Promise.all([
        runId
          ? Promise.all([
              repo.revision(repo.pool, runId, "eg"),
              repo.revision(repo.pool, runId, "sg"),
            ]).then(([eg, sg]) => ({ runId, eg: eg.version, sg: sg.version }))
          : null,
        session.status === "ready" && runId ? this.runs.get(userId, runId) : null,
      ]);
      let error: string | null = session.error ?? null;
      if (
        session.status === "failed" &&
        error?.includes("EG_REPORT_MAPPING_REQUIRED")
      ) {
        const approved = (await this.runs.availableIntegration())
          ?.sourceExtraction?.egReportMapping;
        const pinned = session.configuration?.sourceExtraction?.egReportMapping;
        if (
          approved?.approved &&
          approved.callcardScope === "eg_report" &&
          approved.loadupAmount &&
          (!pinned?.callcardScope || !pinned?.loadupAmount)
        ) {
          error =
            "The EG report mappings are now configured, but this failed upload session still uses its earlier settings. Reset the workspace, then upload the complete file set again. Original stored files and frozen reports are retained.";
        }
      }
      return {
        session,
        resetContext,
        run,
        sources: {
          required,
          accepted: this.accepted(session.configuration),
          collectionOnly,
          ...(collectionOnly && !this.fullBatch
            ? { guidelines: uploadCollectionGuidelines() }
            : {}),
          unexpected,
          files,
          missing,
          valid: this.fullBatch ? files.length > 0 : !collectionOnly && !missing.length && !unexpected.length,
          upstream: null,
        },
        preparation: this.preparation(session.configuration),
        error:
          error ??
          (unexpected.length
            ? `These uploaded sources are outside the approved cycle coverage: ${unexpected.join(", ")}. Remove them before preparation; no file was silently discarded.`
            : null),
      };
    }
    // Adopt old selected runs read-only; viewing never creates a session/run.
    try {
      const id = await this.runs.active(userId);
      const [run, sources] = await Promise.all([
        this.runs.get(userId, id),
        this.runs.sources(userId, id),
      ]);
      return { session: null, run, sources, error: null };
    } catch (e) {
      if (!(e instanceof AppError) || e.code !== "PREPAID_RUN_REQUIRED")
        throw e;
    }
    const configuration =
      (await this.runs.availableIntegration()) ?? uploadCollectionConfiguration;
    const required = this.required(configuration);
    return {
      session: null,
      run: null,
      sources: {
        required,
        accepted: this.accepted(configuration),
        collectionOnly: !this.fullBatch && isUploadCollection(configuration),
        ...(isUploadCollection(configuration) && !this.fullBatch
          ? { guidelines: uploadCollectionGuidelines() }
          : {}),
        unexpected: [],
        missing: this.fullBatch ? [] : required.map((x) => x.code),
        files: [],
        valid: false,
        upstream: null,
      },
      preparation: this.preparation(configuration),
      error: null,
    };
  }
  private async session(db: PoolClient, userId: string, create: boolean) {
    await this.lock(db, userId);
    const existing = (
      await db.query(
        `SELECT s.* FROM ${this.t("upload_sessions")} s JOIN ${this.runs.repo.schema}.workspaces w ON w.id=s.workspace_id WHERE w.user_id=$1 AND s.active FOR UPDATE OF s`,
        [userId],
      )
    ).rows[0];
    if (existing || !create) return existing ?? null;
    const workspace = await this.runs.repo.workspace(db, userId);
    let session = (
      await db.query(
        `SELECT * FROM ${this.t("upload_sessions")} WHERE workspace_id=$1 AND active FOR UPDATE`,
        [workspace],
      )
    ).rows[0];
    if (!session) {
      const configuration =
        (await this.runs.availableIntegration(db)) ??
        uploadCollectionConfiguration;
      // Existing reviewed/frozen runs must be explicitly reset, not overwritten.
      const current = (
        await db.query(
          `SELECT 1 FROM ${this.t("workspace_selection")} s JOIN ${this.t("region_revisions")} r ON r.run_id=s.run_id WHERE s.workspace_id=$1 AND r.imported LIMIT 1`,
          [workspace],
        )
      ).rowCount;
      if (current)
        throw new AppError(
          409,
          "PREPAID_RESET_REQUIRED",
          "Reset the workspace before uploading a new source set.",
        );
      session = (
        await db.query(
          `INSERT INTO ${this.t("upload_sessions")}(id,workspace_id,configuration) VALUES($1,$2,$3) RETURNING *`,
          [randomUUID(), workspace, JSON.stringify(configuration)],
        )
      ).rows[0];
    }
    return session ?? null;
  }
  private async mutable(db: PoolClient, userId: string, create: boolean, uploadCode?: string) {
    const s = await this.session(db, userId, create);
    if (!s)
      throw new AppError(
        409,
        "PREPAID_SESSION_REQUIRED",
        "Upload source files first.",
      );
    await this.fullBatch?.assertSourceChangeAllowed(db, s.id, uploadCode);
    if (s.status === "pending")
      throw new AppError(
        409,
        "PREPAID_INGESTION_RUNNING",
        "Wait for source preparation before changing inputs.",
      );
    if (s.run_id) {
      await this.runs.repo.own(db, userId, s.run_id, true);
      const latest = await db.query(
        `SELECT DISTINCT ON(region) status FROM ${this.t("region_revisions")} WHERE run_id=$1 ORDER BY region,revision DESC`,
        [s.run_id],
      );
      if (latest.rows.some((r) => r.status !== "draft"))
        throw new AppError(
          409,
          "PREPAID_EDIT_REQUIRED",
          "Edit the frozen regions or Reset before changing source files.",
        );
    }
    return s;
  }
  async upload(
    userId: string,
    code: string,
    file: { originalname: string; buffer: Buffer; mimetype: string },
    uploadId?: string,
  ) {
    if (uploadId !== undefined) z.string().uuid().parse(uploadId);
    if (file.buffer.length > prepaidMaximumSourceBytes)
      throw new AppError(
        413,
        "PREPAID_SOURCE_TOO_LARGE",
        "Prepaid sources must not exceed 100 MiB.",
      );
    if (!file.buffer.length)
      throw new AppError(
        400,
        "PREPAID_EMPTY_FILE",
        "The uploaded file is empty.",
      );
    if (!matchesSourceName(code, file.originalname))
      throw new AppError(
        400,
        "PREPAID_FILE_NAME_INVALID",
        "Use a filename that identifies the report and follows the File Guidelines.",
      );
    if (
      /\.xlsx$/i.test(file.originalname) &&
      file.buffer.subarray(0, 2).toString() !== "PK"
    )
      throw new AppError(
        400,
        "PREPAID_FILE_TYPE_INVALID",
        "Excel inputs must be XLSX workbooks.",
      );
    const id = uploadId ?? randomUUID();
    const digest = uploadId ? sha256(file.buffer) : undefined;
    const replay = async (db: PoolClient) => {
      if (!uploadId) return null;
      const prior = (
        await db.query(
          `SELECT f.*,s.active session_active FROM ${this.t("session_files")} f JOIN ${this.t("upload_sessions")} s ON s.id=f.session_id JOIN ${this.runs.repo.schema}.workspaces w ON w.id=s.workspace_id WHERE f.id=$1 AND w.user_id=$2`,
          [id, userId],
        )
      ).rows[0];
      if (!prior) return null;
      if (
        !prior.active ||
        !prior.session_active ||
        prior.source_code !== code ||
        prior.sha256 !== digest ||
        Number(prior.size_bytes) !== file.buffer.length
      )
        throw new AppError(
          409,
          "PREPAID_UPLOAD_ID_CONFLICT",
          "This upload ID belongs to different bytes or an inactive source. Refresh before retrying.",
        );
      return {
        id: prior.id,
        key: prior.object_key,
        sha256: prior.sha256,
        size: Number(prior.size_bytes),
      };
    };
    const context = await this.runs.repo.transaction(async (db) => {
      if (uploadId) {
        await this.lock(db, userId);
        const prior = await replay(db);
        if (prior) return { prior, session: null };
      }
      const session = await this.mutable(db, userId, true, code);
      if (!this.accepted(session.configuration).some((x) => x.code === code))
        throw new AppError(
          400,
          "PREPAID_SOURCE_NOT_REQUIRED",
          "This source is outside the configured billing-cycle coverage.",
        );
      return { session, prior: null };
    });
    if (context.prior) return context.prior;
    const s = context.session!;
    if (
      !this.accepted(s.configuration).some(
        (x) => x.code === code && matchesSourceName(x.code, file.originalname),
      )
    )
      throw new AppError(
        400,
        "PREPAID_FILE_NAME_INVALID",
        "Use a filename that identifies the report and follows the File Guidelines.",
      );
    if (
      /\.xlsx$/i.test(file.originalname) &&
      file.buffer.subarray(0, 2).toString() !== "PK"
    )
      throw new AppError(
        400,
        "PREPAID_FILE_TYPE_INVALID",
        "Excel inputs must be XLSX workbooks.",
      );
    const key = `${this.runs.storage.sessionPrefix(s.id)}sources/${id}/${expectedName(code)}`;
    const saved = uploadId
      ? await this.runs.storage.putVerified(
          key,
          this.runs.storage.sessionPrefix(s.id),
          file.buffer,
          file.mimetype,
        )
      : await this.runs.storage.put(key, file.buffer, file.mimetype);
    await this.runs.repo.transaction(async (db) => {
      if (uploadId) {
        await this.lock(db, userId);
        if (await replay(db)) return;
      }
      const current = await this.mutable(db, userId, false, code);
      if (current.id !== s.id)
        throw new AppError(
          409,
          "PREPAID_SESSION_CHANGED",
          "The workspace was reset; this upload was not attached.",
        );
      if (
        !this.accepted(current.configuration).some(
          (source) => source.code === code,
        )
      )
        throw new AppError(
          409,
          "PREPAID_SOURCE_COVERAGE_CHANGED",
          "The approved billing-cycle coverage changed while this file uploaded. Refresh the workspace; this file was not attached.",
        );
      await db.query(
        `UPDATE ${this.t("session_files")} SET active=false WHERE session_id=$1 AND source_code=$2 AND active`,
        [s.id, code],
      );
      await db.query(
        `INSERT INTO ${this.t("session_files")}(id,session_id,source_code,original_name,object_key,sha256,size_bytes,uploaded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          id,
          s.id,
          code,
          file.originalname,
          key,
          saved.sha256,
          saved.size,
          userId,
        ],
      );
      await db.query(
        `UPDATE ${this.t("upload_sessions")} SET version=version+1,status='collecting',error=NULL WHERE id=$1`,
        [s.id],
      );
      if (!this.fullBatch) await this.enqueue(db, s.id);
    });
    return { id, ...saved };
  }
  private async enqueue(db: PoolClient, sessionId: string) {
    let s = (
      await db.query(
        `SELECT * FROM ${this.t("upload_sessions")} WHERE id=$1 FOR UPDATE`,
        [sessionId],
      )
    ).rows[0];
    if (s.status === "pending" || (s.status === "ready" && !this.fullBatch)) return false;
    if (isUploadCollection(s.configuration)) {
      const configuration = await this.runs.availableIntegration(db);
      if (!configuration) return false;
      // Bind once, before a preparation job exists. File identity/bytes are kept;
      // a version increment fences the new processing configuration as context.
      s = (
        await db.query(
          `UPDATE ${this.t("upload_sessions")} SET configuration=$2,version=version+1,error=NULL WHERE id=$1 RETURNING *`,
          [sessionId, JSON.stringify(configuration)],
        )
      ).rows[0];
    }
    const files = (
      await db.query(
        `SELECT * FROM ${this.t("session_files")} WHERE session_id=$1 AND active ORDER BY source_code`,
        [sessionId],
      )
    ).rows;
    const required = this.required(s.configuration);
    if (
      files.some((f) => !required.some((x) => x.code === f.source_code)) ||
      !required.every((x) => files.some((f) => f.source_code === x.code))
    )
      return false;
    const attempt = Number(
      (
        await db.query(
          `SELECT coalesce(max(attempt),0)+1 n FROM ${this.t("preparation_jobs")} WHERE session_id=$1 AND source_version=$2`,
          [sessionId, s.version],
        )
      ).rows[0].n,
    );
    const id = randomUUID();
    await db.query(
      `INSERT INTO ${this.t("preparation_jobs")}(id,session_id,source_version,attempt,source_files,execution_name) VALUES($1,$2,$3,$4,$5,$6)`,
      [
        id,
        sessionId,
        s.version,
        attempt,
        JSON.stringify(files),
        `prepaid-prepare-${id}`,
      ],
    );
    await db.query(
      `UPDATE ${this.t("upload_sessions")} SET status='pending',error=NULL WHERE id=$1`,
      [sessionId],
    );
    return true;
  }
  /** Worker-only transition: viewing the workspace never creates jobs/runs.
   * A complete approved config is still mandatory before binding/queuing.
   */
  async resumeCollectingUploads() {
    if (this.fullBatch || !(await this.runs.availableIntegration())) return false;
    const rows = await this.runs.repo.pool.query(
      `SELECT s.id,w.user_id FROM ${this.t("upload_sessions")} s
      JOIN ${this.runs.repo.schema}.workspaces w ON w.id=s.workspace_id
      WHERE s.active AND s.status='collecting' AND s.configuration=$1::jsonb
      ORDER BY s.created_at LIMIT 20`,
      [JSON.stringify(uploadCollectionConfiguration)],
    );
    let queued = false;
    for (const row of rows.rows) {
      const result = await this.runs.repo.transaction(async (db) => {
        const current = await this.session(db, row.user_id, false);
        if (
          !current ||
          current.id !== row.id ||
          current.status !== "collecting" ||
          !isUploadCollection(current.configuration)
        )
          return false;
        return this.enqueue(db, current.id);
      });
      queued = result || queued;
    }
    return queued;
  }
  async prepare(userId: string) {
    await this.runs.repo.transaction(async (db) => {
      const s = await this.session(db, userId, false);
      if (this.fullBatch) {
        if (!s) throw new AppError(409, "PREPAID_BATCH_INPUT_REQUIRED", "Upload at least one file before starting.");
        await this.fullBatch.enqueueSession(db, s);
        await db.query(`UPDATE ${this.t("upload_sessions")} SET error=NULL WHERE id=$1`, [s.id]);
      } else if (s && !this.fullBatch) await this.enqueue(db, s.id);
    });
    return this.state(userId);
  }
  async remove(userId: string, code: string) {
    await this.runs.repo.transaction(async (db) => {
      const s = await this.mutable(db, userId, false);
      await db.query(
        `UPDATE ${this.t("session_files")} SET active=false WHERE session_id=$1 AND source_code=$2 AND active`,
        [s.id, code],
      );
      await db.query(
        `UPDATE ${this.t("upload_sessions")} SET version=version+1,status='collecting',error=NULL WHERE id=$1`,
        [s.id],
      );
      if (!this.fullBatch) await this.enqueue(db, s.id);
    });
    return this.state(userId);
  }
  async reset(
    userId: string,
    input: {
      runId?: string;
      eg?: number;
      sg?: number;
      sessionId?: string;
      sessionVersion?: number;
    },
  ) {
    const clear = async (db: PoolClient) => {
      const s = await this.session(db, userId, false);
      if (s && (s.id !== input.sessionId || s.version !== input.sessionVersion))
        throw new AppError(
          409,
          "PREPAID_SESSION_CHANGED",
          "Refresh the workspace before resetting.",
        );
      if (s?.status === "pending")
        throw new AppError(
          409,
          "PREPAID_INGESTION_RUNNING",
          "Wait for preparation before resetting.",
        );
      if (s?.run_id && s.run_id !== input.runId)
        throw new AppError(
          409,
          "PREPAID_RUN_CHANGED",
          "Refresh the workspace before resetting its reviewed run.",
        );
      if (s) {
        await this.fullBatch?.closeForReset(db, s.id);
        await db.query(
          `UPDATE ${this.t("upload_sessions")} SET active=false WHERE id=$1`,
          [s.id],
        );
      }
      await db.query(
        `DELETE FROM ${this.t("workspace_selection")} WHERE workspace_id IN(SELECT id FROM ${this.runs.repo.schema}.workspaces WHERE user_id=$1)`,
        [userId],
      );
    };
    if (input.runId) {
      if (input.eg == null || input.sg == null)
        throw new AppError(
          400,
          "PREPAID_VERSION_REQUIRED",
          "Regional versions are required.",
        );
      await this.runs.resetWorkspace(
        userId,
        input.runId,
        { eg: input.eg, sg: input.sg },
        clear,
      );
    } else await this.runs.repo.transaction(clear);
    return this.state(userId);
  }
}
