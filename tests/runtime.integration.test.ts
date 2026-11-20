import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { once } from "node:events";
import { createServer } from "node:net";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrations } from "../src/migrations.js";
import { migratePrepaid } from "../src/modules/prepaid/infrastructure/migrationRunner.js";

const url = process.env.PREPAID_TEST_DATABASE_URL;
if (url) {
  const parsed = new URL(url);
  if (
    parsed.hostname !== "127.0.0.1" ||
    parsed.port !== "55479" ||
    parsed.username !== "prepaid_test"
  )
    throw Error(
      "Runtime smoke tests require the isolated prepaid_test cluster on localhost:55479.",
    );
}
describe.skipIf(!url)(
  "Real default runtime startup (isolated PostgreSQL, no AWS jobs)",
  () => {
    const database = `runtime_smoke_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString: url, max: 1 });
    let pool: Pool;
    beforeAll(async () => {
      await admin.query(`CREATE DATABASE "${database}"`);
      const target = new URL(url!);
      target.pathname = `/${database}`;
      pool = new Pool({ connectionString: target.toString(), max: 1 });
      await pool.query(
        "CREATE SCHEMA web_portal; SET search_path TO web_portal,public; CREATE TABLE schema_migrations(id text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())",
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
    }, 30000);
    afterAll(async () => {
      if (pool) await pool.end();
      // Only the generated test-owned database on the guarded local cluster.
      await admin.query(`DROP DATABASE "${database}"`);
      await admin.end();
    });
    async function launch(args: string[], schema = "web_portal") {
      const probe = createServer().listen(0, "127.0.0.1");
      await once(probe, "listening");
      const port = (probe.address() as any).port;
      await new Promise<void>((resolve) => probe.close(() => resolve()));
      const env = {
        ...process.env,
        NODE_ENV: "test",
        PORT: String(port),
        DATABASE_HOST: "127.0.0.1",
        DATABASE_PORT: "55479",
        DATABASE_NAME: database,
        DATABASE_USER: "prepaid_test",
        DATABASE_PASSWORD: "test-only",
        DATABASE_SSL: "false",
        DATABASE_SCHEMA: schema,
        OKTA_ISSUER: "https://example.invalid/oauth2/default",
        OKTA_CLIENT_ID: "test-only",
        RATE_LIMIT_HMAC_SECRET: "test-only-secret-with-at-least-32-characters",
        AWS_LOCAL: "true",
        AWS_ACCESS_KEY_ID: "test-only",
        AWS_SECRET_ACCESS_KEY: "test-only",
        AWS_REGION: "us-east-1",
        S3_BUCKET: "isolated-runtime-test",
      };
      const child = spawn(process.execPath, args, {
        env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout!.on("data", (chunk) => (output += chunk));
      child.stderr!.on("data", (chunk) => (output += chunk));
      return { child, port, output: () => output };
    }
    async function stop(child: ChildProcess) {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
    const entries = [
      {
        name: "source entrypoint used by local",
        args: ["--import", "tsx", "src/index.ts"],
        available: true,
      },
      {
        name: "compiled entrypoint used by start/Docker",
        args: ["dist/index.js"],
        available: existsSync(new URL("../dist/index.js", import.meta.url)),
      },
    ];
    for (const entry of entries)
      it.skipIf(!entry.available)(
        entry.name,
        async () => {
          const process = await launch(entry.args);
          try {
            await expect
              .poll(() => process.output(), { timeout: 15000 })
              .toContain('"event":"prepaid.worker.ready"');
            expect(process.output()).toContain('"event":"api.listening"');
            expect(
              (await fetch(`http://127.0.0.1:${process.port}/api/healthz`))
                .status,
            ).toBe(200);
            expect(
              (
                await pool.query(
                  "SELECT count(*)::int count FROM web_portal.prepaid_integrations",
                )
              ).rows[0].count,
            ).toBe(0);
            expect(
              (
                await pool.query(
                  "SELECT count(*)::int count FROM web_portal.prepaid_jobs",
                )
              ).rows[0].count,
            ).toBe(0);
          } finally {
            await stop(process.child);
          }
        },
        20000,
      );
    it("exits nonzero and closes the API if worker schema is missing", async () => {
      const process = await launch(
        ["--import", "tsx", "src/index.ts"],
        "missing_runtime_schema",
      );
      try {
        await expect
          .poll(() => process.child.exitCode, { timeout: 15000 })
          .toBe(1);
        expect(process.output()).toContain("Install Prepaid migrations");
        await expect(
          fetch(`http://127.0.0.1:${process.port}/api/healthz`),
        ).rejects.toThrow();
      } finally {
        await stop(process.child);
      }
    }, 20000);
  },
);
