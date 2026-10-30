import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { Pool } from "pg";
import { describe, it, expect } from "vitest";
import { migrations } from "../src/migrations.js";
import { createApplication } from "../src/app/createApp.js";
import type { AppDependencies } from "../src/app/dependencies.js";
import { securityHeadersApp } from "./fixtures/securityHeaders.js";

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "security audit with PostgreSQL",
  () => {
    it("persists admin changes atomically and protects audit history", async () => {
      const schema = `security_test_${randomUUID().replaceAll("-", "")}`;
      const pool = new Pool({
        connectionString: process.env.TEST_DATABASE_URL,
        options: `-c search_path=${schema},public`,
      });
      const admin = randomUUID();
      await pool.query(`CREATE SCHEMA ${schema}`);
      let server:
        ReturnType<ReturnType<typeof createApplication>["listen"]> | undefined;
      try {
        for (const m of migrations.filter((m) => !m.id.startsWith("029_")))
          await pool.query(m.sql);
        const oldId = randomUUID();
        await pool.query(
          "INSERT INTO security_audit_events(id,request_id,source_ip,method,action) VALUES($1,$2,'127.0.0.1','GET','historical.event')",
          [oldId, randomUUID()],
        );
        await pool.query(
          "INSERT INTO app_user(id,email,is_admin) VALUES($1,'admin@example.test',true)",
          [admin],
        );
        const { config } = securityHeadersApp();
        const app = createApplication({
          pool,
          config,
          processingPipelineStorage: {},
          stepFunctionsRunner: {},
          logger: { info() {}, error() {} },
          rateLimiter: {
            consume: async () => ({
              allowed: true,
              remaining: 100,
              resetAt: new Date(Date.now() + 60000),
            }),
          },
          authenticate: (req, _res, next) => {
            req.auth = {
              userId: admin,
              oktaSubject: "test",
              email: "admin@example.test",
              displayName: null,
              createdAt: new Date(),
              isAdmin: true,
              tokenExpiresAt: new Date(Date.now() + 60000),
            };
            next();
          },
        } as unknown as AppDependencies);
        server = app.listen(0, "127.0.0.1");
        await once(server, "listening");
        const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const notMigrated = await fetch(`${base}/api/readyz`);
        expect(notMigrated.status).toBe(503);
        await notMigrated.text();
        await pool.query(migrations.find((m) => m.id.startsWith("029_"))!.sql);
        const historical = await pool.query(
          "SELECT action_outcome,environment FROM security_audit_events WHERE id=$1",
          [oldId],
        );
        expect(historical.rows[0]).toEqual({
          action_outcome: "unknown",
          environment: "unknown",
        });
        const readiness = await fetch(`${base}/api/readyz`);
        expect(readiness.status).toBe(200);
        expect(await readiness.json()).toEqual({ ready: true });
        // Express matches these as the same endpoint; durable bootstrap auditing must too.
        for (const path of [
          "/api/auth/me",
          "/API/AUTH/ME",
          "/api/auth/me/?from=review",
        ]) {
          const session = await fetch(base + path);
          expect(session.status).toBe(200);
          expect((await session.json()).user.id).toBe(admin);
        }
        const sessions = await pool.query(
          "SELECT actor_user_id,request_id FROM security_audit_events WHERE action='auth.session_validated'",
        );
        expect(sessions.rows).toHaveLength(3);
        expect(sessions.rows.every((row) => row.actor_user_id === admin)).toBe(
          true,
        );
        expect(new Set(sessions.rows.map((row) => row.request_id)).size).toBe(
          3,
        );
        const created = await fetch(`${base}/api/admin/users`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "new@example.test" }),
        });
        expect(created.status).toBe(201);
        const { user } = await created.json();
        const profile = await fetch(`${base}/api/admin/users/${admin}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ firstName: "Updated" }),
        });
        expect(profile.status).toBe(200);
        expect((await profile.json()).user).toMatchObject({
          isAdmin: true,
          isActive: true,
        });
        await pool.query(
          "UPDATE app_user SET is_active=false,is_admin=true WHERE id=$1",
          [user.id],
        );
        const inactiveProfile = await fetch(
          `${base}/api/admin/users/${user.id}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ firstName: "Inactive" }),
          },
        );
        expect(inactiveProfile.status).toBe(200);
        expect((await inactiveProfile.json()).user).toMatchObject({
          isAdmin: true,
          isActive: false,
        });
        const audit = await pool.query(
          "SELECT * FROM security_audit_events WHERE action='user.created'",
        );
        expect(audit.rows).toHaveLength(1);
        expect(audit.rows[0].actor_user_id).toBe(admin);
        expect(audit.rows[0].action_outcome).toBe("success");
        expect(audit.rows[0].environment).toBe("unknown");
        expect(audit.rows[0].access_port).toBeGreaterThan(0);
        expect(audit.rows[0].detail.targetUserId).toBe(user.id);
        for (const sql of [
          "UPDATE security_audit_events SET action='tampered'",
          "DELETE FROM security_audit_events",
          "TRUNCATE security_audit_events",
        ])
          await expect(pool.query(sql)).rejects.toThrow("append-only");
        const runtimeRole = `audit_writer_${randomUUID().replaceAll("-", "")}`;
        await pool.query(`CREATE ROLE ${runtimeRole} NOLOGIN`);
        try {
          await pool.query(
            `GRANT USAGE ON SCHEMA ${schema} TO ${runtimeRole}; GRANT INSERT ON security_audit_events TO ${runtimeRole}`,
          );
          const restricted = await pool.connect();
          try {
            await restricted.query(`SET ROLE ${runtimeRole}`);
            await restricted.query(
              "INSERT INTO security_audit_events(id,request_id,source_ip,method,action) VALUES($1,$2,'127.0.0.1','POST','permission.probe')",
              [randomUUID(), randomUUID()],
            );
            await expect(
              restricted.query("SELECT * FROM security_audit_events"),
            ).rejects.toThrow("permission denied");
            await expect(
              restricted.query("DELETE FROM security_audit_events"),
            ).rejects.toThrow("permission denied");
          } finally {
            await restricted.query("RESET ROLE");
            restricted.release();
          }
        } finally {
          await pool.query(
            `DROP OWNED BY ${runtimeRole}; DROP ROLE ${runtimeRole}`,
          );
        }
        // A failed mandatory security audit must roll back the account mutation too.
        await pool.query(
          `CREATE FUNCTION reject_test_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test audit unavailable'; END; $$; CREATE TRIGGER reject_test_audit BEFORE INSERT ON security_audit_events FOR EACH ROW EXECUTE FUNCTION reject_test_audit();`,
        );
        const failed = await fetch(`${base}/api/admin/users`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "rollback@example.test" }),
        });
        expect(failed.status).toBe(503);
        await failed.text();
        expect(
          (
            await pool.query(
              "SELECT 1 FROM app_user WHERE email='rollback@example.test'",
            )
          ).rows,
        ).toHaveLength(0);
        expect(
          (await pool.query("SELECT 1 FROM app_rbac_audit_events")).rows,
        ).toHaveLength(3);
      } finally {
        if (server)
          await new Promise<void>((resolve) => server!.close(() => resolve()));
        await pool.query(`DROP SCHEMA ${schema} CASCADE`);
        await pool.end();
      }
    }, 30000);
  },
);
