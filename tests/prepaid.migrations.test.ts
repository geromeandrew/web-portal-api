import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  migratePrepaid,
  prepaidMigrations,
} from "../src/modules/prepaid/infrastructure/migrationRunner.js";
import {
  prepaidRawTables,
  prepaidRawSourceMigrationSql,
  prepaidRawSourceValidationSql,
} from "../src/modules/prepaid/infrastructure/rawSourceMigration.js";
import { splitSqlStatements } from "../src/modules/prepaid/infrastructure/sqlStatements.js";

describe("Prepaid migration SQL", () => {
  it("retains all verified raw columns, types and legacy spelling", () => {
    expect(
      Object.values(prepaidRawTables).map((columns) => columns.length),
    ).toEqual([30, 30, 31, 14, 14]);
    const sql = prepaidRawSourceMigrationSql("web_portal");
    expect(sql).toContain(
      '"INTERNAL  (BASED ON SALES)" character varying(255)',
    );
    expect(sql).toContain('"Luke OR Referece" character varying(255)');
    expect(sql).toContain('"amount" double precision');
    expect(sql).not.toMatch(/\b(DROP|TRUNCATE|DELETE|ALTER TABLE)\b/i);
    expect(() =>
      prepaidRawSourceMigrationSql("web_portal", 'bad"schema'),
    ).toThrow();
  });
  it("splits statements without splitting function bodies, quotes or comments", () => {
    const sql = `-- ; comment\nSELECT 'a;''b'; /* outer ; /* inner ; */ */ DO $body$ BEGIN PERFORM ';'; END $body$; SELECT "a;""b"; SELECT E'a\\';b'; SELECT $$;$$;`;
    expect(splitSqlStatements(sql)).toHaveLength(5);
    expect(splitSqlStatements(sql)[1]).toContain("PERFORM ';';");
    for (const invalid of ["SELECT 'abc", "DO $$ BEGIN", "/* missing"])
      expect(() => splitSqlStatements(invalid)).toThrow("Unterminated");
  });
  it("splits every complete migration and retains all function definitions", () => {
    const statements = prepaidMigrations().flatMap(([, sql]) =>
      splitSqlStatements(sql("web_portal")),
    );
    expect(
      statements.filter((s) => /CREATE(?: OR REPLACE)? FUNCTION/.test(s)),
    ).toHaveLength(25);
    expect(statements.filter((s) => /CREATE TABLE/.test(s))).toHaveLength(50);
  });
});

const testUrl = process.env.PREPAID_TEST_DATABASE_URL;
if (testUrl) {
  const url = new URL(testUrl);
  if (
    url.hostname !== "127.0.0.1" ||
    url.port !== "55479" ||
    url.username !== "prepaid_test"
  )
    throw new Error(
      "Migration integration tests require the isolated localhost:55479 prepaid_test cluster.",
    );
}
describe.skipIf(!testUrl)("Prepaid migrations (isolated PostgreSQL)", () => {
  const pool = new Pool({ connectionString: testUrl });
  const schema = `prepaid_migration_${randomUUID().replaceAll("-", "")}`;
  const raw = `${schema}_raw`;
  beforeAll(async () => {
    await pool.query(
      `CREATE SCHEMA "${schema}"; CREATE TABLE "${schema}".app_user(id uuid PRIMARY KEY); CREATE TABLE "${schema}".workspaces(id uuid PRIMARY KEY)`,
    );
  });
  afterAll(async () => {
    // Only random test-owned schemas, exclusively in the guarded disposable cluster.
    await pool.query(
      `DROP SCHEMA IF EXISTS "${raw}" CASCADE; DROP SCHEMA IF EXISTS "${schema}" CASCADE`,
    );
    await pool.end();
  });
  async function run() {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Exercise exactly the single-statement transport used by Data API.
      const result = await migratePrepaid(
        {
          async query(sql, values) {
            let rows: Record<string, unknown>[] = [];
            for (const statement of splitSqlStatements(sql))
              rows = (await client.query(statement, values)).rows;
            return { rows };
          },
        },
        schema,
        raw,
      );
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  it("installs all migrations, 41 portal tables and twelve raw targets", async () => {
    expect(await run()).toEqual(prepaidMigrations().map(([id]) => id));
    const result = await pool.query(
      "SELECT schemaname,count(*)::integer count FROM pg_tables WHERE schemaname=ANY($1) GROUP BY schemaname",
      [[schema, raw]],
    );
    expect(result.rows.find((r) => r.schemaname === schema).count).toBe(41); // 38 prepaid + two prerequisites
    expect(result.rows.find((r) => r.schemaname === raw).count).toBe(12);
    const column = await pool.query(
      "SELECT is_identity,identity_generation FROM information_schema.columns WHERE table_schema=$1 AND table_name='dcload_api' AND column_name='rownum'",
      [raw],
    );
    expect(column.rows[0]).toEqual({
      is_identity: "YES",
      identity_generation: "ALWAYS",
    });
    const { rows: [guard] } = await pool.query(
      "SELECT convalidated FROM pg_constraint WHERE conrelid=to_regclass($1) AND conname='prepaid_layout_tax_rate_nonzero_multiplier'",
      [`"${schema}".prepaid_region_revisions`],
    );
    expect(guard?.convalidated).toBe(true);
  });
  it("repeats safely, preserving existing rows and the separate mixed-case table", async () => {
    await pool.query(
      `INSERT INTO "${raw}".dccallcard_sg(trade,filename) VALUES('123.45','existing.xlsx'); CREATE TABLE "${raw}"."Billed_Adjustments_Header_Cycles"(column1 text); INSERT INTO "${raw}"."Billed_Adjustments_Header_Cycles" VALUES('preserve')`,
    );
    expect(await run()).toEqual([]);
    await pool.query(prepaidRawSourceMigrationSql(schema, raw));
    expect(
      (
        await pool.query(
          `SELECT trade,filename,rownum FROM "${raw}".dccallcard_sg`,
        )
      ).rows,
    ).toEqual([{ trade: "123.45", filename: "existing.xlsx", rownum: 1 }]);
    expect(
      (
        await pool.query(
          `SELECT column1 FROM "${raw}"."Billed_Adjustments_Header_Cycles"`,
        )
      ).rows[0].column1,
    ).toBe("preserve");
  });
  it("detects raw schema drift without repairing or deleting user data", async () => {
    await pool.query(
      `ALTER TABLE "${raw}".dccallcard_sg ALTER COLUMN trade TYPE text`,
    );
    await expect(run()).rejects.toThrow("schema mismatch");
    expect(
      (await pool.query(`SELECT trade FROM "${raw}".dccallcard_sg`)).rows[0]
        .trade,
    ).toBe("123.45");
    await pool.query(
      `ALTER TABLE "${raw}".dccallcard_sg ALTER COLUMN trade TYPE varchar(255)`,
    );
    await pool.query(prepaidRawSourceValidationSql(raw));
  });
  it("detects additional raw target drift and workflow-constraint drift without hiding them behind the ledger", async () => {
    await pool.query(
      `ALTER TABLE "${raw}"."dcKE24" ALTER COLUMN "Cost Element" TYPE varchar(50)`,
    );
    await expect(run()).rejects.toThrow(
      "additional raw source schema mismatch",
    );
    await pool.query(
      `ALTER TABLE "${raw}"."dcKE24" ALTER COLUMN "Cost Element" TYPE text`,
    );
    await pool.query(
      `ALTER TABLE "${schema}".prepaid_source_extractions DROP CONSTRAINT prepaid_source_extractions_workflow_check`,
    );
    await expect(run()).rejects.toThrow(
      "workflow constraint from migration 008",
    );
    const workflows = [
      "ke24",
      "callcard_eg",
      "callcard_sg",
      "load_up_eg",
      "load_up_sg",
      "load_api_eg",
      "load_api_sg",
      "monthly_recharge",
      "adjustments_308",
      "charges_318",
    ];
    await pool.query(
      `ALTER TABLE "${schema}".prepaid_source_extractions ADD CONSTRAINT prepaid_source_extractions_workflow_check CHECK(workflow IN (${workflows.map((w) => "'" + w + "'").join(",")}))`,
    );
    expect(await run()).toEqual([]);
  });
  it("detects missing tables even when the migration ledger is current", async () => {
    await pool.query(
      `ALTER TABLE "${schema}".prepaid_events RENAME TO prepaid_events_test_saved`,
    );
    await expect(run()).rejects.toThrow("Missing table");
    await pool.query(
      `ALTER TABLE "${schema}".prepaid_events_test_saved RENAME TO prepaid_events`,
    );
    expect(await run()).toEqual([]);
  });
  it("rolls back a fresh installation when an existing raw target is incompatible", async () => {
    const blocked = `${schema}_blocked`,
      blockedRaw = `${schema}_badraw`;
    const client = await pool.connect();
    try {
      await client.query(
        `CREATE SCHEMA "${blocked}"; CREATE TABLE "${blocked}".app_user(id uuid PRIMARY KEY); CREATE TABLE "${blocked}".workspaces(id uuid PRIMARY KEY); CREATE SCHEMA "${blockedRaw}"; CREATE TABLE "${blockedRaw}".dccallcard_sg(trade text); INSERT INTO "${blockedRaw}".dccallcard_sg VALUES('keep')`,
      );
      await client.query("BEGIN");
      await expect(migratePrepaid(client, blocked, blockedRaw)).rejects.toThrow(
        "schema mismatch",
      );
      await client.query("ROLLBACK");
      const ledger = await client.query("SELECT to_regclass($1) relation", [
        `${blocked}.prepaid_schema_migrations`,
      ]);
      expect(ledger.rows[0].relation).toBeNull();
      expect(
        (await client.query(`SELECT trade FROM "${blockedRaw}".dccallcard_sg`))
          .rows,
      ).toEqual([{ trade: "keep" }]);
      expect(
        (
          await client.query(
            "SELECT count(*)::integer count FROM pg_tables WHERE schemaname=$1",
            [blockedRaw],
          )
        ).rows[0].count,
      ).toBe(1);
    } finally {
      await client.query("ROLLBACK");
      await client.query(
        `DROP SCHEMA IF EXISTS "${blockedRaw}" CASCADE; DROP SCHEMA IF EXISTS "${blocked}" CASCADE`,
      );
      client.release();
    }
  });
});
