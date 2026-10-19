import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { assertAdministrator } from "../../../rbac.js";
import { AppError } from "../../../errors.js";
import {
  referenceRefreshRequestSchema,
  referenceRefreshJob,
} from "../domain/referenceRefresh.js";
import { PrepaidRepository } from "../infrastructure/repository.js";

const columns =
  "id,request,status,phase,glue_run_id,provenance,result,error,created_at,updated_at";

/** Explicit administrator operation; never enqueued by a user's file upload. */
export class PrepaidReferenceRefreshService {
  constructor(readonly repo: PrepaidRepository) {}
  private t = () => this.repo.table("reference_refreshes");
  private async ready(userId: string) {
    await assertAdministrator(this.repo.pool, userId);
    const installed = await this.repo.pool.query(
      "SELECT to_regclass($1) present",
      [this.t()],
    );
    if (!installed.rows[0]?.present)
      throw new AppError(
        503,
        "PREPAID_REFERENCE_SCHEMA_NOT_INSTALLED",
        "Install Prepaid migration 009 before preparing SAP reference exports.",
      );
  }
  async create(userId: string, body: unknown) {
    await this.ready(userId);
    const request = referenceRefreshRequestSchema.parse(body);
    return this.repo.transaction(async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `${this.repo.schema}.prepaid.reference-refresh`,
      ]);
      const prior = (
        await db.query(
          `SELECT ${columns} FROM ${this.t()} WHERE idempotency_key=$1`,
          [request.idempotencyKey],
        )
      ).rows[0];
      if (prior) {
        if (!isDeepStrictEqual(prior.request, request))
          throw new AppError(
            409,
            "PREPAID_REFERENCE_IDEMPOTENCY_CONFLICT",
            "That idempotency key was used for a different reference request.",
          );
        return prior;
      }
      const active = await db.query(
        `SELECT id FROM ${this.t()} WHERE status NOT IN ('completed','failed')`,
      );
      if (active.rowCount)
        throw new AppError(
          409,
          "PREPAID_REFERENCE_BUSY",
          "Another reference operation is active or has an unknown outcome. Reconcile it before creating another.",
        );
      return (
        await db.query(
          `INSERT INTO ${this.t()}(id,idempotency_key,actor_id,request) VALUES($1,$2,$3,$4) RETURNING ${columns}`,
          [
            randomUUID(),
            request.idempotencyKey,
            userId,
            JSON.stringify(request),
          ],
        )
      ).rows[0];
    });
  }
  async get(userId: string, id: string) {
    await this.ready(userId);
    const row = (
      await this.repo.pool.query(
        `SELECT ${columns} FROM ${this.t()} WHERE id=$1`,
        [id],
      )
    ).rows[0];
    if (!row)
      throw new AppError(
        404,
        "PREPAID_REFERENCE_NOT_FOUND",
        "Reference operation not found.",
      );
    return {
      ...row,
      source: `${referenceRefreshJob.schema}.${referenceRefreshJob.table}`,
      client: "300",
      company: "GLOB",
    };
  }
  async reconcile(userId: string, id: string) {
    await this.ready(userId);
    const result = await this.repo.pool.query(
      `UPDATE ${this.t()} SET status='waiting',available_at=now(),updated_at=now()
      WHERE id=$1 AND status='unknown' AND (lease_until IS NULL OR lease_until<now()) RETURNING ${columns}`,
      [id],
    );
    if (!result.rows[0])
      throw new AppError(
        409,
        "PREPAID_REFERENCE_NOT_UNKNOWN",
        "Only an unknown, unleased reference operation can be reconciled. Reconciliation discovers the original Glue run; it never starts a replacement run.",
      );
    return result.rows[0];
  }
}
