import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../../../db.js";
import { AppError } from "../../../errors.js";
import { randomUUID } from "node:crypto";

export type Queryable = Pool | PoolClient;
export class PrepaidRepository {
  readonly schema: string;
  constructor(
    readonly pool: Pool,
    schema: string,
  ) {
    if (!/^[a-z_][a-z0-9_]*$/.test(schema))
      throw new Error("Invalid Prepaid schema");
    this.schema = `"${schema}"`;
  }
  table(name: string) {
    // PostgreSQL parameters bind values only. Accept a single identifier suffix.
    if (!/^[a-z][a-z0-9_]*$/.test(name))
      throw new Error("Invalid Prepaid table identifier");
    return `${this.schema}.prepaid_${name}`;
  }
  async reconciliationCsvRows(revisionId: string) {
    return this.transaction(async (db) => {
      // Use the configured schema on this transaction only so the report SQL is static.
      await db.query("SELECT pg_catalog.set_config('search_path', $1, true)", [
        `${this.schema}, pg_temp`,
      ]);
      const result = await db.query(
        `SELECT revenue_type,allocation_type,tax_rate,gross,amount,tax_amount,total_gross,difference
         FROM prepaid_reconciliation_rows
         WHERE revision_id=$1
         ORDER BY revenue_type,allocation_type,tax_rate`,
        [revisionId],
      );
      return result.rows;
    });
  }
  async transaction<T>(fn: (db: PoolClient) => Promise<T>) {
    try {
      return await withTransaction(this.pool, fn);
    } catch (error) {
      const e = error as { code?: string; message?: string };
      if (e.code === "23505")
        throw new AppError(
          409,
          "PREPAID_CONFLICT",
          "A run, active source, draft or job already exists. Refresh and retry.",
        );
      if (e.code === "P0001")
        throw new AppError(
          409,
          e.message ?? "PREPAID_CONFLICT",
          "The operation conflicts with the current Prepaid state. Check the layout and validation results.",
        );
      throw error;
    }
  }
  async workspace(db: Queryable, userId: string) {
    // No demo workflow state is initialized for Prepaid.
    await db.query(
      `INSERT INTO ${this.schema}.workspaces(id,user_id) VALUES($1,$2) ON CONFLICT(user_id) DO NOTHING`,
      [randomUUID(), userId],
    );
    return (
      await db.query(
        `SELECT id FROM ${this.schema}.workspaces WHERE user_id=$1`,
        [userId],
      )
    ).rows[0].id as string;
  }
  async own(db: Queryable, userId: string, runId: string, lock = false) {
    if (lock) {
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `prepaid.workspace.${userId}`,
      ]);
      await db.query(
        `SELECT s.id FROM ${this.table("upload_sessions")} s JOIN ${this.schema}.workspaces w ON w.id=s.workspace_id WHERE w.user_id=$1 AND s.active FOR UPDATE OF s`,
        [userId],
      );
    }
    const result = await db.query(
      `SELECT r.* FROM ${this.table("runs")} r JOIN ${this.schema}.workspaces w ON w.id=r.workspace_id WHERE r.id=$1 AND w.user_id=$2 ${lock ? "FOR UPDATE OF r" : ""}`,
      [runId, userId],
    );
    if (!result.rows[0])
      throw new AppError(
        404,
        "PREPAID_RUN_NOT_FOUND",
        "Prepaid run not found in your workspace.",
      );
    return result.rows[0];
  }
  async revision(db: Queryable, runId: string, region: string, lock = false) {
    const result = await db.query(
      `SELECT * FROM ${this.table("region_revisions")} WHERE run_id=$1 AND region=$2 ORDER BY revision DESC LIMIT 1 ${lock ? "FOR UPDATE" : ""}`,
      [runId, region],
    );
    if (!result.rows[0])
      throw new AppError(
        404,
        "PREPAID_LAYOUT_NOT_FOUND",
        "Regional layout not found.",
      );
    return result.rows[0];
  }
  checkVersion(revision: Record<string, unknown>, version: number | undefined) {
    if (revision.version !== version)
      throw new AppError(
        409,
        "PREPAID_STALE_VERSION",
        "The layout changed. Refresh before saving.",
      );
  }
  async event(
    db: Queryable,
    runId: string,
    action: string,
    detail: unknown = {},
    actorId?: string,
    revisionId?: string,
    jobId?: string,
  ) {
    await db.query(
      `INSERT INTO ${this.table("events")}(run_id,action,detail,actor_id,revision_id,job_id) VALUES($1,$2,$3,$4,$5,$6)`,
      [
        runId,
        action,
        JSON.stringify(detail),
        actorId ?? null,
        revisionId ?? null,
        jobId ?? null,
      ],
    );
  }
}
