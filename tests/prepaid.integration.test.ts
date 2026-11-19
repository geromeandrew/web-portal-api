import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prepaidWorkspaceMigrationSql } from "../src/modules/prepaid/infrastructure/workspaceMigration.js";
import { prepaidConsistencyMigrationSql } from "../src/modules/prepaid/infrastructure/consistencyMigration.js";
import { prepaidLegacyRulesMigrationSql } from "../src/modules/prepaid/infrastructure/legacyRulesMigration.js";
import { prepaidSourceExtractionMigrationSql } from "../src/modules/prepaid/infrastructure/sourceExtractionMigration.js";
import { prepaidAllSourceMigrationSql } from "../src/modules/prepaid/infrastructure/allSourceMigration.js";
import { prepaidSourceBackendMigrationSql } from "../src/modules/prepaid/infrastructure/sourceBackendMigration.js";
import { prepaidReferenceRefreshMigrationSql } from "../src/modules/prepaid/infrastructure/referenceRefreshMigration.js";
import { prepaidAccountingParityMigrationSql } from "../src/modules/prepaid/infrastructure/accountingParityMigration.js";
import { prepaidReferenceLookupMigrationSql } from "../src/modules/prepaid/infrastructure/referenceLookupMigration.js";
import { PrepaidWorkspaceService } from "../src/modules/prepaid/application/workspaceService.js";
import { approvedProvidedEgReportMapping } from "../src/modules/prepaid/domain/builtinConfiguration.js";
import { PrepaidPreparationWorker } from "../src/modules/prepaid/application/preparationWorker.js";
import { frozenReports } from "../src/modules/prepaid/application/reportService.js";
import { unzipSync } from "fflate";
import ExcelJS from "exceljs";
import { prepaidMigrationSql } from "../src/modules/prepaid/infrastructure/migrations.js";
import { PrepaidRepository } from "../src/modules/prepaid/infrastructure/repository.js";
import {
  PrepaidStorage,
  sha256,
} from "../src/modules/prepaid/infrastructure/prepaidStorage.js";
import { PrepaidRunService } from "../src/modules/prepaid/application/runService.js";
import { PrepaidWorker } from "../src/modules/prepaid/application/worker.js";
import {
  datasetSchemas,
  expectedName,
  jvHeaders,
  sourceCodes,
  manualIntegrationSchema,
  type Dataset,
  type Integration,
} from "../src/modules/prepaid/domain/contracts.js";
import type { StepFunctionsRunner } from "../src/stepFunctionsRunner.js";
import express from "express";
import multer from "multer";
import type { Server } from "node:http";
import { createPrepaidRouter } from "../src/modules/prepaid/api/router.js";
import { createErrorHandler } from "../src/errors.js";
import type { AppDependencies } from "../src/app/dependencies.js";
import type { Config } from "../src/config.js";

// Explicit opt-in. Never use the application's .env database for these tests.
const testUrl = process.env.PREPAID_TEST_DATABASE_URL;
if (testUrl) {
  const url = new URL(testUrl);
  if (
    url.hostname !== "127.0.0.1" ||
    url.port !== "55479" ||
    url.username !== "prepaid_test"
  )
    throw new Error(
      "Prepaid integration tests require the isolated localhost:55479 prepaid_test cluster.",
    );
}
describe.skipIf(!testUrl)("Prepaid backend (disposable PostgreSQL)", () => {
  const schema = `prepaid_test_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({
    connectionString: testUrl,
    options: `-c search_path=${schema}`,
    max: 10,
  });
  const repo = new PrepaidRepository(pool, schema);
  const objects = new Map<string, Buffer>();
  const send = vi.fn(async (command: any) => {
    const key = command.input.Key as string;
    if (command.constructor.name === "PutObjectCommand") {
      if (objects.has(key))
        throw Object.assign(new Error("exists"), {
          name: "PreconditionFailed",
          $metadata: { httpStatusCode: 412 },
        });
      objects.set(key, Buffer.from(command.input.Body));
      return {};
    }
    const bytes = objects.get(key);
    if (!bytes) throw new Error("Object missing");
    const body = Object.assign(Readable.from([bytes]), {
      transformToString: async () => bytes.toString(),
      transformToByteArray: async () => bytes,
    });
    return { Body: body, ContentLength: bytes.length };
  });
  const storage = new PrepaidStorage({ send } as any, "isolated-test-bucket");
  const service = new PrepaidRunService(repo, storage);
  const user = randomUUID(),
    otherUser = randomUUID();
  let server: Server;
  let base: string;
  let periodNo = 0;
  const configuration: Integration = {
    ingestStateMachine: "prepaid-ingest-test",
    deliveryStateMachine: "prepaid-delivery-test",
    target: "isolated-sap",
    expectedCycles: ["01", "02"],
    upstreamPrefix: "test-upstream/",
    format: {
      profile: "test-approved-only",
      approved: true,
      delimiter: "\t",
      lineEnding: "\r\n",
      encoding: "utf8",
      reversalSupported: true,
    },
  };
  const executionInputs = new Map<string, Record<string, any>>();
  const terminal = new Map<string, { status: string; output?: string }>();
  const start = vi.fn(
    async (_machine: string, input: Record<string, any>, name?: string) => {
      const arn = `arn:test:${name}`;
      executionInputs.set(arn, input);
      return { executionArn: arn, startedAt: new Date().toISOString() };
    },
  );
  const runner = {
    startExecution: start,
    describeStateMachine: async () => ({ type: "STANDARD", status: "ACTIVE" }),
    describeExecution: async (arn: string) => ({
      status: terminal.get(arn)?.status ?? "RUNNING",
      output: terminal.get(arn)?.output ?? null,
      outputIncluded: true,
      input: JSON.stringify(executionInputs.get(arn)),
      inputIncluded: true,
      errorCode: null,
      errorMessage: null,
      mapRunArn: null,
      traceHeader: null,
      startedAt: null,
      completedAt: null,
    }),
  } as StepFunctionsRunner;
  const logger = { info: vi.fn(), error: vi.fn() };
  const worker = new PrepaidWorker(repo, storage, runner, logger);
  const q = (sql: string, args?: unknown[]) => pool.query(sql, args);
  const jsonObject = (key: string, value: unknown) =>
    objects.set(key, Buffer.from(JSON.stringify(value)));
  beforeAll(async () => {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    await q(
      `CREATE TABLE app_user(id uuid PRIMARY KEY,email text DEFAULT 'test@example.com',display_name text DEFAULT 'Test User',is_active boolean DEFAULT true,is_admin boolean DEFAULT true); CREATE TABLE workspaces(id uuid PRIMARY KEY,user_id uuid UNIQUE REFERENCES app_user(id));`,
    );
    await q("INSERT INTO app_user(id) VALUES($1),($2)", [user, otherUser]);
    await q(
      "CREATE TABLE app_modules(module_id text PRIMARY KEY,is_active boolean DEFAULT true); CREATE TABLE app_user_modules(user_id uuid,module_id text); INSERT INTO app_modules(module_id) VALUES('prepaid_reclass')",
    );
    await q("UPDATE app_user SET is_admin=false WHERE id=$1;", [otherUser]);
    await q("INSERT INTO app_user_modules VALUES($1,'prepaid_reclass')", [
      otherUser,
    ]);
    await q(prepaidMigrationSql(schema));
    await q(prepaidWorkspaceMigrationSql(schema));
    await q(prepaidConsistencyMigrationSql(schema));
    await q(prepaidLegacyRulesMigrationSql(schema));
    await q(prepaidSourceExtractionMigrationSql(schema));
    await q(prepaidSourceBackendMigrationSql(schema));
    await q(prepaidAllSourceMigrationSql(schema, schema + "_raw"));
    await q(prepaidReferenceRefreshMigrationSql(schema));
    await q(prepaidAccountingParityMigrationSql(schema));
    await q(prepaidReferenceLookupMigrationSql(schema));
    await service.configure(user, configuration);
    const app = express();
    app.use(express.json());
    const config = { DATABASE_SCHEMA: schema } as Config;
    const dependencies = {
      pool,
      config,
      prepaidStorage: storage,
      authenticate: (req, res, next) => {
        const id = req.header("x-test-user");
        if (!id) {
          res.sendStatus(401);
          return;
        }
        req.auth = { userId: id } as any;
        next();
      },
    } as AppDependencies;
    const upload = multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: 1000 },
    }).single("file");
    app.use("/prepaid", createPrepaidRouter(dependencies, upload));
    app.use(
      "/batch-prepaid",
      createPrepaidRouter(
        {
          ...dependencies,
          config: {
            ...config,
            SFN_PREFIX: "isg-esatp-st",
          },
        },
        upload,
      ),
    );
    app.use(createErrorHandler(logger, config));
    server = await new Promise<Server>((resolve) => {
      const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/prepaid`;
  });
  afterAll(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
    // Exactly the randomly generated test schema in the dedicated test cluster.
    if (!/^prepaid_test_[a-f0-9]{32}$/.test(schema))
      throw new Error("Unsafe test schema cleanup");
    await q(
      `DROP SCHEMA "${schema}_raw" CASCADE; DROP SCHEMA "${schema}" CASCADE`,
    );
    await pool.end();
  });
  async function fresh(setup?: (run: Record<string, any>) => Promise<void>) {
    const period = `${2030 + Math.floor(periodNo / 12)}-${String(++periodNo % 12 || 12).padStart(2, "0")}`;
    const run = await service.create(user, period);
    const sources = await service.sources(user, run.id);
    for (const { code, fileName } of sources.required)
      await service.upload(user, run.id, code, {
        originalname: fileName,
        buffer: Buffer.from(
          fileName.endsWith("csv") ? "header\nvalue\n" : "PKtest-workbook",
        ),
        mimetype: "application/octet-stream",
      });
    await setup?.(run);
    const job = await service.process(user, run.id);
    return { run, job, period };
  }
  function data(period: string): Record<Dataset, unknown[]> {
    const k = {
      period,
      brand: "GP",
      cfu: "CM",
      revenue_type: "MT",
      cost_element: "123",
      sub_product: "SUB",
      uom: "EA",
      reference_document: "1",
      quantity: "10",
      currency: "PHP",
    };
    return {
      ke24: [
        { ...k, cfu: "EG", profit_center: "P1", amount: "-100" },
        { ...k, brand: "HY", cfu: "EG", profit_center: "P1", amount: "-50" },
        { ...k, profit_center: "P1", amount: "60" },
        { ...k, profit_center: "P2", amount: "40" },
      ],
      callcard: [],
      loadup: [{ period, region: "eg", amount: "224" }],
      loadapi: [],
      recharge: [
        {
          period,
          customer_type: "E",
          method: "PS",
          channel: "RP",
          amount: "56",
        },
        {
          period,
          customer_type: "E",
          method: "XX",
          channel: "RP",
          amount: "9999",
        },
      ],
      adjustments: [
        {
          period,
          cycle: "01",
          customer_type: "E",
          code: "AMAXCEP",
          amount: "-10",
          currency: "PHP",
        },
      ],
      charges: [
        {
          period,
          cycle: "02",
          customer_type: "E",
          code: "AMAXCEP",
          amount: "66",
          currency: "PHP",
        },
      ],
      reference: [
        {
          period,
          client: "300",
          company: "GLOB",
          cost_element: "123",
          brand: "GP",
          cfu: "CM",
          revenue_type: "MT",
          sub_product: "SUB",
          tax_rate: "0.12",
          average_rate: "10",
          uom: "EA",
        },
      ],
    };
  }
  async function executeIngestion(
    context: Awaited<ReturnType<typeof fresh>>,
    transform?: (rows: Record<Dataset, unknown[]>) => void,
    badChecksum = false,
  ) {
    const { run, job, period } = context;
    // Advance only this job, so unfinished jobs from another test cannot steal the tick.
    await q(
      "UPDATE prepaid_jobs SET available_at=now()+interval '1 day' WHERE id<>$1",
      [job.id],
    );
    await worker.tick(true);
    const recorded = (
      await q("SELECT * FROM prepaid_jobs WHERE id=$1", [job.id])
    ).rows[0];
    const rows = data(period);
    transform?.(rows);
    const prefix = `${storage.prefix(run.id)}ingestion/${job.snapshotId}/`;
    const descriptors = Object.entries(rows).map(([name, records]) => {
      const bytes = Buffer.from(
        records.map((row) => JSON.stringify(row)).join("\n") +
          (records.length ? "\n" : ""),
      );
      const key = `${prefix}${name}.ndjson`;
      objects.set(key, bytes);
      return {
        name,
        key,
        sha256: badChecksum && name === "ke24" ? "0".repeat(64) : sha256(bytes),
        rowCount: records.length,
      };
    });
    const manifestKey = `${prefix}manifest.json`;
    const snapshot = (
      await q("SELECT * FROM prepaid_source_snapshots WHERE id=$1", [
        job.snapshotId,
      ])
    ).rows[0];
    jsonObject(manifestKey, {
      contractVersion: 1,
      runId: run.id,
      workspaceId: run.workspace_id,
      period,
      ingestionId: job.snapshotId,
      executionArn: recorded.execution_arn,
      sourceFiles: snapshot.source_files.map((f: any) => ({
        id: f.id,
        sha256: f.sha256,
      })),
      coverage: configuration.expectedCycles.map((cycle) => ({
        cycle,
        adjustments: true,
        charges: true,
      })),
      datasets: descriptors,
    });
    terminal.set(recorded.execution_arn, {
      status: "SUCCEEDED",
      output: JSON.stringify({ contractVersion: 1, manifestKey }),
    });
    await q("UPDATE prepaid_jobs SET available_at=now() WHERE id=$1", [job.id]);
    await worker.tick(true);
    return context;
  }
  async function prepareSession(actor: string) {
    const workspace = new PrepaidWorkspaceService(service);
    const required = (await workspace.state(actor)).sources.required;
    for (const f of required)
      await workspace.upload(actor, f.code, {
        originalname: f.fileName,
        buffer: Buffer.from(f.fileName.endsWith("XLSX") ? "PKtest" : "test"),
        mimetype: "x",
      });
    const state = await workspace.state(actor);
    const preparation = new PrepaidPreparationWorker(
      repo,
      storage,
      runner,
      logger,
    );
    await q(
      "UPDATE prepaid_preparation_jobs SET available_at=now()+interval '1 day' WHERE session_id<>$1",
      [state.session.id],
    );
    await preparation.tick();
    const job = (
      await q(
        "SELECT * FROM prepaid_preparation_jobs WHERE session_id=$1 ORDER BY attempt DESC LIMIT 1",
        [state.session.id],
      )
    ).rows[0];
    const period = "2026-09",
      rows = data(period),
      prefix = job.execution_input.outputPrefix;
    // Zero-value financial fixture: focuses on state/configuration, not accounting acceptance.
    for (const dataset of Object.values(rows))
      for (const r of dataset)
        if ("amount" in (r as any)) (r as any).amount = "0";
    for (const name of ["adjustments", "charges"] as const)
      rows[name] = rows[name].filter((r: any) =>
        state.session.configuration.expectedCycles.includes(r.cycle),
      );
    const datasets = Object.entries(rows).map(([name, records]) => {
      const key = prefix + name + ".jsonl",
        bytes = Buffer.from(
          records.map((r) => JSON.stringify(r)).join("\n") +
            (records.length ? "\n" : ""),
        );
      objects.set(key, bytes);
      return { name, key, sha256: sha256(bytes), rowCount: records.length };
    });
    const key = prefix + "manifest.json";
    jsonObject(key, {
      contractVersion: 2,
      sessionId: state.session.id,
      workspaceId: state.session.workspace_id,
      preparationId: job.id,
      sourceVersion: state.session.version,
      period,
      executionArn: job.execution_arn,
      sourceFiles: job.source_files.map((f: any) => ({
        id: f.id,
        sha256: f.sha256,
      })),
      coverage: state.session.configuration.expectedCycles.map(
        (cycle: string) => ({ cycle, adjustments: true, charges: true }),
      ),
      datasets,
    });
    terminal.set(job.execution_arn, {
      status: "SUCCEEDED",
      output: JSON.stringify({ contractVersion: 2, manifestKey: key }),
    });
    await q(
      "UPDATE prepaid_preparation_jobs SET available_at=now() WHERE id=$1",
      [job.id],
    );
    await preparation.tick();
    const finished = await workspace.state(actor);
    expect(finished.session.status).toBe("ready");
    return { workspace, finished, job };
  }
  it("keeps readiness scoped while unrelated constraints are created and dropped", async () => {
    const noise = `${schema}_noise`;
    await pool.query(`CREATE SCHEMA "${noise}"`);
    try {
      await Promise.all([
        (async () => {
          for (let i = 0; i < 20; i++) {
            await pool.query(
              `CREATE TABLE "${noise}".changing(value int CHECK(value>0)); DROP TABLE "${noise}".changing`,
            );
          }
        })(),
        (async () => {
          for (let i = 0; i < 20; i++) {
            expect(await service.readiness()).toMatchObject({
              schemaInstalled: true,
              readyForUploads: true,
            });
          }
        })(),
      ]);
    } finally {
      // Exact generated schema owned by this guarded disposable-database test.
      await pool.query(`DROP SCHEMA "${noise}" CASCADE`);
    }
  });
  it("requires migration 015 before exposing an enabled batch workflow", async () => {
    const response = await fetch(new URL("/batch-prepaid/aws-batch", base), {
      headers: { "x-test-user": user },
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "PREPAID_BATCH_SCHEMA_NOT_INSTALLED" },
    });
  });
  it("reports configured readiness without executing AWS; identifies missing/invalid setup", async () => {
    const before = start.mock.calls.length;
    expect(await service.readiness()).toMatchObject({
      schemaInstalled: true,
      integrationConfigured: true,
      readyForUploads: true,
      externalVerification: "not_verified",
    });
    const response = await fetch(`${base}/readiness`, {
      headers: { "x-test-user": user },
    });
    expect(response.status).toBe(200);
    expect((await fetch(`${base}/readiness`)).status).toBe(401);
    const absent = new PrepaidRunService(
      new PrepaidRepository(pool, "absent_prepaid_schema"),
      storage,
    );
    expect(await absent.readiness()).toMatchObject({
      schemaInstalled: false,
      readyForUploads: false,
    });
    await q("DELETE FROM prepaid_integrations");
    expect(await service.readiness()).toMatchObject({
      integrationConfigured: false,
      readyForUploads: true,
      readyForPreparation: false,
    });
    await q(
      "INSERT INTO prepaid_integrations(id,configuration,updated_by) VALUES(true,'{}',$1)",
      [user],
    );
    expect((await service.readiness()).checks).toContainEqual(
      expect.objectContaining({ code: "format", status: "invalid" }),
    );
    await service.configure(user, configuration);
    expect(start.mock.calls.length).toBe(before);
  });
  async function uploadActor() {
    const actor = randomUUID();
    await q("INSERT INTO app_user(id) VALUES($1)", [actor]);
    return actor;
  }
  it("uses built-ins without seeding rows, respects overrides, and does not mask invalid database settings", async () => {
    const defaults = new PrepaidRunService(repo, storage, configuration);
    await q("DELETE FROM prepaid_integrations");
    try {
      expect(await defaults.integration()).toMatchObject(configuration);
      expect(await defaults.readiness()).toMatchObject({
        configurationSource: "built_in",
        readyForPreparation: true,
      });
      expect(
        (await q("SELECT count(*)::int count FROM prepaid_integrations"))
          .rows[0].count,
      ).toBe(0);
      const override = { ...configuration, expectedCycles: ["03"] };
      await defaults.configure(user, override);
      expect((await defaults.integration()).expectedCycles).toEqual(["03"]);
      expect(await defaults.readiness()).toMatchObject({
        configurationSource: "database",
        readyForPreparation: true,
      });
      await q("UPDATE prepaid_integrations SET configuration='{}'");
      expect(await defaults.availableIntegration()).toBeNull();
      expect(await defaults.readiness()).toMatchObject({
        configurationSource: "database",
        readyForPreparation: false,
      });
    } finally {
      await service.configure(user, configuration);
    }
  });
  async function closeUploadActor(actor: string) {
    await q(
      "UPDATE prepaid_preparation_jobs SET status='cancelled' WHERE session_id IN(SELECT s.id FROM prepaid_upload_sessions s JOIN workspaces w ON w.id=s.workspace_id WHERE w.user_id=$1) AND status IN('queued','running','waiting')",
      [actor],
    );
    await q(
      "UPDATE prepaid_upload_sessions SET active=false WHERE workspace_id IN(SELECT id FROM workspaces WHERE user_id=$1)",
      [actor],
    );
    await service.configure(user, configuration);
  }
  it("replays upload identities without extra versions/jobs, rejects changed bytes and does not cross a reset", async () => {
    const actor = await uploadActor(),
      workspace = new PrepaidWorkspaceService(service),
      id = randomUUID();
    await q("DELETE FROM prepaid_integrations");
    const file = {
      originalname: "KE24.XLSX",
      mimetype: "application/octet-stream",
      buffer: Buffer.from("PK synthetic retry fixture"),
    };
    try {
      const [saved, duplicate] = await Promise.all([
        workspace.upload(actor, "ke24", file, id),
        workspace.upload(actor, "ke24", file, id),
      ]);
      expect(duplicate).toEqual(saved);
      const before = await workspace.state(actor);
      const [a, b] = await Promise.all([
        workspace.upload(actor, "ke24", file, id),
        workspace.upload(actor, "ke24", file, id),
      ]);
      expect(a).toEqual(saved);
      expect(b).toEqual(saved);
      const after = await workspace.state(actor);
      expect(after.session.version).toBe(before.session.version);
      expect(after.sources.files).toHaveLength(1);
      expect(
        (
          await q(
            "SELECT 1 FROM prepaid_preparation_jobs WHERE session_id=$1",
            [after.session.id],
          )
        ).rowCount,
      ).toBe(0);
      await expect(
        workspace.upload(
          actor,
          "ke24",
          { ...file, buffer: Buffer.from("PK different content") },
          id,
        ),
      ).rejects.toMatchObject({ code: "PREPAID_UPLOAD_ID_CONFLICT" });
      // A lost acknowledgement may be retried after the last upload already
      // queued preparation. Receipt replay must not require mutable sources.
      await q(
        "UPDATE prepaid_upload_sessions SET status='pending' WHERE id=$1",
        [after.session.id],
      );
      expect(await workspace.upload(actor, "ke24", file, id)).toEqual(saved);
      expect((await workspace.state(actor)).session.status).toBe("pending");
      await q("UPDATE prepaid_upload_sessions SET active=false WHERE id=$1", [
        after.session.id,
      ]);
      await expect(
        workspace.upload(actor, "ke24", file, id),
      ).rejects.toMatchObject({ code: "PREPAID_UPLOAD_ID_CONFLICT" });
    } finally {
      await closeUploadActor(actor);
    }
  });
  it("explains old mapping failures without rewriting history and binds approval only to a new session", async () => {
    const actor = await uploadActor();
    const approvedConfig = manualIntegrationSchema.parse({
      ...configuration,
      sourceExtraction: {
        envPrefix: "isg-esatp-dv",
        coverage: "all_sources",
        sharedWritesApproved: true,
        egReportMapping: approvedProvidedEgReportMapping,
      },
    });
    const runs = new PrepaidRunService(repo, storage, approvedConfig);
    const workspace = new PrepaidWorkspaceService(runs);
    const file = {
      originalname: "KE24.XLSX",
      buffer: Buffer.from("PK synthetic approval session fixture"),
      mimetype: "application/octet-stream",
    };
    await q("DELETE FROM prepaid_integrations");
    try {
      await workspace.upload(actor, "ke24", file);
      const initial = await workspace.state(actor);
      const old = structuredClone(approvedConfig);
      delete old.sourceExtraction!.egReportMapping;
      await q(
        "UPDATE prepaid_upload_sessions SET configuration=$2,status='failed',error=$3 WHERE id=$1",
        [
          initial.session.id,
          JSON.stringify(old),
          "Source normalization failed: EG_REPORT_MAPPING_REQUIRED: approve sourceExtraction.egReportMapping.callcardScope",
        ],
      );
      const failed = await workspace.state(actor);
      expect(failed.error).toContain("Reset the workspace");
      expect(
        failed.session.configuration.sourceExtraction.egReportMapping,
      ).toBeUndefined();
      expect(failed.session.version).toBe(initial.session.version);
      expect(failed.sources.files[0].id).toBe(initial.sources.files[0].id);
      expect(
        (
          await q(
            "SELECT 1 FROM prepaid_preparation_jobs WHERE session_id=$1",
            [initial.session.id],
          )
        ).rowCount,
      ).toBe(0);
      await workspace.reset(actor, {
        sessionId: failed.session.id,
        sessionVersion: failed.session.version,
      });
      await workspace.upload(actor, "ke24", file);
      const next = await workspace.state(actor);
      expect(next.session.id).not.toBe(initial.session.id);
      expect(
        next.session.configuration.sourceExtraction.egReportMapping,
      ).toEqual(approvedProvidedEgReportMapping);
      const retained = (
        await q(
          "SELECT configuration,active FROM prepaid_upload_sessions WHERE id=$1",
          [initial.session.id],
        )
      ).rows[0];
      expect(retained.active).toBe(false);
      expect(retained.configuration).toEqual(old);
      expect(objects.has(initial.sources.files[0].object_key)).toBe(true);
    } finally {
      await closeUploadActor(actor);
    }
  });
  it("accepts all ten source types over HTTP before processing setup, preserving bytes and never queuing incomplete configuration", async () => {
    const actor = await uploadActor(),
      workspace = new PrepaidWorkspaceService(service);
    const starts = start.mock.calls.length;
    await q("DELETE FROM prepaid_integrations");
    try {
      const viewed = await workspace.state(actor);
      expect(viewed).toMatchObject({
        session: null,
        run: null,
        error: null,
        preparation: { configured: false },
        sources: { collectionOnly: true, valid: false },
      });
      expect(viewed.sources.accepted).toHaveLength(208);
      expect(
        (await q("SELECT 1 FROM workspaces WHERE user_id=$1", [actor]))
          .rowCount,
      ).toBe(0);
      for (const code of [...sourceCodes, "308_21", "318_27"]) {
        const original = Buffer.from(
          code === "monthly_recharge"
            ? "test csv only"
            : "PK SYNTHETIC UPLOAD TEST " + code,
        );
        const form = new FormData();
        form.append("file", new Blob([original]), expectedName(code));
        const uploadId = randomUUID();
        form.append("uploadId", uploadId);
        const response = await fetch(`${base}/workspace/sources/${code}`, {
          method: "POST",
          headers: { "x-test-user": actor },
          body: form,
        });
        expect(response.status).toBe(201);
        const saved = (await response.json()) as any;
        expect(saved.id).toBe(uploadId);
        expect(saved.sha256).toBe(sha256(original));
        expect(objects.get(saved.key)).toEqual(original);
      }
      const state = await workspace.prepare(actor);
      expect(state.session.status).toBe("collecting");
      expect(state.sources.files).toHaveLength(10);
      expect(state.sources.valid).toBe(false);
      expect(
        manualIntegrationSchema.safeParse(state.session.configuration).success,
      ).toBe(false);
      expect(await workspace.resumeCollectingUploads()).toBe(false);
      expect(
        (
          await q(
            "SELECT 1 FROM prepaid_preparation_jobs WHERE session_id=$1",
            [state.session.id],
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await q("SELECT 1 FROM prepaid_runs WHERE workspace_id=$1", [
            state.session.workspace_id,
          ])
        ).rowCount,
      ).toBe(0);
      expect(
        (await new PrepaidWorkspaceService(service).state(otherUser)).sources
          .files,
      ).not.toContainEqual(expect.objectContaining({ uploaded_by: actor }));
      expect(start.mock.calls.length).toBe(starts);
    } finally {
      await closeUploadActor(actor);
    }
  });
  it("binds a complete configuration later and queues once without requiring re-upload or inferring coverage", async () => {
    const actor = await uploadActor(),
      workspace = new PrepaidWorkspaceService(service);
    await q("DELETE FROM prepaid_integrations");
    try {
      const codes = [...sourceCodes, "308_01", "318_01", "308_02", "318_02"];
      for (const code of codes)
        await workspace.upload(actor, code, {
          originalname: expectedName(code),
          buffer: Buffer.from(code === "monthly_recharge" ? "csv" : "PK test"),
          mimetype: "application/octet-stream",
        });
      const staged = await workspace.state(actor);
      await q(
        "INSERT INTO prepaid_integrations(id,configuration,updated_by) VALUES(true,'{}',$1)",
        [user],
      );
      expect(await workspace.resumeCollectingUploads()).toBe(false);
      expect((await workspace.state(actor)).session.configuration).toEqual(
        staged.session.configuration,
      );
      await service.configure(user, configuration);
      // GET remains read-only; the background worker performs the binding.
      expect((await workspace.state(actor)).session.status).toBe("collecting");
      await Promise.all([
        workspace.resumeCollectingUploads(),
        workspace.resumeCollectingUploads(),
      ]);
      const ready = await workspace.state(actor);
      expect(ready.session).toMatchObject({
        id: staged.session.id,
        status: "pending",
        version: staged.session.version + 1,
      });
      expect(ready.preparation.configured).toBe(true);
      expect(ready.sources.files.map((f: any) => f.sha256)).toEqual(
        staged.sources.files.map((f: any) => f.sha256),
      );
      const jobs = (
        await q("SELECT * FROM prepaid_preparation_jobs WHERE session_id=$1", [
          ready.session.id,
        ])
      ).rows;
      expect(jobs).toHaveLength(1);
      expect(jobs[0].source_files).toHaveLength(codes.length);
      expect(ready.session.configuration).toEqual(configuration);
    } finally {
      await closeUploadActor(actor);
    }
  });
  it("does not silently drop uploaded cycles outside later approved coverage; explicit removal unblocks queuing", async () => {
    const actor = await uploadActor(),
      workspace = new PrepaidWorkspaceService(service);
    await q("DELETE FROM prepaid_integrations");
    try {
      for (const code of [...sourceCodes, "308_01", "318_01", "308_99"])
        await workspace.upload(actor, code, {
          originalname: expectedName(code),
          buffer: Buffer.from(code === "monthly_recharge" ? "csv" : "PK test"),
          mimetype: "application/octet-stream",
        });
      await service.configure(user, {
        ...configuration,
        expectedCycles: ["01"],
      });
      expect(await workspace.resumeCollectingUploads()).toBe(false);
      const blocked = await workspace.state(actor);
      expect(blocked.sources.unexpected).toEqual(["308_99"]);
      expect(blocked.sources.valid).toBe(false);
      expect(blocked.session.status).toBe("collecting");
      expect(blocked.error).toContain("outside the approved cycle coverage");
      const unblocked = await workspace.remove(actor, "308_99");
      expect(unblocked.session.status).toBe("pending");
      expect(
        (
          await q(
            "SELECT * FROM prepaid_preparation_jobs WHERE session_id=$1",
            [blocked.session.id],
          )
        ).rows,
      ).toHaveLength(1);
    } finally {
      await closeUploadActor(actor);
    }
  });
  it("rechecks approved coverage when configuration changes during an object upload", async () => {
    const actor = await uploadActor(),
      workspace = new PrepaidWorkspaceService(service);
    await q("DELETE FROM prepaid_integrations");
    const put = storage.put.bind(storage);
    const intercept = vi
      .spyOn(storage, "put")
      .mockImplementationOnce(async (...args) => {
        const result = await put(...args);
        await service.configure(user, {
          ...configuration,
          expectedCycles: ["01"],
        });
        await workspace.resumeCollectingUploads();
        return result;
      });
    try {
      await expect(
        workspace.upload(actor, "308_99", {
          originalname: expectedName("308_99"),
          buffer: Buffer.from("PK test"),
          mimetype: "application/octet-stream",
        }),
      ).rejects.toMatchObject({ code: "PREPAID_SOURCE_COVERAGE_CHANGED" });
      expect((await workspace.state(actor)).sources.files).toHaveLength(0);
    } finally {
      intercept.mockRestore();
      await closeUploadActor(actor);
    }
  });
  it("recovers historical v2 provenance only from exact completed preparation evidence", async () => {
    const actor = randomUUID();
    await q("INSERT INTO app_user(id) VALUES($1)", [actor]);
    const { finished } = await prepareSession(actor),
      runId = finished.run!.id;
    const old = await repo.revision(pool, runId, "eg"),
      recovered = randomUUID(),
      untrusted = randomUUID();
    await q(
      "INSERT INTO prepaid_source_snapshots(id,run_id,status,source_files,configuration,manifest,completed_at) SELECT $1,run_id,status,source_files,configuration,manifest,now()+interval '1 hour' FROM prepaid_source_snapshots WHERE id=$2",
      [recovered, old.source_snapshot_id],
    );
    await q(
      "INSERT INTO prepaid_source_snapshots(id,run_id,status,source_files,configuration,manifest,completed_at) SELECT $1,run_id,status,source_files,configuration,manifest||'{\"sourceVersion\":-1}'::jsonb,now() FROM prepaid_source_snapshots WHERE id=$2",
      [untrusted, old.source_snapshot_id],
    );
    await q(
      "UPDATE prepaid_region_revisions SET source_snapshot_id=$1 WHERE id=$2",
      [recovered, old.id],
    );
    expect((await service.layout(actor, runId, "eg")).canFreeze).toBe(false);
    await expect(
      service.freeze(actor, runId, "eg", old.version),
    ).rejects.toMatchObject({ code: "PREPAID_SOURCE_STALE" });
    const migration = prepaidConsistencyMigrationSql(schema);
    await q(
      migration
        .slice(migration.indexOf("INSERT INTO"))
        .replace(/;\s*$/, " ON CONFLICT(snapshot_id) DO NOTHING;"),
    );
    expect(
      (
        await q("SELECT 1 FROM prepaid_snapshot_context WHERE snapshot_id=$1", [
          recovered,
        ])
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await q("SELECT 1 FROM prepaid_snapshot_context WHERE snapshot_id=$1", [
          untrusted,
        ])
      ).rowCount,
    ).toBe(0);
    expect((await service.freeze(actor, runId, "eg", old.version)).status).toBe(
      "staged",
    );
  });
  it("reuses a period with new snapshot cycles/format while preserving previous frozen bytes", async () => {
    const actor = randomUUID();
    await q("INSERT INTO app_user(id) VALUES($1)", [actor]);
    const first = await prepareSession(actor),
      runId = first.finished.run!.id;
    const eg = await service.layout(actor, runId, "eg"),
      sg = await service.layout(actor, runId, "sg");
    await service.freeze(actor, runId, "eg", eg.version);
    const snapshot = (await repo.revision(pool, runId, "eg"))
      .source_snapshot_id;
    const archive = await frozenReports(service, actor, runId, snapshot);
    await first.workspace.reset(actor, {
      runId,
      eg: (await service.layout(actor, runId, "eg")).version,
      sg: sg.version,
      sessionId: first.finished.session.id,
      sessionVersion: first.finished.session.version,
    });
    const next = {
      ...configuration,
      expectedCycles: ["01"],
      format: {
        ...configuration.format,
        profile: "new-test-only",
        delimiter: "|" as const,
      },
    };
    await service.configure(user, next);
    try {
      const second = await prepareSession(actor);
      expect(second.finished.run!.id).toBe(runId);
      expect(
        (await service.sources(actor, runId)).required.map((f) => f.code),
      ).not.toContain("318_02");
      const current = await service.layout(actor, runId, "eg");
      await service.freeze(actor, runId, "eg", current.version);
      const revision = await repo.revision(pool, runId, "eg");
      expect(
        (
          await q(
            "SELECT format FROM prepaid_frozen_report_formats WHERE revision_id=$1",
            [revision.id],
          )
        ).rows[0].format.delimiter,
      ).toBe("|");
      expect(await frozenReports(service, actor, runId, snapshot)).toEqual(
        archive,
      );
      await expect(
        q(
          "UPDATE prepaid_snapshot_context SET source_version=0 WHERE snapshot_id=$1",
          [revision.source_snapshot_id],
        ),
      ).rejects.toThrow("PREPAID_AUDIT_APPEND_ONLY");
    } finally {
      await service.configure(user, configuration);
    }
  });
  it("serializes source removal against Freeze without committing inconsistent state", async () => {
    const actor = randomUUID();
    await q("INSERT INTO app_user(id) VALUES($1)", [actor]);
    const { workspace, finished } = await prepareSession(actor),
      runId = finished.run!.id,
      layout = await service.layout(actor, runId, "eg");
    const results = await Promise.allSettled([
      workspace.remove(actor, "ke24"),
      service.freeze(actor, runId, "eg", layout.version),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const final = await workspace.state(actor);
    if (final.session.status === "collecting")
      expect((await service.layout(actor, runId, "eg")).frozen).toBe(false);
    else expect((await service.layout(actor, runId, "eg")).frozen).toBe(true);
  });
  it("keeps versioned reset context after removal hides the review run, preserving stored originals", async () => {
    const actor = await uploadActor();
    const { workspace, finished } = await prepareSession(actor);
    const runId = finished.run!.id;
    const originalKeys = finished.sources.files.map((f: any) => f.object_key);
    const changed = await workspace.remove(actor, "ke24");
    expect(changed.run).toBeNull();
    expect(changed.session.status).toBe("collecting");
    const resetContext = (changed as any).resetContext;
    expect(resetContext).toEqual({
      runId,
      eg: (await service.layout(actor, runId, "eg")).version,
      sg: (await service.layout(actor, runId, "sg")).version,
    });
    await workspace.reset(actor, {
      ...resetContext,
      sessionId: changed.session.id,
      sessionVersion: changed.session.version,
    });
    expect((await workspace.state(actor)).session).toBeNull();
    for (const key of originalKeys) expect(objects.has(key)).toBe(true);
  });
  it("rejects a stale regional reset context atomically even while the review run is hidden", async () => {
    const actor = await uploadActor();
    const { workspace, finished } = await prepareSession(actor);
    const changed = await workspace.remove(actor, "ke24");
    const context = (changed as any).resetContext;
    await expect(
      workspace.reset(actor, {
        ...context,
        eg: context.eg + 1,
        sessionId: changed.session.id,
        sessionVersion: changed.session.version,
      }),
    ).rejects.toMatchObject({ status: 409 });
    const current = await workspace.state(actor);
    expect(current.session.id).toBe(changed.session.id);
    expect(current.sources.files.length).toBe(changed.sources.files.length);
    expect(current.session.run_id).toBe(finished.run!.id);
  });
  async function imported(
    transform?: (rows: Record<Dataset, unknown[]>) => void,
  ) {
    const context = await executeIngestion(await fresh(), transform);
    const layout = await service.command(
      user,
      context.run.id,
      "eg",
      "import",
      0,
    );
    return { ...context, layout };
  }
  async function advance(jobId: string) {
    await q(
      "UPDATE prepaid_jobs SET available_at=now()+interval '1 day' WHERE id<>$1",
      [jobId],
    );
    await q("UPDATE prepaid_jobs SET available_at=now() WHERE id=$1", [jobId]);
    await worker.tick(true);
    return (await q("SELECT * FROM prepaid_jobs WHERE id=$1", [jobId])).rows[0];
  }
  async function receipt(jobId: string, outcome: string) {
    const job = (await q("SELECT * FROM prepaid_jobs WHERE id=$1", [jobId]))
        .rows[0],
      input = job.payload.executionInput;
    const receiptKey = `${input.receiptPrefix}${randomUUID()}.json`;
    jsonObject(receiptKey, {
      contractVersion: 1,
      deliveryId: input.deliveryId,
      exportId: input.exportId,
      sha256: input.sha256,
      executionArn: job.execution_arn,
      kind: input.kind,
      outcome,
      receiptId: randomUUID(),
      confirmedAt: new Date().toISOString(),
    });
    terminal.set(job.execution_arn, {
      status: "SUCCEEDED",
      output: JSON.stringify({ receiptKey }),
    });
    return advance(jobId);
  }
  // Compatibility fixtures represent pre-existing outbox records. Production Freeze
  // is manual-only and never creates these records.
  async function legacyFrozenDelivery(
    actor: string,
    runId: string,
    region: "eg" | "sg",
    version: number,
  ) {
    const frozen = await service.freeze(actor, runId, region, version);
    const deliveryId = randomUUID(),
      jobId = randomUUID();
    const run = await service.get(actor, runId);
    const previous =
      (
        await q(
          "SELECT last_delivery_id FROM prepaid_delivery_slots WHERE target=$1 AND period=$2 AND region=$3",
          [configuration.target, run.period, region],
        )
      ).rows[0]?.last_delivery_id ?? null;
    await q(
      "INSERT INTO prepaid_deliveries(id,revision_id,predecessor_delivery_id,target,period,region,status) VALUES($1,$2,$3,$4,$5,$6,'queued')",
      [
        deliveryId,
        frozen.revisionId,
        previous,
        configuration.target,
        run.period,
        region,
      ],
    );
    await q(
      "INSERT INTO prepaid_delivery_slots(target,period,region,run_id,last_delivery_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(target,period,region) DO UPDATE SET last_delivery_id=excluded.last_delivery_id",
      [configuration.target, run.period, region, runId, deliveryId],
    );
    await q(
      "INSERT INTO prepaid_jobs(id,run_id,revision_id,kind,payload,status,execution_name) VALUES($1,$2,$3,'delivery',$4,'queued',$5)",
      [
        jobId,
        runId,
        frozen.revisionId,
        JSON.stringify({ deliveryId }),
        "prepaid-legacy-" + jobId,
      ],
    );
    return { ...frozen, jobId, deliveryId };
  }
  it("manual Freeze stages immutable reports without delivery jobs or AWS dispatch", async () => {
    const { run, layout } = await imported();
    const before = start.mock.calls.length;
    const result = await service.freeze(user, run.id, "eg", layout.version);
    expect(result.status).toBe("staged");
    expect(
      (
        await q("SELECT 1 FROM prepaid_deliveries WHERE revision_id=$1", [
          result.revisionId,
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await q(
          "SELECT 1 FROM prepaid_jobs WHERE kind='delivery' AND revision_id=$1",
          [result.revisionId],
        )
      ).rowCount,
    ).toBe(0);
    expect(start.mock.calls.length).toBe(before);
    const snapshot = (await service.layout(user, run.id, "eg"))
      .sourceSnapshotId;
    const rev = (
      await q(
        "SELECT source_snapshot_id FROM prepaid_region_revisions WHERE id=$1",
        [result.revisionId],
      )
    ).rows[0];
    const zip = await frozenReports(
      service,
      user,
      run.id,
      rev.source_snapshot_id,
    );
    expect(zip.subarray(0, 2).toString()).toBe("PK");
    await expect(
      frozenReports(service, otherUser, run.id, rev.source_snapshot_id),
    ).rejects.toMatchObject({ code: "PREPAID_RUN_NOT_FOUND" });
    await expect(
      q(
        "UPDATE prepaid_frozen_report_formats SET format='{}' WHERE revision_id=$1",
        [result.revisionId],
      ),
    ).rejects.toThrow("PREPAID_AUDIT_APPEND_ONLY");
  });
  it("freezes XLSX reports from PostgreSQL, preserves their format, and never creates SAP delivery", async () => {
    const next = {
      ...configuration,
      format: {
        fileType: "xlsx",
        profile: "prepaid-manual-xlsx-v1",
        approved: true,
      },
    };
    await service.configure(user, next);
    try {
      const { run, layout } = await imported();
      const before = start.mock.calls.length;
      const frozen = await service.freeze(user, run.id, "eg", layout.version);
      const revision = await repo.revision(pool, run.id, "eg");
      const archive = await frozenReports(
        service,
        user,
        run.id,
        revision.source_snapshot_id,
      );
      const files = unzipSync(archive);
      const name = `eg-r${revision.revision}-reports.xlsx`;
      expect(Object.keys(files)).toEqual([name]);
      const book = new ExcelJS.Workbook();
      await book.xlsx.load(Buffer.from(files[name]) as any);
      expect(book.worksheets.map((sheet) => sheet.name)).toEqual([
        "Layout",
        "Allocation",
        "Reconciliation",
        "JV",
      ]);
      expect(book.getWorksheet("JV")!.getRow(1).values).toEqual([
        undefined,
        ...jvHeaders,
      ]);
      expect(frozen.status).toBe("staged");
      expect(
        (
          await q("SELECT 1 FROM prepaid_deliveries WHERE revision_id=$1", [
            revision.id,
          ])
        ).rowCount,
      ).toBe(0);
      expect(start.mock.calls.length).toBe(before);
      // Changing the live settings must not rewrite an existing frozen XLSX.
      await service.configure(user, configuration);
      expect(
        await frozenReports(service, user, run.id, revision.source_snapshot_id),
      ).toEqual(archive);
      const denied = await fetch(
        `${base}/runs/${run.id}/reports/${revision.source_snapshot_id}.zip`,
        { headers: { "x-test-user": otherUser } },
      );
      expect(denied.status).toBe(404);
      const response = await fetch(
        `${base}/runs/${run.id}/reports/${revision.source_snapshot_id}.zip`,
        { headers: { "x-test-user": user } },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/zip");
      expect(Buffer.from(await response.arrayBuffer())).toEqual(archive);
    } finally {
      await service.configure(user, configuration);
    }
  });
  it("accepts restored legacy Call Card names over HTTP while retaining immutable bytes and native object names", async () => {
    const actor = randomUUID();
    await q("INSERT INTO app_user(id) VALUES($1)", [actor]);
    for (const [code, filename] of [
      ["callcard_eg", "EG CALLCARD.xlsx"],
      ["callcard_sg", "SG CALLCARD.xlsx"],
    ]) {
      const bytes = Buffer.from("PKoriginal-" + code);
      const body = new FormData();
      body.append("file", new Blob([bytes]), filename);
      const response = await fetch(`${base}/workspace/sources/${code}`, {
        method: "POST",
        headers: { "x-test-user": actor },
        body,
      });
      expect(response.status).toBe(201);
      const row = (
        await q(
          "SELECT f.* FROM prepaid_session_files f JOIN prepaid_upload_sessions s ON s.id=f.session_id JOIN workspaces w ON w.id=s.workspace_id WHERE w.user_id=$1 AND f.source_code=$2 AND f.active",
          [actor, code],
        )
      ).rows[0];
      expect(row.original_name).toBe(filename);
      expect(row.object_key.endsWith("/" + expectedName(code))).toBe(true);
      expect(row.sha256).toBe(sha256(bytes));
      expect(objects.get(row.object_key)).toEqual(bytes);
    }
    const state = await new PrepaidWorkspaceService(service).state(actor);
    expect(
      state.sources.required.find((item: any) => item.code === "callcard_eg")
        .acceptedFileNames,
    ).toContain("EG CALLCARD.xlsx");
    const bad = new FormData();
    bad.append("file", new Blob(["PKwrong-region"]), "SG CALLCARD.xlsx");
    expect(
      (
        await fetch(`${base}/workspace/sources/callcard_eg`, {
          method: "POST",
          headers: { "x-test-user": actor },
          body: bad,
        })
      ).status,
    ).toBe(400);
    // Historical run upload path uses the same alias contract.
    const legacyActor = randomUUID();
    await q("INSERT INTO app_user(id) VALUES($1)", [legacyActor]);
    const run = await service.create(legacyActor, "2030-01");
    await service.upload(legacyActor, run.id, "callcard_eg", {
      originalname: "EG CALLCARD.xlsx",
      buffer: Buffer.from("PKlegacy"),
      mimetype: "application/octet-stream",
    });
    expect(
      (await service.sources(legacyActor, run.id)).files.find(
        (file: any) => file.source_code === "callcard_eg",
      ).original_name,
    ).toBe("EG CALLCARD.xlsx");
  });
  it("workspace GET creates nothing and invalid upload cannot create a session", async () => {
    const fresh = randomUUID();
    await q("INSERT INTO app_user(id) VALUES($1)", [fresh]);
    const workspace = new PrepaidWorkspaceService(service);
    expect((await workspace.state(fresh)).session).toBeNull();
    expect(
      (await q("SELECT 1 FROM workspaces WHERE user_id=$1", [fresh])).rowCount,
    ).toBe(0);
    await expect(
      workspace.upload(fresh, "ke24", {
        originalname: "wrong.xlsx",
        buffer: Buffer.from("PKxx"),
        mimetype: "application/octet-stream",
      }),
    ).rejects.toMatchObject({ code: "PREPAID_FILE_NAME_INVALID" });
    expect(
      (await q("SELECT 1 FROM workspaces WHERE user_id=$1", [fresh])).rowCount,
    ).toBe(0);
    await workspace.upload(fresh, "ke24", {
      originalname: expectedName("ke24"),
      buffer: Buffer.from("PKxx"),
      mimetype: "application/octet-stream",
    });
    const state = await workspace.state(fresh);
    expect(state.session.status).toBe("collecting");
    expect(state.run).toBeNull();
    expect(state.sources.files).toHaveLength(1);
    await workspace.reset(fresh, {
      sessionId: state.session.id,
      sessionVersion: state.session.version,
    });
    expect((await workspace.state(fresh)).session).toBeNull();
  });
  it.each([
    "valid",
    "mixed-period",
    "bad-hash",
    "sg-month",
    "bad-execution-input",
  ])("prepares source-driven sessions atomically: %s", async (mode) => {
    const actor = randomUUID();
    await q("INSERT INTO app_user(id) VALUES($1)", [actor]);
    const workspace = new PrepaidWorkspaceService(service);
    const required = (await workspace.state(actor)).sources.required;
    for (const source of required)
      await workspace.upload(actor, source.code, {
        originalname: source.fileName,
        buffer: Buffer.from(
          source.fileName.endsWith(".XLSX") ? "PKtest" : "test",
        ),
        mimetype: "application/octet-stream",
      });
    const state = await workspace.state(actor);
    expect(state.session.status).toBe("pending");
    expect(
      (
        await q("SELECT 1 FROM prepaid_preparation_jobs WHERE session_id=$1", [
          state.session.id,
        ])
      ).rowCount,
    ).toBe(1);
    const preparation = new PrepaidPreparationWorker(
      repo,
      storage,
      runner,
      logger,
    );
    await q(
      "UPDATE prepaid_preparation_jobs SET available_at=now()+interval '1 day' WHERE session_id<>$1",
      [state.session.id],
    );
    await q(
      "UPDATE prepaid_preparation_jobs SET available_at=now() WHERE session_id=$1",
      [state.session.id],
    );
    await preparation.tick();
    const job = (
      await q("SELECT * FROM prepaid_preparation_jobs WHERE session_id=$1", [
        state.session.id,
      ])
    ).rows[0];
    expect(job.execution_input.contractVersion).toBe(2);
    expect(job.execution_input.period).toBeUndefined();
    const period = "2026-09",
      rows = data(period),
      prefix = job.execution_input.outputPrefix;
    if (mode === "mixed-period")
      rows.ke24.push({ ...(rows.ke24[0] as object), period: "2026-08" });
    if (mode === "sg-month")
      rows.callcard = [
        { period, region: "sg", kind: "trade", month_no: 10, amount: "100" },
      ];
    const datasets = Object.entries(rows).map(([name, values]) => {
      const key = prefix + name + ".jsonl",
        bytes = Buffer.from(
          values.map((x) => JSON.stringify(x)).join("\n") +
            (values.length ? "\n" : ""),
        );
      objects.set(key, bytes);
      return {
        name,
        key,
        sha256:
          mode === "bad-hash" && name === "ke24"
            ? "0".repeat(64)
            : sha256(bytes),
        rowCount: values.length,
      };
    });
    const key = prefix + "manifest.json";
    jsonObject(key, {
      contractVersion: 2,
      sessionId: state.session.id,
      workspaceId: state.session.workspace_id,
      preparationId: job.id,
      sourceVersion: state.session.version,
      period,
      executionArn: job.execution_arn,
      sourceFiles: job.source_files.map((f: any) => ({
        id: f.id,
        sha256: f.sha256,
      })),
      coverage: configuration.expectedCycles.map((cycle) => ({
        cycle,
        adjustments: true,
        charges: true,
      })),
      datasets,
    });
    terminal.set(job.execution_arn, {
      status: "SUCCEEDED",
      output: JSON.stringify({ contractVersion: 2, manifestKey: key }),
    });
    if (mode === "bad-execution-input")
      executionInputs.set(job.execution_arn, {
        ...job.execution_input,
        sourceVersion: -1,
      });
    await q(
      "UPDATE prepaid_preparation_jobs SET available_at=now() WHERE id=$1",
      [job.id],
    );
    await preparation.tick();
    const finished = await workspace.state(actor);
    if (mode === "valid") {
      expect(finished.session.status).toBe("ready");
      expect(finished.run.period).toBe(period);
      expect(
        (await service.layout(actor, finished.run.id, "eg")).imported,
      ).toBe(true);
      expect(
        (await service.layout(actor, finished.run.id, "sg")).imported,
      ).toBe(true);
      const reviewed = await service.layout(actor, finished.run.id, "eg");
      await expect(
        service.upload(actor, finished.run.id, "ke24", {
          originalname: expectedName("ke24"),
          buffer: Buffer.from("PKold-api"),
          mimetype: "x",
        }),
      ).rejects.toMatchObject({
        code: "PREPAID_WORKSPACE_SOURCE_API_REQUIRED",
      });
      await workspace.remove(actor, "ke24");
      await expect(
        service.freeze(actor, finished.run.id, "eg", reviewed.version),
      ).rejects.toMatchObject({ code: "PREPAID_SOURCE_STALE" });
      await expect(
        service.save(actor, finished.run.id, "eg", {
          version: reviewed.version,
          reason: "stale",
          changes: [{ layoutNumber: 13, field: "gp_mt_gross", value: "1" }],
        }),
      ).rejects.toMatchObject({ code: "PREPAID_SOURCE_STALE" });
      await expect(
        service.edit(actor, finished.run.id, "eg", reviewed.version, "stale"),
      ).rejects.toMatchObject({ code: "PREPAID_SOURCE_STALE" });
      // Replacing a source reuses unchanged file IDs without losing immutable history.
      await workspace.upload(actor, "ke24", {
        originalname: expectedName("ke24"),
        buffer: Buffer.from("PKnew"),
        mimetype: "application/octet-stream",
      });
      expect((await workspace.state(actor)).session.status).toBe("pending");
    } else {
      expect(finished.session.status).toBe("failed");
      expect(finished.run).toBeNull();
      expect(
        (
          await q("SELECT 1 FROM prepaid_runs WHERE workspace_id=$1", [
            state.session.workspace_id,
          ])
        ).rowCount,
      ).toBe(0);
    }
  });
  it("atomically resets drafts and sources, preserving frozen reports and active deliveries", async () => {
    const { run, layout } = await imported();
    const frozen = await legacyFrozenDelivery(
      user,
      run.id,
      "eg",
      layout.version,
    );
    await advance(frozen.jobId);
    const eg = await service.layout(user, run.id, "eg"),
      sg = await service.layout(user, run.id, "sg");
    await expect(
      service.resetWorkspace(user, run.id, {
        eg: eg.version,
        sg: sg.version + 1,
      }),
    ).rejects.toMatchObject({ code: "PREPAID_STALE_VERSION" });
    expect((await service.layout(user, run.id, "eg")).id).toBe(eg.id);
    expect((await service.sources(user, run.id)).valid).toBe(true);
    await service.resetWorkspace(user, run.id, {
      eg: eg.version,
      sg: sg.version,
    });
    expect((await service.layout(user, run.id, "eg")).imported).toBe(false);
    expect((await service.sources(user, run.id)).files).toHaveLength(0);
    expect(
      (
        await q("SELECT status FROM prepaid_deliveries WHERE id=$1", [
          frozen.deliveryId,
        ])
      ).rows[0].status,
    ).not.toBe("cancelled");
    expect(
      (
        await q("SELECT status FROM prepaid_region_revisions WHERE id=$1", [
          eg.id,
        ])
      ).rows[0].status,
    ).toBe("frozen");
    expect(
      (await service.reportHistory(user, undefined, 100, 0)).rows.some(
        (r) => r.run_id === run.id,
      ),
    ).toBe(true);
    expect(
      (await service.reportHistory(otherUser, undefined, 100, 0)).rows,
    ).toHaveLength(0);
  });
  it("filters report history by original upload date in Singapore", async () => {
    const context = await executeIngestion(
      await fresh(async (run) => {
        await q(
          "UPDATE prepaid_source_files SET created_at='2026-09-03T18:00:00Z' WHERE run_id=$1",
          [run.id],
        );
      }),
    );
    const layout = await service.command(
      user,
      context.run.id,
      "eg",
      "import",
      0,
    );
    await legacyFrozenDelivery(user, context.run.id, "eg", layout.version);
    expect(
      (await service.reportHistory(user, "2026-09-04", 100, 0)).rows.some(
        (r) => r.run_id === context.run.id,
      ),
    ).toBe(true);
    expect(
      (await service.reportHistory(user, "2026-09-03", 100, 0)).rows.some(
        (r) => r.run_id === context.run.id,
      ),
    ).toBe(false);
    const invalid = await fetch(`${base}/report-history?date=2026-02-31`, {
      headers: { "x-test-user": user },
    });
    expect(invalid.status).toBe(400);
  });
  it("refuses workspace reset during ingestion", async () => {
    const { run } = await fresh();
    await expect(
      service.resetWorkspace(user, run.id, { eg: 0, sg: 0 }),
    ).rejects.toMatchObject({ code: "PREPAID_INGESTION_RUNNING" });
    expect((await service.sources(user, run.id)).valid).toBe(true);
  });
  it("summarizes allocation in SQL and serves only owned immutable archived CSV", async () => {
    const { run, layout } = await imported();
    await service.command(user, run.id, "eg", "validate", layout.version);
    const summary = await service.allocationSummary(user, run.id, "eg", "mt");
    expect(summary.rows.some((r) => r.type === "Posting Key 40")).toBe(true);
    expect(
      Number(
        summary.rows.find((r) => r.type === "GP EG MT Difference")?.difference,
      ),
    ).toBe(0);
    await legacyFrozenDelivery(user, run.id, "eg", layout.version);
    const response = await fetch(
      `${base}/runs/${run.id}/layouts/eg/reconciliation.csv?revisionId=${layout.id}`,
      { headers: { "x-test-user": user } },
    );
    expect(response.status).toBe(200);
    const csv = await response.text();
    await service.edit(
      user,
      run.id,
      "eg",
      (await service.layout(user, run.id, "eg")).version,
      "Correction",
    );
    const again = await fetch(
      `${base}/runs/${run.id}/layouts/eg/reconciliation.csv?revisionId=${layout.id}`,
      { headers: { "x-test-user": user } },
    );
    expect(await again.text()).toBe(csv);
    const denied = await fetch(
      `${base}/runs/${run.id}/layouts/eg/reconciliation.csv?revisionId=${layout.id}`,
      { headers: { "x-test-user": otherUser } },
    );
    expect(denied.status).toBe(404);
    for (const region of ["eg", "sg"] as const)
      for (const variant of ["mt", "bb"] as const)
        expect(
          (await service.allocationSummary(user, run.id, region, variant)).rows,
        ).toBeInstanceOf(Array);
  });
  it("reads a JV page in one query while preserving exact values, ownership and empty-page totals", async () => {
    const { run, layout } = await imported();
    await service.command(user, run.id, "eg", "validate", layout.version);
    await q(
      "UPDATE prepaid_jv_lines SET amount='9007199254740993.01' WHERE id=(SELECT min(id) FROM prepaid_jv_lines WHERE revision_id=$1)",
      [layout.id],
    );
    const query = vi.spyOn(pool, "query");
    let first;
    try {
      first = await service.output(
        user,
        run.id,
        "eg",
        "jv_lines",
        undefined,
        1,
        0,
      );
      expect(query).toHaveBeenCalledTimes(1);
    } finally {
      query.mockRestore();
    }
    expect(first!.rows).toHaveLength(1);
    expect(first!.rows[0].amount).toBe("9007199254740993.01");
    expect(typeof first!.rows[0].quantity).toBe("string");
    expect(
      Object.keys(first!.rows[0]).some((key) => key.startsWith("__")),
    ).toBe(false);
    const empty = await service.output(
      user,
      run.id,
      "eg",
      "jv_lines",
      undefined,
      1,
      first!.total + 1,
    );
    expect(empty.rows).toEqual([]);
    expect(empty.total).toBe(first!.total);
    await expect(
      service.output(otherUser, run.id, "eg", "jv_lines"),
    ).rejects.toMatchObject({ code: "PREPAID_RUN_NOT_FOUND" });
    await expect(
      service.output(
        user,
        run.id,
        "sg",
        "jv_lines",
        undefined,
        1,
        0,
        layout.id,
      ),
    ).rejects.toMatchObject({ code: "PREPAID_REVISION_NOT_FOUND" });
  });
  it("isolates ownership, validates exact names and requires all cycles", async () => {
    const run = await service.create(user, "2029-01");
    await expect(service.get(otherUser, run.id)).rejects.toMatchObject({
      code: "PREPAID_RUN_NOT_FOUND",
    });
    await expect(
      service.upload(user, run.id, "ke24", {
        originalname: "wrong.xlsx",
        buffer: Buffer.from("PK"),
        mimetype: "x",
      }),
    ).rejects.toMatchObject({ code: "PREPAID_FILE_NAME_INVALID" });
    expect((await service.sources(user, run.id)).missing).toContain("308_02");
    await expect(service.process(user, run.id)).rejects.toMatchObject({
      code: "PREPAID_SOURCE_INCOMPLETE",
    });
  });
  it("ingests atomically, calculates AMAXCE/recharge and conserves allocations across profit centres", async () => {
    const { run, layout } = await imported();
    expect(layout.rows).toHaveLength(28);
    expect(layout.rows.find((x) => x.layout_number === 12).hy_mt_gross).toBe(
      "56.00",
    );
    expect(layout.rows.find((x) => x.layout_number === 18)).toMatchObject({
      gp_mt_gross: "112.00",
      hy_mt_gross: "56.00",
      total_gross: "168.00",
    });
    const valid = await service.command(
      user,
      run.id,
      "eg",
      "validate",
      layout.version,
    );
    expect(valid.validation).toMatchObject({ valid: true, findings: [] });
    const output = await service.output(user, run.id, "eg", "jv_lines");
    expect(output.rows).toHaveLength(6);
    expect(Object.keys(output.rows[0].fields)).toHaveLength(40);
    expect(
      output.rows[0].fields["Account or Matchcode for theNext Line Item"],
    ).toBe("0000000123");
    expect(jvHeaders).toHaveLength(40);
  });
  it("rolls back all staging on a dataset checksum failure", async () => {
    const { job } = await executeIngestion(await fresh(), undefined, true);
    expect(
      (await q("SELECT status FROM prepaid_jobs WHERE id=$1", [job.id])).rows[0]
        .status,
    ).toBe("failed");
    expect(
      (
        await q(
          "SELECT count(*) n FROM prepaid_stage_ke24 WHERE snapshot_id=$1",
          [job.snapshotId],
        )
      ).rows[0].n,
    ).toBe("0");
  });
  it("rejects stale versions and read-only cells; preserves manual reclass and validates generated output atomically", async () => {
    const { run, layout } = await imported();
    await service.command(user, run.id, "eg", "validate", layout.version);
    await expect(
      service.save(user, run.id, "eg", {
        version: 0,
        reason: "test",
        changes: [{ layoutNumber: 22, field: "gp_mt_gross", value: "-120" }],
      }),
    ).rejects.toMatchObject({ code: "PREPAID_STALE_VERSION" });
    await expect(
      service.save(user, run.id, "eg", {
        version: layout.version,
        reason: "test",
        changes: [{ layoutNumber: 12, field: "gp_mt_gross", value: "1" }],
      }),
    ).rejects.toMatchObject({ code: "PREPAID_CELL_READ_ONLY" });
    const changed = await service.save(user, run.id, "eg", {
      version: layout.version,
      reason: "manual adjustment",
      changes: [{ layoutNumber: 22, field: "gp_mt_gross", value: "-120" }],
    });
    expect(changed.rows.find((x) => x.layout_number === 22).gp_mt_gross).toBe(
      "-120.00",
    );
    expect(changed.validation.findings).toContainEqual(
      expect.objectContaining({ code: "LAYOUT_VARIANCE" }),
    );
    expect(
      (await service.output(user, run.id, "eg", "jv_lines")).total,
    ).toBeGreaterThan(0);
    expect(
      (await service.command(user, run.id, "eg", "validate", changed.version))
        .validation.findings,
    ).toContainEqual(expect.objectContaining({ code: "LAYOUT_VARIANCE" }));
  });
  it("blocks missing SAP mapping and zero average rates", async () => {
    const missing = await imported((rows) => {
      rows.reference = [
        { ...(rows.reference[0] as any), sub_product: "OTHER" },
      ];
    });
    expect(
      (
        await service.command(
          user,
          missing.run.id,
          "eg",
          "validate",
          missing.layout.version,
        )
      ).validation.findings,
    ).toContainEqual(
      expect.objectContaining({ code: "REFERENCE_MAPPING_MISSING" }),
    );
    await expect(
      legacyFrozenDelivery(user, missing.run.id, "eg", missing.layout.version),
    ).rejects.toMatchObject({ code: "PREPAID_VALIDATION_FAILED" });
    const zero = await imported((rows) => {
      rows.reference = [{ ...(rows.reference[0] as any), average_rate: "0" }];
    });
    expect(
      (
        await service.command(
          user,
          zero.run.id,
          "eg",
          "validate",
          zero.layout.version,
        )
      ).validation.findings,
    ).toContainEqual({ code: "AVERAGE_RATE_ZERO" });
  });
  it("rejects freeze after sources change and forbids modifying ready staging", async () => {
    const { run, layout, job } = await imported();
    await expect(
      q("UPDATE prepaid_stage_ke24 SET data='{}' WHERE snapshot_id=$1", [
        job.snapshotId,
      ]),
    ).rejects.toThrow("PREPAID_SNAPSHOT_IMMUTABLE");
    await expect(
      q("UPDATE prepaid_source_snapshots SET manifest='{}' WHERE id=$1", [
        job.snapshotId,
      ]),
    ).rejects.toThrow("PREPAID_SNAPSHOT_IMMUTABLE");
    await service.upload(user, run.id, "load_up_eg", {
      originalname: expectedName("load_up_eg"),
      buffer: Buffer.from("PKdifferent"),
      mimetype: "x",
    });
    await expect(
      legacyFrozenDelivery(user, run.id, "eg", layout.version),
    ).rejects.toMatchObject({ code: "PREPAID_SOURCE_STALE" });
  });
  it("freezes immutable outputs, cancels an unsent predecessor and creates an editable draft", async () => {
    const { run, layout } = await imported();
    const frozen = await legacyFrozenDelivery(
      user,
      run.id,
      "eg",
      layout.version,
    );
    await expect(
      q("UPDATE prepaid_layout_rows SET gp_mt_gross=0 WHERE revision_id=$1", [
        frozen.revisionId,
      ]),
    ).rejects.toThrow("PREPAID_FROZEN_IMMUTABLE");
    await expect(
      q("UPDATE prepaid_region_revisions SET status='draft' WHERE id=$1", [
        frozen.revisionId,
      ]),
    ).rejects.toThrow("PREPAID_FROZEN_IMMUTABLE");
    await expect(
      q("DELETE FROM prepaid_events WHERE run_id=$1", [run.id]),
    ).rejects.toThrow("PREPAID_AUDIT_APPEND_ONLY");
    const current = await service.layout(user, run.id, "eg");
    const edit = await service.edit(
      user,
      run.id,
      "eg",
      current.version,
      "correction",
    );
    expect(edit.status).toBe("draft");
    expect(edit.revision).toBe(2);
    expect(
      (await q("SELECT status FROM prepaid_jobs WHERE id=$1", [frozen.jobId]))
        .rows[0].status,
    ).toBe("cancelled");
    expect(
      (
        await q("SELECT status FROM prepaid_region_revisions WHERE id=$1", [
          frozen.revisionId,
        ])
      ).rows[0].status,
    ).toBe("frozen");
  });
  it("delivers a frozen JV; after Edit sends a full reversal before replacement", async () => {
    const { run, layout } = await imported();
    const first = await legacyFrozenDelivery(
      user,
      run.id,
      "eg",
      layout.version,
    );
    const sending = await advance(first.jobId);
    expect(sending.phase).toBe("replacement-running");
    expect((await receipt(first.jobId, "delivered")).status).toBe("completed");
    const frozen = await service.layout(user, run.id, "eg"),
      draft = await service.edit(
        user,
        run.id,
        "eg",
        frozen.version,
        "correction",
      );
    const second = await legacyFrozenDelivery(
      user,
      run.id,
      "eg",
      draft.version,
    );
    const reversal = await advance(second.jobId);
    expect(reversal.phase).toBe("reversal-running");
    const oldLines = (
      await service.output(
        user,
        run.id,
        "eg",
        "jv_lines",
        undefined,
        100,
        0,
        first.revisionId,
      )
    ).rows;
    const lines = (
      await q(`SELECT ${repo.schema}.prepaid_reversal_lines($1) fields`, [
        first.revisionId,
      ])
    ).rows;
    expect(lines[0].fields["Posting Key"]).toBe(
      oldLines[0].posting_key === 40 ? "50" : "40",
    );
    expect(lines[0].fields["Amount in local currency"]).toBe(
      oldLines[0].fields["Amount in local currency"],
    );
    expect((await receipt(second.jobId, "delivered")).phase).toBe(
      "replacement-ready",
    );
    expect((await advance(second.jobId)).phase).toBe("replacement-running");
    expect((await receipt(second.jobId, "delivered")).status).toBe("completed");
    expect((await service.exports(user, run.id)).map((x) => x.kind)).toEqual(
      expect.arrayContaining(["replacement", "reversal"]),
    );
  });
  it("never retries unknown remote outcomes and reconciles attested receipt without resending", async () => {
    const { run, layout } = await imported();
    const frozen = await legacyFrozenDelivery(
      user,
      run.id,
      "eg",
      layout.version,
    );
    const job = await advance(frozen.jobId);
    terminal.set(job.execution_arn, { status: "SUCCEEDED", output: "{}" });
    expect((await advance(frozen.jobId)).status).toBe("unknown");
    await expect(
      service.retry(user, run.id, frozen.jobId),
    ).rejects.toMatchObject({ code: "PREPAID_JOB_NOT_RETRYABLE" });
    const attempts = start.mock.calls.length;
    const input = job.payload.executionInput,
      key = `${input.receiptPrefix}verified-late.json`;
    jsonObject(key, {
      contractVersion: 1,
      deliveryId: input.deliveryId,
      exportId: input.exportId,
      sha256: input.sha256,
      executionArn: job.execution_arn,
      kind: input.kind,
      outcome: "delivered",
      receiptId: "late-proof",
      confirmedAt: new Date().toISOString(),
    });
    await service.reconcile(user, run.id, frozen.jobId, key);
    expect((await advance(frozen.jobId)).status).toBe("completed");
    expect(start.mock.calls.length).toBe(attempts);
  });
  it("retries a confirmed no-delivery leg with a new execution name", async () => {
    const { run, layout } = await imported();
    const frozen = await legacyFrozenDelivery(
      user,
      run.id,
      "eg",
      layout.version,
    );
    const initial = await advance(frozen.jobId);
    expect((await receipt(frozen.jobId, "not_delivered")).status).toBe(
      "failed",
    );
    await service.retry(user, run.id, frozen.jobId);
    const retried = await advance(frozen.jobId);
    expect(retried.execution_arn).not.toBe(initial.execution_arn);
    expect(retried.phase).toBe("replacement-running");
    expect((await receipt(frozen.jobId, "delivered")).status).toBe("completed");
  });
  it("contract rejects floating-point money and invalid reference data", () => {
    expect(
      datasetSchemas.loadup.safeParse({
        period: "2026-10",
        region: "eg",
        amount: 0.1,
      }).success,
    ).toBe(false);
    expect(
      datasetSchemas.reference.safeParse({
        ...(data("2026-10").reference[0] as any),
        tax_rate: "2",
      }).success,
    ).toBe(false);
  });
  it("imports SG trade/internal call cards and signed AMAXCE into the correct rows", async () => {
    const context = await executeIngestion(await fresh(), (rows) => {
      rows.ke24 = rows.ke24.map((k) =>
        (k as any).cfu === "EG" ? { ...(k as any), cfu: "SG" } : k,
      );
      rows.loadup = [
        { period: contextPeriod(rows), region: "sg", amount: "112" },
      ];
      const period = contextPeriod(rows);
      rows.callcard = [
        {
          period,
          region: "sg",
          kind: "trade",
          month_no: Number(period.slice(5)),
          amount: "40",
        },
        {
          period,
          region: "sg",
          kind: "internal",
          month_no: Number(period.slice(5)),
          amount: "72",
        },
      ];
      rows.adjustments = [
        {
          period,
          cycle: "01",
          customer_type: "S",
          code: "AMAXCEP",
          amount: "-10",
          currency: "PHP",
        },
      ];
      rows.charges = [
        {
          period,
          cycle: "02",
          customer_type: "S",
          code: "AMAXCEP",
          amount: "60",
          currency: "PHP",
        },
      ];
      rows.recharge = [
        {
          period,
          customer_type: "S",
          method: "PS",
          channel: "RP",
          amount: "62",
        },
      ];
      rows.reference.push({
        ...(rows.reference[0] as any),
        cfu: "SG",
        revenue_type: "MT",
      });
    });
    const layout = await service.command(
      user,
      context.run.id,
      "sg",
      "import",
      0,
    );
    expect(layout.rows.find((x) => x.layout_number === 10).hy_mt_gross).toBe(
      "50.00",
    );
    expect(layout.rows.find((x) => x.layout_number === 12).gp_mt_gross).toBe(
      "40.00",
    );
    expect(layout.rows.find((x) => x.layout_number === 13).gp_mt_gross).toBe(
      "72.00",
    );
    expect(
      (
        await service.command(
          user,
          context.run.id,
          "sg",
          "validate",
          layout.version,
        )
      ).validation,
    ).toMatchObject({ valid: true, findings: [] });
  });
  function contextPeriod(rows: Record<Dataset, unknown[]>) {
    return (rows.ke24[0] as any).period as string;
  }
  it("allocates broadband manual splits using fallback mappings and conserves gross/net", async () => {
    const { run, layout } = await imported((rows) => {
      const period = contextPeriod(rows);
      const base = {
        ...(rows.ke24[2] as any),
        revenue_type: "BB",
        amount: "100",
        cfu: "CB",
      };
      rows.ke24.push(base, { ...base, cfu: "SG" });
      rows.reference.push({
        ...(rows.reference[0] as any),
        period,
        cfu: "CB",
        revenue_type: "BB",
      });
    });
    const changed = await service.save(user, run.id, "eg", {
      version: layout.version,
      reason: "Broadband split",
      changes: [
        { layoutNumber: 9, field: "gp_bb_gross", value: "112" },
        { layoutNumber: 23, field: "gp_bb_gross", value: "-67.20" },
        { layoutNumber: 24, field: "gp_bb_gross", value: "-44.80" },
      ],
    });
    const valid = await service.command(
      user,
      run.id,
      "eg",
      "validate",
      changed.version,
    );
    expect(valid.validation).toMatchObject({ valid: true, findings: [] });
    const bb = await service.output(user, run.id, "eg", "allocations", "bb");
    expect(
      bb.rows.filter((r) => r.allocation_type === "").map((r) => r.amount2),
    ).toEqual(["50.00", "50.00"]);
    expect(
      bb.rows
        .filter((r) => r.allocation_type === "GP_CB_BB")
        .map((r) => r.amount2),
    ).toEqual([expect.stringMatching(/^60(?:\.0+)?$/)]);
  });
  it("characterizes the legacy fractional broadband quantity difference without changing approved calculations", async () => {
    const { run, layout } = await imported((rows) => {
      const base = {
        ...(rows.ke24[2] as any),
        revenue_type: "BB",
        amount: "100",
        cfu: "CB",
      };
      rows.ke24.push(base, { ...base, cfu: "SG" });
      rows.reference.push({
        ...(rows.reference[0] as any),
        cfu: "CB",
        revenue_type: "BB",
      });
    });
    await service.save(user, run.id, "eg", {
      version: layout.version,
      reason: "Characterization only",
      changes: [
        { layoutNumber: 9, field: "gp_bb_gross", value: "22.40" },
        { layoutNumber: 23, field: "gp_bb_gross", value: "-5.60" },
        { layoutNumber: 24, field: "gp_bb_gross", value: "-16.80" },
      ],
    });
    const bb = await service.output(user, run.id, "eg", "allocations", "bb");
    expect(
      bb.rows.filter((r) => r.allocation_type === "").map((r) => r.hits2),
    ).toEqual(["1", "1"]);
    expect(bb.rows.find((r) => r.allocation_type === "GP_CB_BB")?.hits2).toBe(
      "1",
    );
    // C145/C146 sums split HITS2 without the current final whole-number round.
    const legacy = (
      await q(
        "SELECT sum(hits2*0.25) quantity FROM prepaid_allocations WHERE revision_id=$1 AND variant='bb' AND allocation_type=''",
        [bb.revisionId],
      )
    ).rows[0];
    expect(Number(legacy.quantity)).toBe(0.5);
  });
  it("preserves verified EG source totals only under the explicit legacy policy and audits the derived remainder", async () => {
    await service.configure(user, {
      ...configuration,
      sourceSplitPolicy: "legacy_eg_total",
    });
    try {
      const { run, layout } = await imported();
      expect(
        layout.rows.find((r) => r.layout_number === 9).editable_fields,
      ).toEqual(["hy_mt_gross", "gp_bb_gross"]);
      expect(
        (await service.layout(user, run.id, "sg")).rows.find(
          (r) => r.layout_number === 8,
        ).editable_fields,
      ).toContain("gp_mt_gross");
      await expect(
        service.save(user, run.id, "eg", {
          version: layout.version,
          reason: "forbidden direct remainder",
          changes: [{ layoutNumber: 9, field: "gp_mt_gross", value: "999" }],
        }),
      ).rejects.toMatchObject({ code: "PREPAID_SPLIT_REMAINDER_READ_ONLY" });
      const saved = await service.save(user, run.id, "eg", {
        version: layout.version,
        reason: "HY split",
        changes: [{ layoutNumber: 9, field: "hy_mt_gross", value: "56" }],
      });
      expect(saved.rows.find((r) => r.layout_number === 9)).toMatchObject({
        gp_mt_gross: "168.00",
        hy_mt_gross: "56.00",
        total_gross: "224.00",
      });
      const derived = (
        await q(
          "SELECT changes FROM prepaid_adjustments WHERE revision_id=$1 AND reason='Legacy EG source-total remainder calculation'",
          [saved.id],
        )
      ).rows[0];
      expect(derived.changes[0]).toMatchObject({
        layoutNumber: 9,
        derived: true,
        previous: "224.00",
      });
      expect(
        (
          await q(
            "SELECT original_gross FROM prepaid_source_totals WHERE revision_id=$1 AND layout_number=9",
            [saved.id],
          )
        ).rows[0].original_gross,
      ).toBe("224.00");
      await expect(
        q(
          "UPDATE prepaid_source_totals SET original_gross=999 WHERE revision_id=$1",
          [saved.id],
        ),
      ).rejects.toThrow("PREPAID_AUDIT_APPEND_ONLY");
      await service.freeze(user, run.id, "eg", saved.version);
      const frozen = await service.layout(user, run.id, "eg");
      const draft = await service.edit(
        user,
        run.id,
        "eg",
        frozen.version,
        "correct split",
      );
      const cleared = await service.save(user, run.id, "eg", {
        version: draft.version,
        reason: "clear split",
        changes: [{ layoutNumber: 9, field: "hy_mt_gross", value: null }],
      });
      expect(cleared.rows.find((r) => r.layout_number === 9)).toMatchObject({
        gp_mt_gross: "224.00",
        total_gross: "224.00",
      });
      expect((await service.layout(user, run.id, "eg")).id).not.toBe(frozen.id);
      await service.upload(user, run.id, "load_up_eg", {
        originalname: expectedName("load_up_eg"),
        buffer: Buffer.from("PKnew-source"),
        mimetype: "x",
      });
      const job = await service.process(user, run.id);
      await executeIngestion({ run, job, period: run.period }, (rows) => {
        (rows.loadup[0] as any).amount = "336";
      });
      const reimported = await service.command(
        user,
        run.id,
        "eg",
        "import",
        cleared.version,
      );
      expect(
        reimported.rows.find((r) => r.layout_number === 9).total_gross,
      ).toBe("336.00");
      expect(
        (
          await q(
            "SELECT original_gross FROM prepaid_source_totals WHERE revision_id=$1 AND layout_number=9 ORDER BY original_gross",
            [draft.id],
          )
        ).rows.map((r) => r.original_gross),
      ).toEqual(["224.00", "336.00"]);
      expect(
        (
          await q(
            "SELECT gp_mt_gross FROM prepaid_layout_rows WHERE revision_id=$1 AND layout_number=9",
            [frozen.id],
          )
        ).rows[0].gp_mt_gross,
      ).toBe("168.00");
    } finally {
      await service.configure(user, configuration);
    }
  });
  it("reports legacy reference membership separately from rates, with exact GP/non-BB distinct selection", async () => {
    const { run, layout } = await imported((rows) => {
      for (const r of rows.reference) (r as any).source_brand = "OTHER";
    });
    await service.command(user, run.id, "eg", "validate", layout.version);
    const all = await service.referenceMembership(user, run.id, "eg", "all");
    expect(all.complete).toBe(true);
    expect(all.rows.some((r) => r.revenue_type === "HY_EG_MT")).toBe(true);
    const gp = await service.referenceMembership(
      user,
      run.id,
      "eg",
      "gp-non-bb",
    );
    expect(gp.rows).toHaveLength(1);
    expect(gp.rows[0]).toMatchObject({
      revenue_type: "GP_EG_MT",
      sub_product: "SUB",
      cost_element: "0000000123",
    });
    // Legacy views are reports; missing membership does not introduce a new Freeze gate.
    await service.freeze(user, run.id, "eg", layout.version);
    await expect(
      service.referenceMembership(otherUser, run.id, "eg", "all"),
    ).rejects.toMatchObject({ code: "PREPAID_RUN_NOT_FOUND" });
    const csv = await fetch(
      `${base}/runs/${run.id}/layouts/eg/reference-membership.csv?mode=gp-non-bb`,
      { headers: { "x-test-user": user } },
    );
    expect(csv.status).toBe(200);
    expect(await csv.text()).toContain("GP_EG_MT,SUB,0000000123");
    const matched = await imported((rows) => {
      for (const r of rows.reference) (r as any).source_brand = "OTHER";
      rows.reference.push({
        ...(rows.reference[0] as any),
        source_brand: "GHP-PREPAID",
        cfu: "EG",
        cost_element: "999",
      });
    });
    await service.command(
      user,
      matched.run.id,
      "eg",
      "validate",
      matched.layout.version,
    );
    expect(
      (
        await service.referenceMembership(
          user,
          matched.run.id,
          "eg",
          "gp-non-bb",
        )
      ).rows,
    ).toHaveLength(0);
  });
  it("does not invent membership evidence for older adapters missing source_brand", async () => {
    const { run, layout } = await imported();
    await service.command(user, run.id, "eg", "validate", layout.version);
    expect(
      await service.referenceMembership(user, run.id, "eg", "all"),
    ).toMatchObject({
      complete: false,
      reason: "REFERENCE_MEMBERSHIP_SOURCE_BRAND_UNVERIFIED",
      rows: [],
    });
    const response = await fetch(
      `${base}/runs/${run.id}/layouts/eg/reference-membership.csv`,
      { headers: { "x-test-user": user } },
    );
    expect(response.status).toBe(409);
  });
  it("does not dispatch a replacement while the predecessor outcome is unknown", async () => {
    const { run, layout } = await imported();
    const first = await legacyFrozenDelivery(
      user,
      run.id,
      "eg",
      layout.version,
    );
    const original = await advance(first.jobId);
    terminal.set(original.execution_arn, { status: "SUCCEEDED", output: "{}" });
    await advance(first.jobId);
    const frozen = await service.layout(user, run.id, "eg"),
      draft = await service.edit(
        user,
        run.id,
        "eg",
        frozen.version,
        "Pending correction",
      );
    const next = await legacyFrozenDelivery(user, run.id, "eg", draft.version),
      starts = start.mock.calls.length;
    expect((await advance(next.jobId)).phase).toBe("initial");
    expect(start.mock.calls.length).toBe(starts);
    await service.reconcile(user, run.id, first.jobId);
    await receipt(first.jobId, "delivered");
    expect((await advance(next.jobId)).phase).toBe("reversal-running");
  });
  it("claims each outbox job once across concurrent workers", async () => {
    const { run, layout } = await imported();
    const frozen = await legacyFrozenDelivery(
      user,
      run.id,
      "eg",
      layout.version,
    );
    await q(
      "UPDATE prepaid_jobs SET available_at=now()+interval '1 day' WHERE id<>$1",
      [frozen.jobId],
    );
    const starts = start.mock.calls.length;
    await Promise.all([worker.tick(true), worker.tick(true)]);
    expect(start.mock.calls.length - starts).toBe(1);
    expect((await receipt(frozen.jobId, "delivered")).status).toBe("completed");
  });
  it("HTTP routes enforce authentication, module/owner isolation, admin config and request validation", async () => {
    expect((await fetch(`${base}/runs`)).status).toBe(401);
    expect(
      (
        await fetch(`${base}/runs`, {
          headers: { "x-test-user": randomUUID() },
        })
      ).status,
    ).toBe(403);
    const run = await service.create(user, "2028-01");
    expect(
      (
        await fetch(`${base}/runs/${run.id}`, {
          headers: { "x-test-user": otherUser },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await fetch(`${base}/integration`, {
          method: "PUT",
          headers: {
            "x-test-user": otherUser,
            "content-type": "application/json",
          },
          body: JSON.stringify(configuration),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${base}/runs`, {
          method: "POST",
          headers: { "x-test-user": user, "content-type": "application/json" },
          body: JSON.stringify({ period: "invalid" }),
        })
      ).status,
    ).toBe(400);
    const uploaded = new FormData();
    uploaded.set("file", new Blob(["PKtest"]), "KE24.XLSX");
    expect(
      (
        await fetch(`${base}/runs/${run.id}/sources/ke24`, {
          method: "POST",
          headers: { "x-test-user": user },
          body: uploaded,
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await fetch(`${base}/runs/${run.id}/process`, {
          method: "POST",
          headers: { "x-test-user": user },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${base}/layouts/eg/freeze`, {
          method: "PATCH",
          headers: { "x-test-user": user, "content-type": "application/json" },
          body: JSON.stringify({ frozen: false, version: 0 }),
        })
      ).status,
    ).toBe(400);
    const sources = await fetch(`${base}/runs/${run.id}/sources`, {
      headers: { "x-test-user": user },
    });
    expect((await sources.json()).missing).toContain("318_02");
  });
  it("verifies upstream execution provenance and never mixes or alters AMAXCE datasets", async () => {
    const attach = async (run: Record<string, any>) => {
      const executionArn = `arn:test:upstream-${run.id}`,
        manifestKey = `test-upstream/${run.id}/manifest.json`;
      const rows = data(run.period);
      const datasets = (["adjustments", "charges"] as const).map((name) => {
        const key = `test-upstream/${run.id}/${name}.ndjson`,
          bytes = Buffer.from(
            rows[name].map((row) => JSON.stringify(row)).join("\n") + "\n",
          );
        objects.set(key, bytes);
        return {
          name,
          key,
          sha256: sha256(bytes),
          rowCount: rows[name].length,
        };
      });
      jsonObject(manifestKey, {
        contractVersion: 1,
        period: run.period,
        provider: "test-308-318",
        executionArn,
        workspaceId: run.workspace_id,
        coverage: configuration.expectedCycles.map((cycle) => ({
          cycle,
          adjustments: true,
          charges: true,
        })),
        datasets,
      });
      terminal.set(executionArn, {
        status: "SUCCEEDED",
        output: JSON.stringify({
          contractVersion: 1,
          period: run.period,
          workspaceId: run.workspace_id,
          manifestKey,
        }),
      });
      await service.attachUpstream(user, run.id, manifestKey);
    };
    const good = await executeIngestion(await fresh(attach));
    const snapshot = (
      await q("SELECT * FROM prepaid_source_snapshots WHERE id=$1", [
        good.job.snapshotId,
      ])
    ).rows[0];
    expect(snapshot.status).toBe("ready");
    expect(snapshot.source_files).toHaveLength(8);
    expect(
      snapshot.source_files.some((f: any) => f.source_code.startsWith("308")),
    ).toBe(false);
    const tampered = await executeIngestion(await fresh(attach), (rows) => {
      rows.charges = [{ ...(rows.charges[0] as any), amount: "70" }];
    });
    expect(
      (
        await q("SELECT status FROM prepaid_source_snapshots WHERE id=$1", [
          tampered.job.snapshotId,
        ])
      ).rows[0].status,
    ).toBe("failed");
    const wrong = await fresh(async (run) => {
      await attach(run);
      terminal.set(`arn:test:upstream-${run.id}`, {
        status: "SUCCEEDED",
        output: JSON.stringify({
          contractVersion: 1,
          period: "1999-01",
          workspaceId: run.workspace_id,
          manifestKey: `test-upstream/${run.id}/manifest.json`,
        }),
      });
    });
    await advance(wrong.job.id);
    expect(
      (await q("SELECT status FROM prepaid_jobs WHERE id=$1", [wrong.job.id]))
        .rows[0].status,
    ).toBe("failed");
  });
  it("does not repeat a successful reversal when retrying a failed replacement", async () => {
    const { run, layout } = await imported();
    const first = await legacyFrozenDelivery(
      user,
      run.id,
      "eg",
      layout.version,
    );
    await advance(first.jobId);
    await receipt(first.jobId, "delivered");
    const current = await service.layout(user, run.id, "eg");
    const draft = await service.edit(
      user,
      run.id,
      "eg",
      current.version,
      "Retry scenario",
    );
    const correction = await legacyFrozenDelivery(
      user,
      run.id,
      "eg",
      draft.version,
    );
    const before = start.mock.calls.length;
    await advance(correction.jobId);
    await receipt(correction.jobId, "delivered");
    await advance(correction.jobId);
    await receipt(correction.jobId, "not_delivered");
    await service.retry(user, run.id, correction.jobId);
    await advance(correction.jobId);
    expect(
      start.mock.calls
        .slice(before)
        .filter((call) => call[1].kind === "reversal"),
    ).toHaveLength(1);
    expect(
      start.mock.calls
        .slice(before)
        .filter((call) => call[1].kind === "replacement"),
    ).toHaveLength(2);
    expect((await receipt(correction.jobId, "delivered")).status).toBe(
      "completed",
    );
  });
  it("recovers a lost AWS dispatch response using the original named leg", async () => {
    const { run, layout } = await imported();
    const frozen = await legacyFrozenDelivery(
      user,
      run.id,
      "eg",
      layout.version,
    );
    start.mockImplementationOnce(async (_machine, input, name) => {
      executionInputs.set(`arn:test:${name}`, input);
      throw new Error("Lost dispatch response");
    });
    const uncertain = await advance(frozen.jobId);
    expect(uncertain.status).toBe("waiting");
    expect(uncertain.phase).toBe("replacement-starting");
    const originalName = start.mock.calls.at(-1)![2];
    expect((await advance(frozen.jobId)).phase).toBe("replacement-running");
    expect(start.mock.calls.at(-1)![2]).toBe(originalName);
    expect((await receipt(frozen.jobId, "delivered")).status).toBe("completed");
  });
  it("uses the correct debit/credit keys for negative reclassified revenue", async () => {
    const { run, layout } = await imported((rows) => {
      rows.ke24[0] = { ...(rows.ke24[0] as any), amount: "-300" };
    });
    expect(
      (await service.command(user, run.id, "eg", "validate", layout.version))
        .validation.valid,
    ).toBe(true);
    const allocations = (
      await service.output(user, run.id, "eg", "allocations")
    ).rows;
    expect(
      allocations
        .filter(
          (a) => a.allocation_type === "" && a.revenue_type === "GP_EG_MT",
        )
        .every((a) => a.posting_key === 40 && a.amount2.startsWith("-")),
    ).toBe(true);
    const jv = (await service.output(user, run.id, "eg", "jv_lines")).rows;
    expect(
      jv.every(
        (line) =>
          !line.amount.startsWith("-") && !line.quantity.startsWith("-"),
      ),
    ).toBe(true);
    expect(
      (
        await service.output(
          user,
          run.id,
          "eg",
          "jv_lines",
          undefined,
          100,
          1000,
        )
      ).total,
    ).toBe(jv.length);
  });
});
