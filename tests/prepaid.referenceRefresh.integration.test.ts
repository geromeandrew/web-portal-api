import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { Server } from "node:http";
import express from "express";
import multer from "multer";
import { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { migratePrepaid } from "../src/modules/prepaid/infrastructure/migrationRunner.js";
import { PrepaidRepository } from "../src/modules/prepaid/infrastructure/repository.js";
import { PrepaidStorage } from "../src/modules/prepaid/infrastructure/prepaidStorage.js";
import { PostgresReferenceSource } from "../src/modules/prepaid/infrastructure/referenceSource.js";
import { PrepaidReferenceRefreshService } from "../src/modules/prepaid/application/referenceRefreshService.js";
import { PrepaidReferenceRefreshWorker } from "../src/modules/prepaid/application/referenceRefreshWorker.js";
import { PrepaidReferenceProvider } from "../src/modules/prepaid/application/referenceProvider.js";
import { legacyReferenceFields } from "../src/modules/prepaid/domain/referenceRefresh.js";
import { SharedExtractionBusy } from "../src/modules/prepaid/infrastructure/legacyLanding.js";
import { createPrepaidRouter } from "../src/modules/prepaid/api/router.js";
import { createErrorHandler } from "../src/errors.js";
import type { AppDependencies } from "../src/app/dependencies.js";

const url = process.env.PREPAID_TEST_DATABASE_URL;
if (url) {
  const parsed = new URL(url);
  if (
    parsed.hostname !== "127.0.0.1" ||
    parsed.port !== "55479" ||
    parsed.username !== "prepaid_test"
  )
    throw Error("Use only the isolated prepaid_test cluster on port 55479.");
}
describe.skipIf(!url)("SAP reference operation (disposable PostgreSQL)", () => {
  const schema = `prepaid_reference_${randomUUID().replaceAll("-", "")}`;
  const raw = `${schema}_raw`,
    references = `${schema}_sap`;
  const pool = new Pool({
    connectionString: url,
    options: `-c search_path=${schema}`,
    max: 5,
  });
  const repo = new PrepaidRepository(pool, schema),
    service = new PrepaidReferenceRefreshService(repo);
  const source = new PostgresReferenceSource(pool, references);
  const admin = randomUUID(),
    member = randomUUID();
  const objects = new Map<string, Buffer>();
  let lostPut = false,
    lostDispatch = false,
    foundRun: string | undefined,
    runState = "RUNNING",
    lockOwner: string | undefined;
  const storage = new PrepaidStorage(
    {
      send: async (command: any) => {
        const key = command.input.Key;
        if (command.constructor.name === "PutObjectCommand") {
          if (objects.has(key))
            throw Object.assign(Error("exists"), {
              $metadata: { httpStatusCode: 412 },
            });
          objects.set(key, Buffer.from(command.input.Body));
          if (lostPut) {
            lostPut = false;
            throw Error("S3 response lost after write");
          }
          return {};
        }
        const bytes = objects.get(key);
        if (!bytes) throw Error("Missing object");
        return { Body: Readable.from([bytes]), ContentLength: bytes.length };
      },
    } as any,
    "test-reference-bucket",
  );
  const runner = {
    verify: vi.fn(async () => {}),
    idle: vi.fn(async () => {}),
    start: vi.fn(async () => {
      if (lostDispatch) throw Error("Glue response lost");
      return "jr_original";
    }),
    find: vi.fn(async () => foundRun),
    describe: vi.fn(async () => runState),
  };
  const coordination = {
    acquire: vi.fn(async (owner: string) => {
      if (lockOwner && lockOwner !== owner) throw Error("Another owner");
      lockOwner = owner;
    }),
    release: vi.fn(async (owner: string) => {
      if (lockOwner && lockOwner !== owner) throw Error("Different owner");
      lockOwner = undefined;
    }),
  };
  const idle = vi.fn(async () => {}),
    logger = { info: vi.fn(), error: vi.fn() };
  const worker = new PrepaidReferenceRefreshWorker(
    repo,
    storage,
    runner,
    source,
    coordination,
    idle,
    logger,
  );
  const row = {
    MANDT: "300",
    BUKRS: "GLOB",
    HKONT: "00123",
    BRAND: "GHP-PREPAID",
    WWSPA: "EG",
    WWBRD: "GP",
    SPB: "SUB",
    WWST: "MT",
    PSTKY: "50",
    GLDEF: "",
    INTLIND: "",
    TAXRATE: "0.12000000",
    DUOM: "EA",
    EXSPB: "",
    AVERATE: "10.12345678",
    ULI: "",
    SUBSER: "",
  };
  let server: Server, base: string;
  const request = (mode = "export_existing") => ({
    idempotencyKey: randomUUID(),
    mode,
    period: "2026-09",
    scopeApproved: true,
    ...(mode === "refresh_and_export" ? { sharedWritesApproved: true } : {}),
  });
  const get = (id: string) => service.get(admin, id);
  async function tick() {
    await pool.query(
      `UPDATE ${repo.table("reference_refreshes")} SET available_at=now()`,
    );
    return worker.tick();
  }
  async function seed(extra: Partial<typeof row> = {}) {
    const values = { ...row, ...extra };
    await pool.query(
      `INSERT INTO "${references}".ztf0455s VALUES(${legacyReferenceFields.map((_, n) => `$${n + 1}`).join(",")})`,
      legacyReferenceFields.map((name) => values[name]),
    );
  }
  beforeAll(async () => {
    await pool.query(`CREATE SCHEMA "${schema}"; CREATE SCHEMA "${references}";
      CREATE TABLE "${schema}".app_user(id uuid PRIMARY KEY,is_active boolean NOT NULL DEFAULT true,is_admin boolean NOT NULL DEFAULT false);
      CREATE TABLE "${schema}".workspaces(id uuid PRIMARY KEY,user_id uuid UNIQUE REFERENCES "${schema}".app_user(id));
      CREATE TABLE "${schema}".app_modules(module_id text PRIMARY KEY,is_active boolean DEFAULT true);
      CREATE TABLE "${schema}".app_user_modules(user_id uuid,module_id text);
      INSERT INTO "${schema}".app_modules VALUES('prepaid_reclass',true);
      CREATE TABLE "${references}".ztf0455s(${legacyReferenceFields.map((name) => `"${name.toLowerCase()}" ${["TAXRATE", "AVERATE"].includes(name) ? "numeric(17,8)" : "text"}`).join(",")});`);
    await pool.query(
      "INSERT INTO app_user(id,is_admin) VALUES($1,true),($2,false)",
      [admin, member],
    );
    await pool.query(
      "INSERT INTO app_user_modules VALUES($1,'prepaid_reclass')",
      [member],
    );
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      await migratePrepaid(db, schema, raw);
      await db.query("COMMIT");
    } finally {
      db.release();
    }
    const app = express();
    app.use(express.json());
    app.use(
      "/prepaid",
      createPrepaidRouter(
        {
          pool,
          config: { DATABASE_SCHEMA: schema },
          prepaidStorage: storage,
          authenticate: (req: any, _res: any, next: any) => {
            req.auth = { userId: req.headers["x-test-user"] ?? admin };
            next();
          },
        } as unknown as AppDependencies,
        multer().single("file"),
      ),
    );
    app.use(createErrorHandler(logger, { DATABASE_SCHEMA: schema } as any));
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    base = `http://127.0.0.1:${(server.address() as any).port}/prepaid`;
  });
  beforeEach(async () => {
    await pool.query(
      `DELETE FROM ${repo.table("reference_refreshes")}; DELETE FROM "${references}".ztf0455s`,
    );
    await seed();
    objects.clear();
    lostPut = false;
    lostDispatch = false;
    foundRun = undefined;
    runState = "RUNNING";
    lockOwner = undefined;
    vi.clearAllMocks();
  });
  afterAll(async () => {
    if (server)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    // Generated test-owned schemas only, on the explicitly guarded disposable DB.
    await pool.query(
      `DROP SCHEMA "${references}" CASCADE; DROP SCHEMA "${raw}" CASCADE; DROP SCHEMA "${schema}" CASCADE`,
    );
    await pool.end();
  });
  it("exports exact original fields/decimals, scopes rows, and plugs directly into the current provider", async () => {
    await seed({ MANDT: "100" });
    await seed({ BUKRS: "OTHR" });
    const job = await service.create(admin, request());
    await tick();
    const done = await get(job.id);
    expect(done.status).toBe("completed");
    expect(runner.start).not.toHaveBeenCalled();
    expect(runner.verify).not.toHaveBeenCalled();
    expect(done.provenance).toMatchObject({
      client: "300",
      company: "GLOB",
      rowCount: 1,
      mappingApproved: false,
      sapSource: null,
      jobName: null,
      scriptSha256: null,
    });
    const descriptor = done.result.referenceExport;
    expect(descriptor.approved).toBeUndefined();
    const rawRow = JSON.parse(objects.get(descriptor.key)!.toString());
    expect(rawRow).toEqual(row);
    const loaded = await new PrepaidReferenceProvider(storage).load(
      descriptor,
      "2026-09",
    );
    expect(loaded.rows[0]).toMatchObject({
      cost_element: "0000000123",
      average_rate: "10.12345678",
      source_brand: "GHP-PREPAID",
    });
    expect(lockOwner).toBeUndefined();
    expect(
      (
        await pool.query(
          `SELECT source_bytes FROM ${repo.table("reference_refreshes")} WHERE id=$1`,
          [job.id],
        )
      ).rows[0].source_bytes,
    ).toBeNull();
  });
  it("enforces idempotency and permits only one nonterminal reference operation", async () => {
    const input = request();
    const a = await service.create(admin, input);
    expect((await service.create(admin, input)).id).toBe(a.id);
    await expect(
      service.create(admin, { ...input, period: "2026-10" }),
    ).rejects.toThrow("different reference request");
    await expect(service.create(admin, request())).rejects.toThrow(
      "Another reference operation",
    );
  });
  it("refreshes once, waits for success, then exports; it never auto-approves integration", async () => {
    const job = await service.create(admin, request("refresh_and_export"));
    await tick();
    expect((await get(job.id)).phase).toBe("running");
    expect(objects.size).toBe(0);
    await tick();
    expect((await get(job.id)).status).toBe("waiting");
    runState = "SUCCEEDED";
    await tick();
    expect((await get(job.id)).status).toBe("completed");
    expect(runner.start).toHaveBeenCalledTimes(1);
    expect(
      (
        await pool.query(
          `SELECT count(*)::int count FROM ${repo.table("integrations")}`,
        )
      ).rows[0].count,
    ).toBe(0);
  });
  it("keeps the shared lock on an uncertain start and reconciles the original run without another overwrite", async () => {
    lostDispatch = true;
    const job = await service.create(admin, request("refresh_and_export"));
    await tick();
    expect((await get(job.id)).status).toBe("unknown");
    expect(lockOwner).toBe(`reference:${job.id}`);
    expect(await worker.tick()).toBe(false);
    await service.reconcile(admin, job.id);
    await tick();
    expect((await get(job.id)).status).toBe("unknown");
    foundRun = "jr_original";
    runState = "SUCCEEDED";
    await service.reconcile(admin, job.id);
    await tick();
    expect((await get(job.id)).status).toBe("completed");
    expect(runner.start).toHaveBeenCalledTimes(1);
  });
  it("recovers a crash after persisted dispatch intent without calling StartJobRun again", async () => {
    const job = await service.create(admin, request("refresh_and_export"));
    await pool.query(
      `UPDATE ${repo.table("reference_refreshes")} SET phase='dispatching',status='running',lease_until=now()-interval '1 second' WHERE id=$1`,
      [job.id],
    );
    foundRun = "jr_crash";
    runState = "SUCCEEDED";
    await tick();
    expect((await get(job.id)).status).toBe("completed");
    expect(runner.start).not.toHaveBeenCalled();
  });
  it("reuses durable snapshot bytes after a lost S3 acknowledgement, even if the shared table changes", async () => {
    const job = await service.create(admin, request());
    lostPut = true;
    await tick();
    expect((await get(job.id)).phase).toBe("publishing");
    await pool.query(`UPDATE "${references}".ztf0455s SET averate=99`);
    await tick();
    const done = await get(job.id);
    expect(done.status).toBe("completed");
    expect(
      JSON.parse(objects.get(done.result.referenceExport.key)!.toString())
        .AVERATE,
    ).toBe(row.AVERATE);
  });
  it("rejects empty/invalid real mappings rather than publishing synthetic rows", async () => {
    await pool.query(`DELETE FROM "${references}".ztf0455s`);
    const job = await service.create(admin, request());
    await tick();
    expect((await get(job.id)).status).toBe("failed");
    expect(objects.size).toBe(0);
    expect(lockOwner).toBeUndefined();
    await seed({ HKONT: "INVALID" });
    const bad = await service.create(admin, request());
    await tick();
    expect((await get(bad.id)).status).toBe("failed");
    expect(objects.size).toBe(0);
  });
  it("does not export after a known failed Glue job and releases its lock with a recovery warning", async () => {
    const job = await service.create(admin, request("refresh_and_export"));
    await tick();
    runState = "FAILED";
    await tick();
    const failed = await get(job.id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("table may be incomplete");
    expect(objects.size).toBe(0);
    expect(lockOwner).toBeUndefined();
  });
  it("does not dispatch if destination verification fails", async () => {
    runner.verify.mockRejectedValueOnce(Error("different database"));
    const job = await service.create(admin, request("refresh_and_export"));
    await tick();
    expect((await get(job.id)).status).toBe("failed");
    expect(runner.start).not.toHaveBeenCalled();
    expect(lockOwner).toBeUndefined();
  });
  it("exports existing data even when the unrelated refresh-job destination is incompatible", async () => {
    runner.verify.mockRejectedValue(
      Error("shared job targets a different database"),
    );
    try {
      await pool.query(`UPDATE "${references}".ztf0455s SET duom=''`);
      const job = await service.create(admin, request());
      await tick();
      const done = await get(job.id);
      expect(done.status).toBe("completed");
      expect(runner.verify).not.toHaveBeenCalled();
      expect(runner.start).not.toHaveBeenCalled();
      const loaded = await new PrepaidReferenceProvider(storage).load(
        done.result.referenceExport,
        "2026-09",
      );
      expect(loaded.rows[0].uom).toBe("");
    } finally {
      runner.verify.mockResolvedValue(undefined);
    }
  });
  it("waits for shared extraction ownership instead of failing or overwriting", async () => {
    coordination.acquire.mockRejectedValueOnce(
      new SharedExtractionBusy("Another source owns the lock"),
    );
    const job = await service.create(admin, request("refresh_and_export"));
    await tick();
    expect((await get(job.id)).status).toBe("waiting");
    expect(runner.start).not.toHaveBeenCalled();
    expect(coordination.release).not.toHaveBeenCalled();
    await tick();
    expect(runner.start).toHaveBeenCalledTimes(1);
  });
  it("does not dispatch after another worker takes its database lease", async () => {
    const job = await service.create(admin, request("refresh_and_export"));
    const replacementToken = randomUUID();
    runner.verify.mockImplementationOnce(async () => {
      await pool.query(
        `UPDATE ${repo.table("reference_refreshes")} SET lease_token=$2 WHERE id=$1`,
        [job.id, replacementToken],
      );
    });
    await tick();
    expect(runner.start).not.toHaveBeenCalled();
    const saved = (
      await pool.query(
        `SELECT lease_token,phase,status FROM ${repo.table("reference_refreshes")} WHERE id=$1`,
        [job.id],
      )
    ).rows[0];
    expect(saved).toEqual({
      lease_token: replacementToken,
      phase: "queued",
      status: "running",
    });
  });
  it("recovers a lost lock-release acknowledgment without re-reading or re-dispatching", async () => {
    const job = await service.create(admin, request());
    coordination.release.mockImplementationOnce(async () => {
      lockOwner = undefined;
      throw Error("Release response lost");
    });
    await tick();
    expect((await get(job.id)).phase).toBe("releasing");
    await pool.query(`DELETE FROM "${references}".ztf0455s`);
    await tick();
    expect((await get(job.id)).status).toBe("completed");
    expect(runner.start).not.toHaveBeenCalled();
  });
  it("checks all 17 source columns and rejects floating point before a refresh", async () => {
    await pool.query(
      `ALTER TABLE "${references}".ztf0455s ALTER COLUMN taxrate TYPE double precision`,
    );
    try {
      const job = await service.create(admin, request("refresh_and_export"));
      await tick();
      expect((await get(job.id)).status).toBe("failed");
      expect(runner.start).not.toHaveBeenCalled();
    } finally {
      await pool.query(
        `ALTER TABLE "${references}".ztf0455s ALTER COLUMN taxrate TYPE numeric(17,8)`,
      );
    }
  });
  it("exposes admin-only HTTP queue/poll/reconcile and never returns internal snapshot bytes", async () => {
    for (const method of ["POST", "GET"] as const) {
      const response = await fetch(
        `${base}/reference-exports${method === "GET" ? "/" + randomUUID() : ""}`,
        {
          method,
          headers: {
            "content-type": "application/json",
            "x-test-user": member,
          },
          ...(method === "POST" ? { body: JSON.stringify(request()) } : {}),
        },
      );
      const body = await response.json();
      expect(response.status, JSON.stringify(body)).toBe(403);
    }
    const denied = await fetch(
      `${base}/reference-exports/${randomUUID()}/reconcile`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-user": member },
        body: "{}",
      },
    );
    expect(denied.status).toBe(403);
    const response = await fetch(`${base}/reference-exports`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request()),
    });
    expect(response.status).toBe(202);
    const queued: any = await response.json();
    await tick();
    const result: any = await (
      await fetch(`${base}/reference-exports/${queued.id}`)
    ).json();
    expect(result.status).toBe("completed");
    expect(result.source_bytes).toBeUndefined();
    expect(result.lease_token).toBeUndefined();
    const conflict = await fetch(
      `${base}/reference-exports/${queued.id}/reconcile`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );
    expect(conflict.status).toBe(409);
  });
  it("reports missing additive migration 009 without breaking the existing core API", async () => {
    await pool.query(
      `ALTER TABLE ${repo.table("reference_refreshes")} RENAME TO prepaid_reference_refreshes_test_saved`,
    );
    try {
      const readiness: any = await (await fetch(`${base}/readiness`)).json();
      expect(readiness.schemaInstalled).toBe(true);
      expect(readiness.referenceExportsAvailable).toBe(false);
      const existingIntegration = await fetch(`${base}/integration`);
      expect(existingIntegration.status).toBe(409); // Normal missing configuration, not a schema failure.
      expect(((await existingIntegration.json()) as any).error.code).toBe(
        "PREPAID_INTEGRATION_NOT_CONFIGURED",
      );
      const missing = await fetch(`${base}/reference-exports`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request()),
      });
      expect(missing.status).toBe(503);
      expect(((await missing.json()) as any).error.code).toBe(
        "PREPAID_REFERENCE_SCHEMA_NOT_INSTALLED",
      );
    } finally {
      await pool.query(
        `ALTER TABLE "${schema}".prepaid_reference_refreshes_test_saved RENAME TO prepaid_reference_refreshes`,
      );
    }
  });
});
