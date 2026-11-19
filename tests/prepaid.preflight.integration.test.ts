import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Pool } from "pg";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { migrations } from "../src/migrations.js";
import {
  migratePrepaid,
  prepaidMigrations,
} from "../src/modules/prepaid/infrastructure/migrationRunner.js";

const url = process.env.PREPAID_TEST_DATABASE_URL;
if (url) {
  const target = new URL(url);
  if (
    target.hostname !== "127.0.0.1" ||
    target.port !== "55479" ||
    target.username !== "prepaid_test"
  )
    throw Error("Use only the disposable prepaid_test cluster on port 55479.");
}
describe.skipIf(!url)(
  "Read-only operator preflight (disposable PostgreSQL)",
  () => {
    const database = `prepaid_preflight_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString: url });
    let pool: Pool;
    beforeAll(async () => {
      await admin.query(`CREATE DATABASE "${database}"`);
      const target = new URL(url!);
      target.pathname = `/${database}`;
      pool = new Pool({ connectionString: target.toString(), max: 1 });
    });
    afterAll(async () => {
      if (pool) await pool.end();
      // Exact generated test-owned database on the guarded localhost cluster only.
      await admin.query(`DROP DATABASE "${database}"`);
      await admin.end();
    });
    async function inspect() {
      const args = ["--import", "tsx", "src/checkPrepaidReadiness.ts"];
      const options = {
        env: {
          ...process.env,
          DATABASE_HOST: "127.0.0.1",
          DATABASE_PORT: "55479",
          DATABASE_NAME: database,
          DATABASE_USER: "prepaid_test",
          DATABASE_PASSWORD: "test-only",
          DATABASE_SSL: "false",
          DATABASE_SCHEMA: "web_portal",
          OKTA_ISSUER: "https://example.okta.com/oauth2/default",
          OKTA_CLIENT_ID: "test-only",
          RATE_LIMIT_HMAC_SECRET:
            "preflight-tests-only-secret-at-least-32-characters",
          S3_BUCKET: "test-only",
          AWS_REGION: "us-east-1",
        },
        windowsHide: true,
      };
      try {
        const result = await promisify(execFile)(
          process.execPath,
          args,
          options,
        );
        return { code: 0, report: JSON.parse(result.stdout) };
      } catch (error) {
        const result = error as { code: number; stdout: string };
        return { code: result.code, report: JSON.parse(result.stdout) };
      }
    }
    it("reports every pending migration without creating a schema or ledger", async () => {
      const result = await inspect();
      expect(result.code).toBe(2);
      expect(result.report.mode).toBe("read-only");
      expect(result.report.migrations.portalPending).toHaveLength(
        migrations.length,
      );
      expect(result.report.migrations.prepaidPending).toHaveLength(
        prepaidMigrations().length,
      );
      expect(
        (await pool.query("SELECT to_regnamespace('web_portal') present"))
          .rows[0].present,
      ).toBeNull();
    }, 20_000);
    it("recognizes a full fresh installation without supplying approvals or records", async () => {
      await pool.query(
        "CREATE SCHEMA web_portal; SET search_path TO web_portal,public; CREATE TABLE schema_migrations(id text PRIMARY KEY)",
      );
      for (const migration of migrations) {
        await pool.query(migration.sql);
        await pool.query("INSERT INTO schema_migrations(id) VALUES($1)", [
          migration.id,
        ]);
      }
      const db = await pool.connect();
      try {
        await db.query("BEGIN");
        await migratePrepaid(db, "web_portal");
        await db.query("COMMIT");
      } finally {
        db.release();
      }
      const result = await inspect();
      expect(result.report.migrations).toEqual({
        portalPending: [],
        prepaidPending: [],
      });
      expect(result.report.objects).toMatchObject({
        expected: 78,
        missing: [],
      });
      expect(result.report.integration.configured).toBe(false);
      expect(result.report.accountingAcceptanceVerified).toBe(false);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int count FROM prepaid_integrations",
          )
        ).rows[0].count,
      ).toBe(0);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int count FROM prepaid_schema_migrations",
          )
        ).rows[0].count,
      ).toBe(prepaidMigrations().length);
    }, 30_000);
    it("reports schema drift without rewriting migration history or repairing it", async () => {
      await pool.query(
        "ALTER TABLE prepaid_reference_refreshes RENAME TO test_saved_reference_refreshes",
      );
      const result = await inspect();
      expect(result.code).toBe(2);
      expect(result.report.migrations.prepaidPending).toEqual([]);
      expect(result.report.objects.missing).toContain(
        '"web_portal".prepaid_reference_refreshes',
      );
      expect(
        (
          await pool.query(
            "SELECT to_regclass('web_portal.prepaid_reference_refreshes') present",
          )
        ).rows[0].present,
      ).toBeNull();
      expect(
        (
          await pool.query(
            "SELECT count(*)::int count FROM prepaid_schema_migrations",
          )
        ).rows[0].count,
      ).toBe(prepaidMigrations().length);
    }, 20_000);
  },
);
