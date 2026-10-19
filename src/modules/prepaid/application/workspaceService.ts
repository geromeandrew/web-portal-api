import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { AppError } from "../../../errors.js";
import { prepaidMaximumSourceBytes } from "../domain/limits.js";
import {
  expectedName,
  sourceCodes,
  manualIntegrationSchema,
} from "../domain/contracts.js";
import { PrepaidRunService } from "./runService.js";
import {
  sourceWorkflows,
  unprovidedExtractionDependencies,
} from "../domain/sourceExtraction.js";

/** Upload ownership exists before a financial period/run is known. */
export class PrepaidWorkspaceService {
  constructor(readonly runs: PrepaidRunService) {}
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
    return {
      workflows: sourceWorkflows,
      executions: rows.rows,
      remainingDependencies: unprovidedExtractionDependencies,
    };
  }
  private async lock(db: PoolClient, userId: string) {
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `prepaid.workspace.${userId}`,
    ]);
  }
  private required(configuration: unknown) {
    const config = manualIntegrationSchema.parse(configuration);
    return [
      ...sourceCodes,
      ...config.expectedCycles.flatMap((c) => [`308_${c}`, `318_${c}`]),
    ].map((code) => ({ code, fileName: expectedName(code) }));
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
      const missing = required
        .filter((x) => !files.some((f) => f.source_code === x.code))
        .map((x) => x.code);
      return {
        session,
        run:
          session.status === "ready" && session.run_id
            ? await this.runs.get(userId, session.run_id)
            : null,
        sources: {
          required,
          files,
          missing,
          valid: !missing.length,
          upstream: null,
        },
        error: session.error,
      };
    }
    // Adopt old selected runs read-only; viewing never creates a session/run.
    try {
      const id = await this.runs.active(userId);
      return {
        session: null,
        run: await this.runs.get(userId, id),
        sources: await this.runs.sources(userId, id),
        error: null,
      };
    } catch (e) {
      if (!(e instanceof AppError) || e.code !== "PREPAID_RUN_REQUIRED")
        throw e;
    }
    let required: { code: string; fileName: string }[] = sourceCodes.map(
      (code) => ({ code, fileName: expectedName(code) }),
    );
    let error: string | null = null;
    try {
      required = this.required(await this.runs.integration());
    } catch (e) {
      if (
        !(e instanceof AppError) ||
        e.code !== "PREPAID_INTEGRATION_NOT_CONFIGURED"
      )
        throw e;
      error = e.message;
    }
    return {
      session: null,
      run: null,
      sources: {
        required,
        missing: required.map((x) => x.code),
        files: [],
        valid: false,
        upstream: null,
      },
      error,
    };
  }
  private async session(db: PoolClient, userId: string, create: boolean) {
    await this.lock(db, userId);
    const workspace = create
      ? await this.runs.repo.workspace(db, userId)
      : (
          await db.query(
            `SELECT id FROM ${this.runs.repo.schema}.workspaces WHERE user_id=$1`,
            [userId],
          )
        ).rows[0]?.id;
    if (!workspace) return null;
    let session = (
      await db.query(
        `SELECT * FROM ${this.t("upload_sessions")} WHERE workspace_id=$1 AND active FOR UPDATE`,
        [workspace],
      )
    ).rows[0];
    if (!session && create) {
      const configuration = await this.runs.integration();
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
  private async mutable(db: PoolClient, userId: string, create: boolean) {
    const s = await this.session(db, userId, create);
    if (!s)
      throw new AppError(
        409,
        "PREPAID_SESSION_REQUIRED",
        "Upload source files first.",
      );
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
  ) {
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
    if (expectedName(code).toLowerCase() !== file.originalname.toLowerCase())
      throw new AppError(
        400,
        "PREPAID_FILE_NAME_INVALID",
        "Use the exact filename listed in File Guidelines.",
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
    const s = await this.runs.repo.transaction(async (db) => {
      const session = await this.mutable(db, userId, true);
      if (!this.required(session.configuration).some((x) => x.code === code))
        throw new AppError(
          400,
          "PREPAID_SOURCE_NOT_REQUIRED",
          "This source is outside the configured billing-cycle coverage.",
        );
      return session;
    });
    if (
      !this.required(s.configuration).some(
        (x) =>
          x.code === code &&
          x.fileName.toLowerCase() === file.originalname.toLowerCase(),
      )
    )
      throw new AppError(
        400,
        "PREPAID_FILE_NAME_INVALID",
        "Use the exact filename listed in File Guidelines.",
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
    const id = randomUUID(),
      key = `${this.runs.storage.sessionPrefix(s.id)}sources/${id}/${expectedName(code)}`;
    const saved = await this.runs.storage.put(key, file.buffer, file.mimetype);
    await this.runs.repo.transaction(async (db) => {
      const current = await this.mutable(db, userId, false);
      if (current.id !== s.id)
        throw new AppError(
          409,
          "PREPAID_SESSION_CHANGED",
          "The workspace was reset; this upload was not attached.",
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
      await this.enqueue(db, s.id);
    });
    return { id, ...saved };
  }
  private async enqueue(db: PoolClient, sessionId: string) {
    const s = (
      await db.query(
        `SELECT * FROM ${this.t("upload_sessions")} WHERE id=$1 FOR UPDATE`,
        [sessionId],
      )
    ).rows[0];
    if (s.status === "pending" || s.status === "ready") return;
    const files = (
      await db.query(
        `SELECT * FROM ${this.t("session_files")} WHERE session_id=$1 AND active ORDER BY source_code`,
        [sessionId],
      )
    ).rows;
    if (
      !this.required(s.configuration).every((x) =>
        files.some((f) => f.source_code === x.code),
      )
    )
      return;
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
  }
  async prepare(userId: string) {
    await this.runs.repo.transaction(async (db) => {
      const s = await this.session(db, userId, false);
      if (s) await this.enqueue(db, s.id);
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
      if (s)
        await db.query(
          `UPDATE ${this.t("upload_sessions")} SET active=false WHERE id=$1`,
          [s.id],
        );
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
