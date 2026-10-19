import type { Pool, PoolClient } from "pg";
import {
  legacyReferenceFields,
  referenceRefreshJob,
} from "../domain/referenceRefresh.js";
import { convertLegacyReference } from "../domain/referenceConverter.js";

export interface ReferenceDatabaseIdentity {
  database: string;
  address: string;
  port: number;
  connectedHost?: string;
}
export interface ReferenceSource {
  identity(): Promise<ReferenceDatabaseIdentity>;
  snapshot(period: string): Promise<{ bytes: Buffer; rowCount: number }>;
}

/** Read-only repeatable-read export. No JS numeric conversion or reference seeding. */
export class PostgresReferenceSource implements ReferenceSource {
  constructor(
    private readonly pool: Pool,
    private readonly schema: string = referenceRefreshJob.schema,
  ) {
    if (!/^[a-z_][a-z0-9_]*$/.test(schema))
      throw Error("Invalid reference schema.");
  }
  private async columns(db: Pool | PoolClient) {
    const rows = (
      await db.query(
        "SELECT column_name,data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2",
        [this.schema, referenceRefreshJob.table],
      )
    ).rows;
    const actual = new Map<string, string>();
    for (const field of legacyReferenceFields) {
      const matches = rows.filter((c) => c.column_name.toUpperCase() === field);
      if (matches.length !== 1)
        throw Error(
          `Reference source must expose exactly one ${field} column.`,
        );
      const accepted = [
        "character varying",
        "character",
        "text",
        ...(["TAXRATE", "AVERATE"].includes(field) ? ["numeric"] : []),
      ];
      if (!accepted.includes(matches[0].data_type))
        throw Error(
          `Reference ${field} must have an exact text/decimal type; floating-point coercion is not permitted.`,
        );
      actual.set(field, matches[0].column_name);
    }
    return actual;
  }
  async identity() {
    await this.columns(this.pool);
    const result = await this.pool.query(
      "SELECT current_database() AS database,inet_server_addr()::text AS address,inet_server_port() AS port",
    );
    const identity = result.rows[0] as ReferenceDatabaseIdentity;
    if (!identity?.database || !identity.address || !identity.port)
      throw Error(
        "A TCP database identity is required to verify the reference job destination.",
      );
    return { ...identity, connectedHost: this.pool.options.host };
  }
  async snapshot(period: string) {
    const db = await this.pool.connect();
    const chunks: Buffer[] = [];
    let size = 0,
      count = 0;
    try {
      await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await db.query("SET LOCAL statement_timeout='30000ms'");
      await db.query("SET LOCAL lock_timeout='5s'");
      const actual = await this.columns(db);
      const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
      const field = (name: string) => quote(actual.get(name)!);
      const projection = legacyReferenceFields
        .map((name) => `${field(name)}::text AS ${quote(name)}`)
        .join(",");
      // Scope is acknowledged on the admin request. Do not label GLOB a legacy-view rule.
      await db.query(`DECLARE prepaid_reference_cursor NO SCROLL CURSOR FOR SELECT ${projection}
        FROM "${this.schema}"."${referenceRefreshJob.table}"
        WHERE btrim(${field("MANDT")}::text)='300' AND btrim(${field("BUKRS")}::text)='GLOB'
        ORDER BY ${legacyReferenceFields.map((name) => `${field(name)}::text COLLATE "C" NULLS FIRST`).join(",")}`);
      while (true) {
        const page = await db.query(
          "FETCH FORWARD 500 FROM prepaid_reference_cursor",
        );
        if (!page.rows.length) break;
        for (const row of page.rows) {
          if (++count > 250000)
            throw Error("Reference export exceeds 250,000 rows.");
          const bytes = Buffer.from(JSON.stringify(row) + "\n");
          size += bytes.length;
          if (size > 20 * 1024 * 1024)
            throw Error("Reference export exceeds 20 MiB.");
          chunks.push(bytes);
        }
      }
      const bytes = Buffer.concat(chunks, size);
      // Empty, malformed and incompatible mappings fail before any object is published.
      const converted = convertLegacyReference(bytes, period);
      if (converted.report.rowCount !== count)
        throw Error("Reference snapshot row count differs after conversion.");
      await db.query("COMMIT");
      return { bytes, rowCount: count };
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    } finally {
      db.release();
    }
  }
}
