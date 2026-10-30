import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, unlink, rmdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { describe, it, expect } from "vitest";
import { migrations } from "../src/migrations.js";

describe.skipIf(!process.env.TEST_DATABASE_URL)("compiled API startup", () => {
  it("keeps probes available, gates traffic, and migrates once across two replicas", async () => {
    const schema = "startup_test_" + randomUUID().replaceAll("-", "");
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const blocker = await pool.connect();
    const db = new URL(process.env.TEST_DATABASE_URL!);
    const key = `esatp:migrations:${db.pathname.slice(1)}:${schema}`;
    let locked = true;
    await blocker.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [
      key,
    ]);
    const folder = await mkdtemp(join(tmpdir(), "esatp-startup-test-"));
    const wrapper = join(folder, "start.mjs");
    await writeFile(
      wrapper,
      `process.once('message', () => { process.emit('SIGTERM'); process.disconnect(); }); await import(${JSON.stringify(pathToFileURL(resolve("dist/index.js")).href)});`,
    );
    const children: ChildProcess[] = [];
    const logs: string[] = [];
    async function port() {
      const socket = createServer();
      socket.listen(0, "127.0.0.1");
      await once(socket, "listening");
      const value = (socket.address() as { port: number }).port;
      await new Promise<void>((r) => socket.close(() => r()));
      return value;
    }
    async function response(base: string, path: string, expected: number) {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        try {
          const result = await fetch(base + path, {
            signal: AbortSignal.timeout(1000),
          });
          const body = await result.text();
          if (result.status === expected) return body;
        } catch {}
        await delay(50);
      }
      throw Error(`${path} did not return ${expected}`);
    }
    try {
      const bases: string[] = [];
      for (let i = 0; i < 2; i++) {
        const value = await port();
        bases.push(`http://127.0.0.1:${value}`);
        const child = spawn(process.execPath, [wrapper], {
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe", "ipc"],
          env: {
            ...process.env,
            NODE_ENV: "test",
            PORT: String(value),
            DATABASE_HOST: db.hostname,
            DATABASE_PORT: db.port || "5432",
            DATABASE_NAME: db.pathname.slice(1),
            DATABASE_USER: decodeURIComponent(db.username),
            DATABASE_PASSWORD: decodeURIComponent(db.password) || "test-only",
            DATABASE_SCHEMA: schema,
            DATABASE_SSL: "false",
            AWS_LOCAL: "false",
            AWS_REGION: "ap-southeast-1",
            S3_BUCKET: "test-only",
            OKTA_ISSUER: "https://example.okta.com/oauth2/default",
            OKTA_CLIENT_ID: "test-only",
            RATE_LIMIT_HMAC_SECRET:
              "test-only-startup-secret-at-least-32-characters",
            MIGRATION_LOCK_TIMEOUT_MS: "15000",
          },
        });
        children.push(child);
        child.stdout!.on("data", (chunk) => logs.push(String(chunk)));
        child.stderr!.resume();
      }
      for (const base of bases) {
        await response(base, "/api/healthz", 200);
        expect(JSON.parse(await response(base, "/api/readyz", 503))).toEqual({
          ready: false,
        });
        await response(base, "/api/admin/users", 503);
        await response(base, "/api/docs/", 200);
      }
      await blocker.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
        key,
      ]);
      locked = false;
      for (const base of bases) {
        expect(JSON.parse(await response(base, "/api/readyz", 200))).toEqual({
          ready: true,
        });
        await response(base, "/api/auth/me", 401);
      }
      expect(
        (await pool.query(`SELECT count(*) FROM "${schema}".schema_migrations`))
          .rows[0].count,
      ).toBe(String(migrations.length));
      const applied = logs
        .join("")
        .split("\n")
        .filter((line) =>
          line.includes('"event":"database.migration_applied"'),
        );
      expect(applied).toHaveLength(migrations.length);
    } finally {
      if (locked)
        await blocker.query(
          "SELECT pg_advisory_unlock(hashtextextended($1,0))",
          [key],
        );
      blocker.release();
      for (const child of children) {
        if (child.exitCode === null) {
          const exited = once(child, "exit");
          if (child.connected) child.send("stop");
          else child.kill();
          const timer = setTimeout(() => child.kill(), 5000);
          await exited;
          clearTimeout(timer);
        }
      }
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
      await unlink(wrapper);
      await rmdir(folder);
    }
  }, 40000);
});
