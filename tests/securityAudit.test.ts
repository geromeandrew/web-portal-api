import { createRequire } from "node:module";
import { request as httpRequest } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import { describe, it, expect, vi } from "vitest";
import type { Pool } from "pg";
import { securityHeadersApp } from "./fixtures/securityHeaders.js";
import {
  requestAudit,
  requestContext,
  securityAudit,
  recordSecurityEffect,
} from "../src/platform/requestAudit.js";
import { createLogger, sanitizeLogFields } from "../src/platform/logger.js";
import { createErrorHandler, AppError } from "../src/errors.js";
import { withTransaction } from "../src/db.js";

async function serve(
  app: express.Express,
  run: (base: string) => Promise<void>,
) {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
describe("security regression", () => {
  it("keeps codes out of selected error bodies and blocks WebDAV before auth/database", async () => {
    const f = securityHeadersApp();
    await serve(f.app, async (base) => {
      const denied = await fetch(`${base}/api/healthz`, {
        headers: { Origin: "https://evil.example" },
      });
      expect(denied.status).toBe(403);
      expect(await denied.json()).toEqual({
        error: { message: "This browser origin is not allowed." },
      });
      const missing = await fetch(`${base}/missing`);
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({
        error: { message: "The requested API route was not found." },
      });
      for (const method of ["PROPFIND", "LOCK", "COPY"]) {
        const r = await fetch(`${base}/api/admin/users`, { method });
        expect(r.status).toBe(405);
        await r.text();
      }
      const traceStatus = await new Promise<number | undefined>(
        (resolve, reject) => {
          const req = httpRequest(
            `${base}/api/admin/users`,
            { method: "TRACE" },
            (res) => {
              res.resume();
              res.on("end", () => resolve(res.statusCode));
            },
          );
          req.on("error", reject);
          req.end();
        },
      );
      expect(traceStatus).toBe(405);
      expect(f.calls).toEqual({ database: 0, sharedLimiter: 0, auth: 0 });
      const cookie = await fetch(`${base}/api/admin/users`, {
        method: "POST",
        headers: {
          Cookie: "session=forged",
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      expect(cookie.status).toBe(401);
      await cookie.text();
    });
  });
  it("separates remote effects, persisted actions, partial responses and denied requests", async () => {
    const { config } = securityHeadersApp();
    const logger = { info: vi.fn(), error: vi.fn() };
    const query = vi.fn(async (_sql: string, _values: unknown[]) => ({
      rows: [],
    }));
    const app = express();
    app.use(requestAudit(logger, config));
    app.post(
      "/api/processing-pipelines/:pipelineCode/batch-runs",
      async (_req, res) => {
        requestContext.getStore()!.userId = "verified-internal-user";
        recordSecurityEffect("processing.started", {
          pipelineCode: "memo_sst",
          runId: "one",
          objectKey: "private-secret.xlsx",
        });
        await securityAudit(
          { query } as unknown as Pool,
          "processing.started",
          { pipelineCode: "memo_sst" },
        );
        res.status(207).json({ partial: true });
      },
    );
    app.get("/api/admin/users", (_req, res) => res.status(403).end());
    app.post(
      "/api/processing-pipelines/:pipelineCode/files",
      async (_req, res) => {
        recordSecurityEffect("file.uploaded", {
          pipelineCode: "memo_sst",
          objectKey: "private-secret.xlsx",
        });
        await securityAudit({ query } as unknown as Pool, "file.uploaded");
        res.status(500).end(); // later bookkeeping failed after the remote write
      },
    );
    await serve(app, async (base) => {
      for (const [method, path] of [
        ["POST", "/api/processing-pipelines/memo_sst/batch-runs"],
        ["GET", "/api/admin/users?q=private-secret"],
        ["POST", "/api/processing-pipelines/memo_sst/files"],
      ]) {
        const response = await fetch(base + path, { method });
        await response.text();
      }
    });
    const entries = logger.info.mock.calls;
    expect(
      entries.filter(([e]) => e === "security.action").map(([, f]) => f),
    ).toEqual([
      expect.objectContaining({
        outcome: "partial",
        userId: "verified-internal-user",
      }),
      expect.objectContaining({
        outcome: "denied",
        action: "admin.users.read",
      }),
      expect.objectContaining({ outcome: "failure", action: "file.upload" }),
    ]);
    expect(entries.filter(([e]) => e === "security.effect")).toHaveLength(2);
    expect(
      entries.find(
        ([e, f]) => e === "security.audit" && f?.action === "file.uploaded",
      )?.[1],
    ).toMatchObject({ outcome: "failure", actionOutcome: "success" });
    expect(JSON.stringify(entries)).not.toContain("private-secret");
    // The collector supplies trusted deployment attribution; the API does not guess it.
    expect(JSON.stringify(entries)).not.toContain('"environment"');
    expect(
      query.mock.calls.every(([, values]) => values[10] === "unknown"),
    ).toBe(true);
  });
  it("isolates concurrent contexts, logs safe errors and persists no secrets", async () => {
    const { config } = securityHeadersApp();
    const logger = { info: vi.fn(), error: vi.fn() };
    const query = vi.fn(async () => ({ rows: [] }));
    const app = express();
    app.use(requestAudit(logger, config));
    app.get("/work/:id", async (req, res) => {
      const c = requestContext.getStore()!;
      c.userId = req.params.id;
      await new Promise((resolve) =>
        setTimeout(resolve, req.params.id === "one" ? 20 : 1),
      );
      await securityAudit({ query } as unknown as Pool, "file.read", {
        password: "secret",
        runId: req.params.id,
      });
      res.json({ id: c.requestId });
    });
    app.get("/fail", () => {
      throw new AppError(500, "PRIVATE_CODE", "private database detail");
    });
    app.use(createErrorHandler(logger, config));
    await serve(app, async (base) => {
      const replies = await Promise.all(
        ["one", "two"].map((id) =>
          fetch(`${base}/work/${id}?token=secret`, {
            headers: {
              Authorization: "Bearer raw-secret",
              Referer: "https://portal.example/path?token=secret",
              "User-Agent": "password=secret",
            },
          }),
        ),
      );
      const bodies = await Promise.all(replies.map((r) => r.json()));
      expect(bodies[0].id).not.toBe(bodies[1].id);
      const r = await fetch(`${base}/fail`);
      expect(r.status).toBe(500);
      expect(await r.json()).toEqual({
        error: { message: "An unexpected server error occurred." },
      });
    });
    expect(query).toHaveBeenCalledTimes(2);
    const entries = logger.info.mock.calls
      .filter(([event]) => event === "http.access")
      .map(([, fields]) => fields);
    expect(entries.find((e) => e?.userId === "one")?.requestId).not.toBe(
      entries.find((e) => e?.userId === "two")?.requestId,
    );
    expect(
      JSON.stringify([query.mock.calls, logger.info.mock.calls]),
    ).not.toContain("secret");
  });
  it("rolls back business changes on strict audit failure, but tolerates supplemental audit failure", async () => {
    const logger = { info: vi.fn(), error: vi.fn() };
    const events: Record<string, unknown>[] = [];
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO security_audit"))
        throw Error("unavailable");
      return { rows: [] };
    });
    const release = vi.fn();
    const db = {
      query,
      connect: async () => ({ query, release }),
    } as unknown as Pool;
    await requestContext.run(
      {
        requestId: "test",
        sourceIp: "local",
        method: "POST",
        port: 1,
        userId: "actor",
        events,
        logger,
      },
      async () => {
        await expect(
          withTransaction(db, async (client) => {
            await securityAudit(client, "user.updated", {}, true);
          }),
        ).rejects.toThrow("unavailable");
        expect(query.mock.calls.map((c) => c[0])).toContain("ROLLBACK");
        expect(events).toEqual([]);
        await expect(
          securityAudit(db, "file.uploaded"),
        ).resolves.toBeUndefined();
        expect(events[0].persistence).toBe("failed");
      },
    );
    expect(release).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      "security.audit_write_failed",
      expect.any(Object),
    );
  });
  it("discards queued success records when later SQL causes transaction rollback", async () => {
    const logger = { info: vi.fn(), error: vi.fn() };
    const events: Record<string, unknown>[] = [];
    const query = vi.fn(async () => ({ rows: [] }));
    const db = {
      connect: async () => ({ query, release() {} }),
    } as unknown as Pool;
    await requestContext.run(
      {
        requestId: "r",
        sourceIp: "local",
        method: "POST",
        port: 1,
        events,
        logger,
      },
      async () => {
        await expect(
          withTransaction(db, async (client) => {
            await securityAudit(client, "prepaid.layout.freeze", {}, true);
            expect(events).toEqual([]); // facts remain private until commit
            throw Error("later SQL failure");
          }),
        ).rejects.toThrow("later SQL failure");
        expect(events).toEqual([]);
      },
    );
    expect(query.mock.calls.map(([sql]) => sql)).toContain("ROLLBACK");
  });
  it.each([true, false])(
    "publishes only committed audit facts after a client disconnect (commit=%s)",
    async (commit) => {
      const { config } = securityHeadersApp();
      const logger = { info: vi.fn(), error: vi.fn() };
      const query = vi.fn(async () => ({ rows: [] }));
      const client = { query, release() {} };
      const db = { connect: async () => client } as unknown as Pool;
      let continueTransaction!: () => void;
      const gate = new Promise<void>((resolve) => {
        continueTransaction = resolve;
      });
      let closed!: () => void;
      const responseClosed = new Promise<void>((resolve) => {
        closed = resolve;
      });
      let settled!: () => void;
      const transactionSettled = new Promise<void>((resolve) => {
        settled = resolve;
      });
      const app = express();
      app.use(requestAudit(logger, config));
      app.post("/api/admin/users", async (_req, res) => {
        requestContext.getStore()!.userId = "actor";
        res.once("close", closed);
        try {
          await withTransaction(db, async (connection) => {
            await securityAudit(connection, "user.created", {}, true);
            res.write("working");
            await gate;
            if (!commit) throw Error("rollback after disconnect");
          });
          res.end();
        } catch {
          res.destroy();
        } finally {
          settled();
        }
      });
      await serve(app, async (base) => {
        await new Promise<void>((resolve, reject) => {
          const req = httpRequest(
            base + "/api/admin/users",
            { method: "POST" },
            (response) => {
              response.once("data", () => {
                response.destroy();
                resolve();
              });
            },
          );
          req.on("error", reject);
          req.end();
        });
        await responseClosed;
        expect(
          logger.info.mock.calls.filter(
            ([event]) => event === "security.audit",
          ),
        ).toEqual([]);
        continueTransaction();
        await transactionSettled;
      });
      const audits = logger.info.mock.calls.filter(
        ([event]) => event === "security.audit",
      );
      expect(audits).toHaveLength(commit ? 1 : 0);
      if (commit)
        expect(audits[0][1]).toMatchObject({
          action: "user.created",
          actionOutcome: "success",
          outcome: "aborted",
          userId: "actor",
        });
      expect(query.mock.calls.map(([sql]) => sql)).toContain(
        commit ? "COMMIT" : "ROLLBACK",
      );
    },
  );
  it("closes failed streams using safe logging without Express's raw-error fallback", async () => {
    const { config } = securityHeadersApp();
    const logger = { info: vi.fn(), error: vi.fn() };
    const app = express();
    app.use(requestAudit(logger, config));
    app.get("/stream-failure", async (_req, res) => {
      res.write("partial");
      await new Promise((resolve) => setTimeout(resolve, 10));
      throw Error("private-secret-error-detail");
    });
    app.use(createErrorHandler(logger, config));
    await serve(app, async (base) => {
      await new Promise<void>((resolve, reject) => {
        const req = httpRequest(base + "/stream-failure", (response) => {
          response.resume();
          response.on("aborted", resolve);
          response.on("end", resolve);
          response.on("error", () => {});
        });
        req.on("error", reject);
        req.end();
      });
    });
    expect(logger.error).toHaveBeenCalledWith(
      "api.response_stream_failed",
      expect.objectContaining({ errorName: "Error" }),
    );
    expect(
      JSON.stringify([logger.info.mock.calls, logger.error.mock.calls]),
    ).not.toContain("private-secret");
  });
  it("records an interrupted response once", async () => {
    const { config } = securityHeadersApp();
    const logger = { info: vi.fn(), error: vi.fn() };
    const app = express();
    app.use(requestAudit(logger, config));
    app.get("/api/processing-pipelines/memo_sst/files/content", (_req, res) => {
      res.write("partial");
    });
    await serve(app, async (base) => {
      await new Promise<void>((resolve, reject) => {
        const req = httpRequest(
          `${base}/api/processing-pipelines/memo_sst/files/content`,
          (res) => {
            res.once("data", () => {
              res.destroy();
              resolve();
            });
          },
        );
        req.on("error", reject);
        req.end();
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    const access = logger.info.mock.calls.filter(
      ([event]) => event === "http.access",
    );
    expect(access).toHaveLength(1);
    expect(access[0][1]).toMatchObject({ outcome: "aborted" });
    expect(
      logger.info.mock.calls.filter(([e]) => e === "security.action"),
    ).toEqual([
      [
        "security.action",
        expect.objectContaining({
          outcome: "aborted",
          actionOutcome: "aborted",
          action: "file.transfer",
        }),
      ],
    ]);
  });
  it("rejects inspector startup in production", () => {
    const previous = process.env.NODE_OPTIONS;
    try {
      process.env.NODE_OPTIONS = "--inspect=127.0.0.1:9229";
      expect(() => securityHeadersApp({ NODE_ENV: "production" })).toThrow(
        "Debug startup is disabled",
      );
    } finally {
      if (previous === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = previous;
    }
  });
  it("refuses mandatory auditing without request context", async () => {
    const query = vi.fn();
    await expect(
      securityAudit({ query } as unknown as Pool, "user.updated", {}, true),
    ).rejects.toThrow("Mandatory audit context");
    expect(query).not.toHaveBeenCalled();
  });
  it("keeps the Okta verifier JWT dependency working with patched UUID", () => {
    const require = createRequire(import.meta.url);
    const verifierRequire = createRequire(
      require.resolve("@okta/jwt-verifier"),
    );
    const jwt = verifierRequire("njwt");
    const signingKey = "offline-test-only-never-a-production-key";
    const token = jwt.create({ sub: "test-subject" }, signingKey).compact();
    expect(jwt.verify(token, signingKey).body.sub).toBe("test-subject");
  });
  it("drops payloads and reserved metadata and neutralizes log injection", () => {
    const clean = sanitizeLogFields({
      password: "secret",
      detail: { email: "private@example.com" },
      timestamp: "forged",
      errorStack: "secret",
      userAgent: "Bearer secret\nprivate@example.com",
    });
    expect(JSON.stringify(clean)).not.toMatch(
      /secret|private@example|forged|\\n/,
    );
    const output = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      requestContext.run(
        {
          requestId: "r",
          sourceIp: "local",
          method: "POST",
          port: 1,
          environment: "staging",
          events: [],
          logger: createLogger(),
        },
        () => {
          createLogger().error("security.audit_write_failed", {
            action: "user.updated",
          });
        },
      );
      expect(JSON.parse(output.mock.calls[0][0])).toMatchObject({
        event: "security.audit_write_failed",
        requestId: "r",
        environment: "staging",
      });
    } finally {
      output.mockRestore();
    }
  });
});
