import { AppError } from "../../../errors.js";
import { assertAdministrator } from "../../../rbac.js";
import {
  referenceImportSchema,
  referenceVersionSchema,
  type ReferenceVersion,
} from "../domain/referenceVersion.js";
import { convertLegacyReference } from "../domain/referenceConverter.js";
import { legacyReferenceFields } from "../domain/referenceRefresh.js";
import { PrepaidRepository, type Queryable } from "./repository.js";
import { sha256 } from "./prepaidStorage.js";
import {
  requestContext,
  securityAudit,
} from "../../../platform/requestAudit.js";

/** PostgreSQL is the source for new reference versions; S3 is never read here. */
export class PrepaidReferenceCatalog {
  constructor(readonly repo: PrepaidRepository) {}
  private table = () => this.repo.table("reference_versions");
  private async installed(db: Queryable = this.repo.pool) {
    if (
      !(await db.query("SELECT to_regclass($1) present", [this.table()]))
        .rows[0]?.present
    )
      throw new AppError(
        503,
        "PREPAID_REFERENCE_CATALOG_NOT_INSTALLED",
        "Install Prepaid migration 013 before using database reference versions.",
      );
  }
  async assertAvailable(
    request: ReferenceVersion,
    db: Queryable = this.repo.pool,
  ) {
    const descriptor = referenceVersionSchema.parse(request);
    await this.installed(db);
    const row = (
      await db.query(
        `SELECT row_count,sealed FROM ${this.table()} WHERE sha256=$1`,
        [descriptor.sha256],
      )
    ).rows[0];
    if (!row?.sealed || row.row_count !== descriptor.rowCount)
      throw new AppError(
        409,
        "PREPAID_REFERENCE_VERSION_UNAVAILABLE",
        "Import the exact approved reference version into this database before preparation. Uploads may still be collected.",
      );
    return descriptor;
  }
  async load(
    request: ReferenceVersion,
    period: string,
    db: Queryable = this.repo.pool,
  ) {
    const descriptor = await this.assertAvailable(request, db);
    const row = (
      await db.query(
        `SELECT source_bytes FROM ${this.table()} WHERE sha256=$1 AND sealed`,
        [descriptor.sha256],
      )
    ).rows[0];
    if (!row || sha256(row.source_bytes) !== descriptor.sha256)
      throw Error("Database reference checksum mismatch.");
    const converted = convertLegacyReference(row.source_bytes, period);
    if (
      converted.report.inputRows !== descriptor.rowCount ||
      converted.report.rowCount !== descriptor.rowCount
    )
      throw Error("Database reference row count mismatch.");
    return { ...converted, source: descriptor };
  }
  async list(actorId: string) {
    await assertAdministrator(this.repo.pool, actorId);
    await this.installed();
    return (
      await this.repo.pool.query(
        `SELECT sha256,row_count,label,validated_period,approval_scope,approved_by,created_at,provenance FROM ${this.table()} WHERE sealed ORDER BY created_at DESC LIMIT 100`,
      )
    ).rows;
  }
  async approvalMetadata(actorId: string, checksum: string) {
    await assertAdministrator(this.repo.pool, actorId);
    await this.installed();
    const row = (
      await this.repo.pool.query(
        `SELECT sha256,row_count,label,validated_period,approval_scope,provenance FROM ${this.table()} WHERE sha256=$1 AND sealed`,
        [referenceVersionSchema.shape.sha256.parse(checksum)],
      )
    ).rows[0];
    if (!row)
      throw new AppError(
        404,
        "PREPAID_REFERENCE_VERSION_NOT_FOUND",
        "Reference version not found.",
      );
    return {
      period: row.validated_period,
      label: row.label,
      sha256: row.sha256,
      rowCount: row.row_count,
      approved: true,
      approvalScope: row.approval_scope,
      provenance: row.provenance,
    };
  }
  async export(actorId: string, checksum: string) {
    await assertAdministrator(this.repo.pool, actorId);
    await this.installed();
    const row = (
      await this.repo.pool.query(
        `SELECT source_bytes,row_count FROM ${this.table()} WHERE sha256=$1 AND sealed`,
        [referenceVersionSchema.shape.sha256.parse(checksum)],
      )
    ).rows[0];
    if (!row)
      throw new AppError(
        404,
        "PREPAID_REFERENCE_VERSION_NOT_FOUND",
        "Reference version not found.",
      );
    if (sha256(row.source_bytes) !== checksum)
      throw Error("Database reference checksum mismatch.");
    return row.source_bytes as Buffer;
  }
  async import(actorId: string, bytes: Buffer, input: unknown) {
    await assertAdministrator(this.repo.pool, actorId);
    const request = referenceImportSchema.parse(input);
    await this.installed();
    if (!bytes.length || bytes.length > 20 * 1024 * 1024)
      throw new AppError(
        400,
        "PREPAID_REFERENCE_SIZE",
        "Reference import must be at most 20 MiB.",
      );
    if (sha256(bytes) !== request.sha256)
      throw new AppError(
        400,
        "PREPAID_REFERENCE_CHECKSUM",
        "Reference file does not match the approved checksum.",
      );
    let converted: ReturnType<typeof convertLegacyReference>;
    try {
      converted = convertLegacyReference(bytes, request.period);
    } catch {
      throw new AppError(
        400,
        "PREPAID_REFERENCE_FORMAT",
        "The reference file must contain valid client-300/GLOB SAP records with exact string/decimal fields.",
      );
    }
    const rows = bytes
      .toString("utf8")
      .split(/\r?\n/)
      .filter((x) => x.trim())
      .map((x) => JSON.parse(x));
    if (
      converted.report.inputRows !== request.rowCount ||
      converted.report.rowCount !== request.rowCount ||
      rows.length !== request.rowCount
    )
      throw new AppError(
        400,
        "PREPAID_REFERENCE_ROW_COUNT",
        "Reference file does not match the approved row count.",
      );
    for (const row of rows)
      if (
        !row ||
        Array.isArray(row) ||
        legacyReferenceFields.some(
          (field) =>
            !(field in row) ||
            (row[field] !== null && typeof row[field] !== "string"),
        )
      )
        throw new AppError(
          400,
          "PREPAID_REFERENCE_FIELDS",
          "Database reference imports require all 17 original SAP fields as strings or null; numeric coercion is not allowed.",
        );
    const descriptor: ReferenceVersion = {
      sha256: request.sha256,
      rowCount: request.rowCount,
      approved: true,
    };
    await this.repo.transaction(async (db) => {
      const inserted = await db.query(
        `INSERT INTO ${this.table()}(sha256,row_count,source_bytes,label,validated_period,approval_scope,provenance,approved_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(sha256) DO NOTHING RETURNING sha256`,
        [
          request.sha256,
          request.rowCount,
          bytes,
          request.label,
          request.period,
          request.approvalScope,
          JSON.stringify(request.provenance),
          actorId,
        ],
      );
      if (!inserted.rowCount) {
        await this.assertAvailable(descriptor, db);
        return;
      }
      for (let offset = 0; offset < rows.length; offset += 500)
        await db.query(
          `INSERT INTO ${this.repo.table("reference_version_rows")}(version_sha256,row_number,data) SELECT $1,$2+ordinality::integer,value FROM jsonb_array_elements($3::jsonb) WITH ORDINALITY`,
          [
            request.sha256,
            offset,
            JSON.stringify(rows.slice(offset, offset + 500)),
          ],
        );
      await db.query(`UPDATE ${this.table()} SET sealed=true WHERE sha256=$1`, [
        request.sha256,
      ]);
      if (requestContext.getStore())
        await securityAudit(
          db,
          "prepaid.reference_version.imported",
          {
            resourceId: request.sha256,
            actionOutcome: "success",
            actorUserId: actorId,
          },
          true,
        );
    });
    return descriptor;
  }
}
