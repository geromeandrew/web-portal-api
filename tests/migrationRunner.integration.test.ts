import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, it, expect } from "vitest";
import { runMigrations } from "../src/migrationRunner.js";
import { migrations } from "../src/migrations.js";
import { securityHeadersApp } from "./fixtures/securityHeaders.js";
const logger = { info() {}, error() {} };
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "migration runner with PostgreSQL",
  () => {
    async function fixture(
      run: (
        pool: Pool,
        config: ReturnType<typeof securityHeadersApp>["config"],
      ) => Promise<void>,
    ) {
      const schema = "migration_test_" + randomUUID().replaceAll("-", "");
      const pool = new Pool({
        connectionString: process.env.TEST_DATABASE_URL,
        max: 4,
      });
      const { config } = securityHeadersApp({
        DATABASE_SCHEMA: schema,
        DATABASE_NAME: "postgres",
        MIGRATION_LOCK_TIMEOUT_MS: 100,
      });
      try {
        await run(pool, config);
      } finally {
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await pool.end();
      }
    }
    it("bootstraps all existing migrations, serializes concurrent starts, and skips repeat work", async () => {
      await fixture(async (pool, config) => {
        config.MIGRATION_LOCK_TIMEOUT_MS = 10000;
        await Promise.all([
          runMigrations(pool, config, logger),
          runMigrations(pool, config, logger),
        ]);
        await runMigrations(pool, config, logger);
        expect(
          Number(
            (
              await pool.query(
                `SELECT count(*) FROM "${config.DATABASE_SCHEMA}".schema_migrations`,
              )
            ).rows[0].count,
          ),
        ).toBe(migrations.length);
        expect(
          (
            await pool.query(
              `SELECT count(*) FROM information_schema.columns WHERE table_schema=$1 AND table_name='security_audit_events' AND column_name IN ('environment','action_outcome','access_port')`,
              [config.DATABASE_SCHEMA],
            )
          ).rows[0].count,
        ).toBe("3");
      });
    }, 30000);
    it("rolls back failed DDL and its ID while preserving previous committed migrations", async () => {
      await fixture(async (pool, config) => {
        const entries = [
          { id: "one", sql: "CREATE TABLE kept(id int)" },
          {
            id: "two",
            sql: "CREATE TABLE rolled_back(id int); SELECT * FROM missing_table",
          },
        ];
        await expect(
          runMigrations(pool, config, logger, undefined, entries),
        ).rejects.toThrow();
        const ledger = await pool.query(
          `SELECT id FROM "${config.DATABASE_SCHEMA}".schema_migrations`,
        );
        expect(ledger.rows).toEqual([{ id: "one" }]);
        expect(
          (
            await pool.query("SELECT to_regclass($1) AS name", [
              config.DATABASE_SCHEMA + ".rolled_back",
            ])
          ).rows[0].name,
        ).toBeNull();
        await runMigrations(pool, config, logger, undefined, [
          entries[0],
          { id: "two", sql: "CREATE TABLE restored(id int)" },
        ]);
      });
    });
    it("bounds competing lock waits and releases them after failure", async () => {
      await fixture(async (pool, config) => {
        const blocker = await pool.connect();
        const key = `esatp:migrations:${config.DATABASE_NAME}:${config.DATABASE_SCHEMA}`;
        await blocker.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [
          key,
        ]);
        try {
          await expect(
            runMigrations(pool, config, logger, undefined, []),
          ).rejects.toThrow("lock timeout");
        } finally {
          await blocker.query(
            "SELECT pg_advisory_unlock(hashtextextended($1,0))",
            [key],
          );
          blocker.release();
        }
        await runMigrations(pool, config, logger, undefined, []);
      });
    });
    it("rolls back on statement timeout", async () => {
      await fixture(async (pool, config) => {
        config.MIGRATION_STATEMENT_TIMEOUT_MS = 50;
        await expect(
          runMigrations(pool, config, logger, undefined, [
            {
              id: "slow",
              sql: "CREATE TABLE partial(id int); SELECT pg_sleep(2)",
            },
          ]),
        ).rejects.toThrow(/timeout/);
        expect(
          (
            await pool.query(
              `SELECT * FROM "${config.DATABASE_SCHEMA}".schema_migrations`,
            )
          ).rows,
        ).toEqual([]);
      });
    });
    it("fails clearly for an identity without schema-management permission", async () => {
      await fixture(async (pool, config) => {
        const role = "migration_denied_" + randomUUID().replaceAll("-", "");
        await pool.query(`CREATE ROLE "${role}" NOLOGIN`);
        const restricted = new Pool({
          connectionString: process.env.TEST_DATABASE_URL,
          options: `-c role=${role}`,
        });
        try {
          await expect(
            runMigrations(restricted, config, logger, undefined, []),
          ).rejects.toMatchObject({ code: "42501" });
        } finally {
          await restricted.end();
          await pool.query(`DROP ROLE "${role}"`);
        }
      });
    });
    it("runs the compiled CLI without an env file and preserves injected target settings over a local file", async () => {
      await fixture(async (_pool, config) => {
        const folder = await mkdtemp(join(tmpdir(), "migration-env-test-"));
        const target = new URL(process.env.TEST_DATABASE_URL!);
        const env = {
          ...process.env,
          NODE_ENV: "test",
          DATABASE_HOST: target.hostname,
          DATABASE_PORT: target.port || "5432",
          DATABASE_NAME: target.pathname.slice(1),
          DATABASE_USER: decodeURIComponent(target.username),
          DATABASE_PASSWORD: decodeURIComponent(target.password) || "test-only",
          DATABASE_SCHEMA: config.DATABASE_SCHEMA,
          DATABASE_SSL: "false",
          AWS_LOCAL: "false",
          AWS_REGION: "ap-southeast-1",
          S3_BUCKET: "test-only",
          OKTA_ISSUER: "https://example.okta.com/oauth2/default",
          OKTA_CLIENT_ID: "test-only",
          RATE_LIMIT_HMAC_SECRET:
            "test-only-migration-secret-at-least-32-characters",
        };
        const cli = resolve("dist/migrate.js");
        try {
          await promisify(execFile)(
            process.execPath,
            ["--env-file-if-exists=.env", cli],
            { cwd: folder, env, windowsHide: true },
          );
          await writeFile(
            join(folder, ".env"),
            "DATABASE_HOST=invalid.test\nDATABASE_SCHEMA=invalid_schema\n",
          );
          await promisify(execFile)(
            process.execPath,
            ["--env-file-if-exists=.env", cli],
            { cwd: folder, env, windowsHide: true },
          );
        } finally {
          await rm(join(folder, ".env"), { force: true });
          await rmdir(folder);
        }
      });
    }, 30000);
    it("cancels an active migration, releases its session lock, and leaves no partial record", async () => {
      await fixture(async (pool, config) => {
        const controller = new AbortController();
        let started!: () => void;
        const running = new Promise<void>((resolve) => {
          started = resolve;
        });
        const done = runMigrations(
          pool,
          config,
          {
            info(event) {
              if (event === "database.migration_started") started();
            },
            error() {},
          },
          controller.signal,
          [{ id: "cancelled", sql: "SELECT pg_sleep(10)" }],
        );
        const rejection = expect(done).rejects.toThrow();
        await running;
        controller.abort();
        await rejection;
        await runMigrations(pool, config, logger, undefined, []);
        expect(
          (
            await pool.query(
              `SELECT * FROM "${config.DATABASE_SCHEMA}".schema_migrations`,
            )
          ).rows,
        ).toEqual([]);
      });
    });
  },
);
