import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import {
  BackendSourceNormalizer,
  type SourceNormalizer,
} from "../src/modules/prepaid/infrastructure/sourceNormalizer.js";
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
import {
  PrepaidStorage,
  sha256,
} from "../src/modules/prepaid/infrastructure/prepaidStorage.js";
import { LegacyLanding } from "../src/modules/prepaid/infrastructure/legacyLanding.js";
import { PrepaidSourceExtractionWorker } from "../src/modules/prepaid/application/sourceExtractionWorker.js";
import { PrepaidPreparationWorker } from "../src/modules/prepaid/application/preparationWorker.js";
import {
  sourceCodes,
  manualIntegrationSchema,
} from "../src/modules/prepaid/domain/contracts.js";
import { verifiedExtractionBridge } from "../src/modules/prepaid/application/sourceExtractionBridge.js";
import {
  sourceWorkflows,
  sourceBelongsTo,
  sourceLandingName,
  type SourceWorkflow,
} from "../src/modules/prepaid/domain/sourceExtraction.js";
import type { StepFunctionsRunner } from "../src/stepFunctionsRunner.js";
import { fakeS3, legacyDefinition } from "./fixtures/prepaidSource.js";
import { PrepaidReferenceCatalog } from "../src/modules/prepaid/infrastructure/referenceCatalog.js";
import { legacyReferenceFields } from "../src/modules/prepaid/domain/referenceRefresh.js";

const testUrl = process.env.PREPAID_TEST_DATABASE_URL;
if (testUrl) {
  const url = new URL(testUrl);
  if (
    url.hostname !== "127.0.0.1" ||
    url.port !== "55479" ||
    url.username !== "prepaid_test"
  )
    throw Error("Use only the isolated prepaid_test cluster on port 55479.");
}
describe.skipIf(!testUrl)(
  "Backend-owned source preparation (isolated DB, mocked AWS)",
  () => {
    const schema = `prepaid_extract_${randomUUID().replaceAll("-", "")}`,
      raw = `${schema}_raw`;
    const pool = new Pool({
      connectionString: testUrl,
      options: `-c search_path=${schema}`,
    });
    const repo = new PrepaidRepository(pool, schema),
      s3 = fakeS3();
    const storage = new PrepaidStorage({ send: s3.send } as any, "test-bucket");
    const landing = new LegacyLanding({ send: s3.send } as any, "test-bucket");
    const settings = {
      envPrefix: "isg-esatp-dv" as const,
      sharedWritesApproved: true as const,
    };
    const executions = new Map<string, any>();
    let invalidDefinition = false,
      loseNextStart = false;
    const start = vi.fn(async (machine: string, input: any, name: string) => {
      const arn = `arn:aws:states:us-east-1:123456789012:execution:${machine}:${name}`;
      const saved = executions.get(arn);
      if (saved && JSON.stringify(saved.input) !== JSON.stringify(input))
        throw Error("Input changed");
      if (!saved) executions.set(arn, { input, status: "RUNNING" });
      if (loseNextStart) {
        loseNextStart = false;
        throw Error("Lost AWS response");
      }
      return { executionArn: arn };
    });
    const runner = {
      describeStateMachineDefinition: async (machine: string) => {
        const workflow = (
          Object.keys(sourceWorkflows) as SourceWorkflow[]
        ).find((w) => sourceWorkflows[w].machine === machine)!;
        return {
          arn: `arn:aws:states:us-east-1:123456789012:stateMachine:${machine}`,
          status: "ACTIVE",
          type: "STANDARD",
          definition: JSON.stringify(
            invalidDefinition
              ? { StartAt: "Missing", States: {} }
              : legacyDefinition(workflow),
          ),
        };
      },
      startExecution: start,
      describeExecution: async (arn: string) => {
        const e = executions.get(arn);
        return {
          ...e,
          input: JSON.stringify(e.input),
          inputIncluded: true,
          outputIncluded: true,
        };
      },
    } as unknown as StepFunctionsRunner;
    const inspector = {
      verify: vi.fn(async () => {}),
      verifyIsolation: vi.fn(async () => {}),
      idle: vi.fn(async () => {}),
    };
    const normalizer = {
      normalizeRaw: async (_workflow: any, _code: any, tables: any) =>
        JSON.parse(
          (Object.values(tables).flat() as any[]).find(
            (row: any) => row.__datasets,
          ).__datasets,
        ),
      revision: async () => "a".repeat(64),
      normalize: vi.fn(async (workflow: SourceWorkflow, code: string) =>
        workflow === "ke24"
          ? {
              ke24: [
                {
                  period: "2026-09",
                  brand: "GP",
                  cfu: "EG",
                  revenue_type: "MT",
                  cost_element: "123",
                  profit_center: "P1",
                  sub_product: "SUB",
                  uom: "EA",
                  reference_document: "REF",
                  amount: "-100.00",
                  quantity: "10",
                  currency: "PHP",
                },
                {
                  period: "2026-09",
                  brand: "GP",
                  cfu: "CM",
                  revenue_type: "MT",
                  cost_element: "123",
                  profit_center: "P1",
                  sub_product: "SUB",
                  uom: "EA",
                  reference_document: "REF",
                  amount: "100.00",
                  quantity: "10",
                  currency: "PHP",
                },
                {
                  period: "2026-09",
                  brand: "GP",
                  cfu: "SG",
                  revenue_type: "MT",
                  cost_element: "123",
                  profit_center: "P1",
                  sub_product: "SUB",
                  uom: "EA",
                  reference_document: "REF",
                  amount: "-60.00",
                  quantity: "10",
                  currency: "PHP",
                },
              ],
            }
          : workflow === "callcard_eg"
            ? {
                callcard: [1, 2].map(() => ({
                  region: "eg",
                  kind: "trade",
                  month_no: 9,
                  amount: "1.50",
                })),
              }
            : workflow.startsWith("load_up")
              ? {
                  loadup: [
                    {
                      region: workflow.endsWith("eg") ? "eg" : "sg",
                      amount: "100.00",
                    },
                  ],
                }
              : workflow === "monthly_recharge"
                ? {
                    recharge: [
                      {
                        customer_type: "E",
                        method: "PS",
                        channel: "RP",
                        amount: "-10.00",
                      },
                      {
                        customer_type: "S",
                        method: "PS",
                        channel: "RP",
                        amount: "3.00",
                      },
                    ],
                  }
                : workflow === "charges_318"
                  ? {
                      charge_headers: [
                        {
                          cycle: code.slice(4),
                          cycleYear: "2026",
                          cycleInstance: "9",
                        },
                      ],
                      charges: [
                        {
                          cycle: code.slice(4),
                          customer_type: "E",
                          code: "AMAXCEP",
                          amount: "5.00",
                          currency: "PHP",
                        },
                      ],
                    }
                  : workflow === "callcard_sg"
                    ? {
                        callcard: ["trade", "internal"].map((kind) => ({
                          region: "sg",
                          kind,
                          month_no: 9,
                          sourcePeriod: "2026-09",
                          amount: "12.30",
                        })),
                      }
                    : workflow.startsWith("load_api")
                      ? {
                          loadapi: [
                            {
                              region: workflow.endsWith("eg") ? "eg" : "sg",
                              amount: "12.30",
                            },
                          ],
                        }
                      : {
                          adjustment_headers: [
                            {
                              cycle: code.slice(4),
                              cycleYear: "2026",
                              cycleInstance: "9",
                            },
                          ],
                          adjustments: [
                            {
                              cycle: code.slice(4),
                              customer_type: "E",
                              code: "ABC",
                              amount: "-1.00",
                              currency: "PHP",
                            },
                          ],
                        },
      ),
    };
    // This suite tests worker orchestration. Native row/column/ownership and
    // database-to-accounting behavior are exercised by prepaid.glueRawSource.
    const fixtureReader = (
      normalize: (workflow: any, code: any) => Promise<any>,
    ) => ({
      capture: async (request: any) => ({
        contract: "glue_raw_v1" as const,
        executionArn: request.executionArn,
        connectionName: "fixture",
        jobs: sourceWorkflows[request.workflow as SourceWorkflow].jobs.map(
          (number, i) => ({
            name: `isg-esatp-dv-prep_reclass-gljo-extract_${number}`,
            id: `jr_${number}`,
            startedAt: "2026-09-01T00:00:00.000Z",
            completedAt: "2026-09-01T00:01:00.000Z",
            table:
              sourceWorkflows[request.workflow as SourceWorkflow].targets[i],
          }),
        ),
        tables: Object.fromEntries(
          await Promise.all(
            sourceWorkflows[request.workflow as SourceWorkflow].targets.map(
              async (table) => [
                table,
                await Promise.all(
                  request.sources.map(async (source: any) => ({
                    filename: sourceLandingName(request.workflow, source.code),
                    __datasets: JSON.stringify(
                      await normalize(request.workflow, source.code),
                    ),
                  })),
                ),
              ],
            ),
          ),
        ),
      }),
    });
    const rawReader = fixtureReader((workflow, code) =>
      normalizer.normalize.getMockImplementation()!(workflow, code),
    );
    const logger = { info: vi.fn(), error: vi.fn() };
    const worker = new PrepaidSourceExtractionWorker(
      repo,
      storage,
      runner,
      {
        normalizer,
        inspector,
        landing,
        rawReader,
      },
      logger,
    );
    beforeAll(async () => {
      await pool.query(
        `CREATE SCHEMA "${schema}"; CREATE TABLE app_user(id uuid PRIMARY KEY,is_active boolean DEFAULT true,is_admin boolean DEFAULT true); CREATE TABLE workspaces(id uuid PRIMARY KEY,user_id uuid)`,
      );
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await migratePrepaid(c, schema, raw);
        await c.query("COMMIT");
      } finally {
        c.release();
      }
    });
    beforeEach(() => {
      s3.objects.clear();
      executions.clear();
      start.mockClear();
      logger.info.mockClear();
      logger.error.mockClear();
      normalizer.normalize.mockClear();
      invalidDefinition = false;
      loseNextStart = false;
      inspector.idle.mockReset().mockResolvedValue(undefined);
      inspector.verifyIsolation.mockReset().mockResolvedValue(undefined);
    });
    afterAll(async () => {
      await pool.query(
        `DROP SCHEMA "${raw}" CASCADE; DROP SCHEMA "${schema}" CASCADE`,
      );
      await pool.end();
    });
    async function context(all = false, independent = false) {
      const owner = randomUUID(),
        workspace = randomUUID(),
        sessionId = randomUUID(),
        id = randomUUID(),
        token = randomUUID();
      const files = (
        all
          ? [
              ...sourceCodes,
              ...(independent
                ? ["308_01", "318_06"]
                : ["308_01", "308_06", "318_01", "318_06"]),
            ]
          : ["callcard_sg", "load_api_eg", "load_api_sg", "308_01", "308_06"]
      ).map((code) => {
        const source = randomUUID(),
          key = `prepaid_reclass/sessions/${sessionId}/sources/${source}/${code}.xlsx`,
          bytes = Buffer.from(code);
        s3.set(key, bytes);
        return {
          id: source,
          source_code: code,
          object_key: key,
          sha256: sha256(bytes),
          original_name: code + ".xlsx",
          size_bytes: bytes.length,
          uploaded_by: owner,
          created_at: new Date().toISOString(),
        };
      });
      await pool.query("INSERT INTO app_user(id) VALUES($1)", [owner]);
      await pool.query("INSERT INTO workspaces(id,user_id) VALUES($1,$2)", [
        workspace,
        owner,
      ]);
      const session = (
        await pool.query(
          "INSERT INTO prepaid_upload_sessions(id,workspace_id,configuration,status,version) VALUES($1,$2,'{}','pending',5) RETURNING *",
          [sessionId, workspace],
        )
      ).rows[0];
      const job = (
        await pool.query(
          "INSERT INTO prepaid_preparation_jobs(id,session_id,source_version,attempt,source_files,status,execution_name,lease_token) VALUES($1,$2,5,1,$3,'running',$4,$5) RETURNING *",
          [id, sessionId, JSON.stringify(files), `test-${id}`, token],
        )
      ).rows[0];
      return { owner, session, job, token };
    }
    type Context = Awaited<ReturnType<typeof context>>;
    const advance = (c: Context, lost = () => false) =>
      worker.advance(c.job, c.session, settings, c.token, lost);
    async function current(c: Context) {
      return (
        await pool.query(
          "SELECT * FROM prepaid_source_extractions WHERE preparation_id=$1 AND status='waiting'",
          [c.job.id],
        )
      ).rows[0];
    }
    async function complete(c: Context, failure = false) {
      const row = await current(c);
      const execution = executions.get(row.execution_arn);
      execution.status = failure ? "FAILED" : "SUCCEEDED";
      const jobs = sourceWorkflows[row.workflow as SourceWorkflow].jobs;
      execution.output = JSON.stringify({
        JobRunState: "SUCCEEDED",
        Id: "jr_test",
        JobName: `isg-esatp-dv-prep_reclass-gljo-extract_${jobs[jobs.length - 1]}`,
      });
      return row;
    }
    async function allReceipts(c: Context) {
      const config = { ...settings, coverage: "all_sources" as const };
      expect(
        await worker.advance(c.job, c.session, config, c.token, () => false),
      ).toBeUndefined();
      let receipts;
      for (let i = 0; i < 10; i++) {
        const row = await complete(c);
        expect(row.workflow).toBe(Object.keys(sourceWorkflows)[i]);
        receipts = await worker.advance(
          c.job,
          c.session,
          config,
          c.token,
          () => false,
        );
      }
      expect(receipts).toHaveLength(10);
      expect(start).toHaveBeenCalledTimes(10);
      expect(normalizer.normalize).toHaveBeenCalledTimes(
        c.job.source_files.length,
      );
      return receipts!;
    }
    const parallelSettings = {
      ...settings,
      coverage: "all_sources" as const,
      parallelism: 3,
    };
    const advanceParallel = (c: Context) =>
      worker.advance(c.job, c.session, parallelSettings, c.token, () => false);
    async function finishWave(c: Context, failed?: string) {
      const rows = (
        await pool.query(
          "SELECT * FROM prepaid_source_extractions WHERE preparation_id=$1 AND status='waiting'",
          [c.job.id],
        )
      ).rows;
      for (const row of rows) {
        const execution = executions.get(row.execution_arn),
          mapping = sourceWorkflows[row.workflow as SourceWorkflow];
        execution.status = row.workflow === failed ? "FAILED" : "SUCCEEDED";
        execution.output = JSON.stringify({
          JobRunState: "SUCCEEDED",
          Id: `jr_${row.workflow}`,
          JobName: `isg-esatp-dv-prep_reclass-gljo-extract_${mapping.jobs.at(-1)}`,
        });
      }
      return rows;
    }
    it("runs ten disjoint native workflows in waves of at most three under one preparation lock", async () => {
      const c = await context(true);
      let receipts;
      for (const expected of [3, 6, 9, 10]) {
        expect(await advanceParallel(c)).toBeUndefined();
        expect(start.mock.calls.length).toBe(expected);
        expect(
          JSON.parse(s3.objects.get(landing.lockKey)!.bytes.toString()).owner,
        ).toBe(c.job.id);
        const running = (
          await pool.query(
            "SELECT * FROM prepaid_source_extractions WHERE preparation_id=$1 AND status='waiting'",
            [c.job.id],
          )
        ).rows;
        expect(running.length).toBeLessThanOrEqual(3);
        expect(await advanceParallel(c)).toBeUndefined();
        expect(start.mock.calls.length).toBe(expected);
        await finishWave(c);
        receipts = await advanceParallel(c);
      }
      expect(receipts).toHaveLength(10);
      expect(s3.objects.has(landing.lockKey)).toBe(false);
      expect(normalizer.normalize).toHaveBeenCalledTimes(
        c.job.source_files.length,
      );
      expect(
        [...executions.values()].every(
          (execution) => Object.keys(execution.input).join() === "env_prefix",
        ),
      ).toBe(true);
    });
    it("does not clean a parallel wave or dispatch successors while a peer is still running", async () => {
      const c = await context(true);
      await advanceParallel(c);
      const rows = await finishWave(c);
      executions.get(rows[2].execution_arn).status = "RUNNING";
      await advanceParallel(c);
      expect(start).toHaveBeenCalledTimes(3);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM prepaid_source_extractions WHERE preparation_id=$1 AND context->>'cleaned'='true'",
            [c.job.id],
          )
        ).rows[0].n,
      ).toBe(0);
      expect(s3.objects.has(landing.lockKey)).toBe(true);
    });
    it("drains all started peers after one fails, releases only owned inputs, and never starts later waves", async () => {
      const c = await context(true);
      await advanceParallel(c);
      const rows = await finishWave(c, "callcard_eg");
      executions.get(
        rows.find((row) => row.workflow === "ke24").execution_arn,
      ).status = "RUNNING";
      expect(await advanceParallel(c)).toBeUndefined();
      expect(s3.objects.has(landing.lockKey)).toBe(true);
      await finishWave(c, "callcard_eg");
      await expect(advanceParallel(c)).rejects.toThrow(
        "Source workflow failed",
      );
      expect(start).toHaveBeenCalledTimes(3);
      expect(s3.objects.has(landing.lockKey)).toBe(false);
      const states = (
        await pool.query(
          "SELECT status,count(*)::int n FROM prepaid_source_extractions WHERE preparation_id=$1 GROUP BY status",
          [c.job.id],
        )
      ).rows;
      expect(states).toEqual(
        expect.arrayContaining([
          { status: "completed", n: 2 },
          { status: "failed", n: 1 },
          { status: "queued", n: 7 },
        ]),
      );
    });
    it("recovers a lost parallel start response with the same named execution and excludes another preparation", async () => {
      const c = await context(true);
      loseNextStart = true;
      await expect(advanceParallel(c)).rejects.toThrow("Lost AWS response");
      expect(s3.objects.has(landing.lockKey)).toBe(true);
      expect(await advanceParallel(c)).toBeUndefined();
      expect(executions.size).toBe(3);
      expect(start.mock.calls[1]).toEqual(start.mock.calls[0]);
      const other = await context(true);
      await expect(advanceParallel(other)).rejects.toThrow(
        "Another extraction owns",
      );
      expect(
        JSON.parse(s3.objects.get(landing.lockKey)!.bytes.toString()).owner,
      ).toBe(c.job.id);
      expect(executions.size).toBe(3);
    });
    it("fails before dispatch if parallel shared-library isolation cannot be verified", async () => {
      const c = await context(true);
      inspector.verifyIsolation.mockRejectedValueOnce(
        Error("Shared implementation changed"),
      );
      await expect(advanceParallel(c)).rejects.toThrow(
        "implementation changed",
      );
      expect(start).not.toHaveBeenCalled();
      expect(s3.objects.has(landing.lockKey)).toBe(false);
    });
    it("retains the preparation lock after a lost staging response and completes the same owned copies on retry", async () => {
      const c = await context(true),
        original = landing.stage.bind(landing);
      const stage = vi
        .spyOn(landing, "stage")
        .mockImplementationOnce(async (...args) => {
          await original(...args);
          throw Error("Lost staging response");
        });
      try {
        await expect(advanceParallel(c)).rejects.toThrow(
          "Lost staging response",
        );
        expect(s3.objects.has(landing.lockKey)).toBe(true);
        expect(start).not.toHaveBeenCalled();
        const row = (
          await pool.query(
            "SELECT context FROM prepaid_source_extractions WHERE preparation_id=$1 AND workflow='ke24'",
            [c.job.id],
          )
        ).rows[0];
        expect(row.context.stagingStarted).toBe(true);
        expect(row.context.staged).toBe(false);
        await advanceParallel(c);
        expect(start).toHaveBeenCalledTimes(3);
        expect(executions.size).toBe(3);
        expect(
          JSON.parse(s3.objects.get(landing.lockKey)!.bytes.toString()).owner,
        ).toBe(c.job.id);
      } finally {
        stage.mockRestore();
      }
    });
    async function nativeConfiguration(c: Context, independent = false) {
      const bytes = Buffer.from(
        JSON.stringify({
          MANDT: "300",
          BUKRS: "GLOB",
          HKONT: "123",
          BRAND: "GHP-PREPAID",
          WWBRD: "GP",
          WWSPA: "CM",
          WWST: "MT",
          SPB: "SUB",
          TAXRATE: "0.12",
          AVERATE: "10",
          DUOM: "EA",
        }) + "\n",
      );
      const key = "trusted-reference/export.jsonl";
      s3.set(key, bytes);
      const configuration = manualIntegrationSchema.parse({
        preparationMode: "native_sources",
        sourceExtraction: { ...settings, coverage: "all_sources" },
        expectedCycles: ["01", "06"],
        ...(independent
          ? { reportCycles: { adjustments: ["01"], charges: ["06"] } }
          : {}),
        format: {
          profile: "isolated-test",
          approved: true,
          delimiter: "\t",
          lineEnding: "\r\n",
          encoding: "utf8",
        },
        referenceExport: {
          key,
          prefix: "trusted-reference/",
          sha256: sha256(bytes),
          rowCount: 1,
          approved: true,
        },
      });
      await pool.query(
        "UPDATE prepaid_upload_sessions SET configuration=$2 WHERE id=$1",
        [c.session.id, JSON.stringify(configuration)],
      );
      c.session.configuration = configuration;
      return configuration;
    }
    async function parent(c: Context, failManifestWrite = false) {
      let fail = failManifestWrite;
      const wrapped = new PrepaidStorage(
        {
          send: async (command: any) => {
            const result = await s3.send(command);
            if (
              fail &&
              command.constructor.name === "PutObjectCommand" &&
              command.input.Key.endsWith("native-manifest.json")
            ) {
              fail = false;
              throw Object.assign(Error("Lost manifest write response"), {
                code: "ECONNRESET",
              });
            }
            return result;
          },
        } as any,
        "test-bucket",
      );
      const preparation = new PrepaidPreparationWorker(
        repo,
        wrapped,
        runner,
        logger,
      );
      // Inject the same dependency boundary used by the child integration suite.
      (preparation as any).sourceWorker = worker;
      await pool.query(
        "UPDATE prepaid_preparation_jobs SET available_at=now()+interval '1 day' WHERE id<>$1",
        [c.job.id],
      );
      await pool.query(
        "UPDATE prepaid_preparation_jobs SET lease_until=NULL,available_at=now() WHERE id=$1",
        [c.job.id],
      );
      return preparation;
    }
    it("publishes both layouts through the real parent worker after four parallel waves", async () => {
      const c = await context(true);
      const queuedAt = new Date(Date.now() - 2_225_000);
      await pool.query(
        "UPDATE prepaid_preparation_jobs SET created_at=$2 WHERE id=$1",
        [c.job.id, queuedAt],
      );
      c.job.created_at = queuedAt;
      const configuration = await nativeConfiguration(c);
      configuration.sourceExtraction!.parallelism = 3;
      await pool.query(
        "UPDATE prepaid_upload_sessions SET configuration=$2 WHERE id=$1",
        [c.session.id, JSON.stringify(configuration)],
      );
      let preparation = await parent(c);
      for (let wave = 0; wave < 4; wave++) {
        // A recreated worker must retain the durable total rather than starting
        // its timer again when it restores the same in-flight preparation.
        if (wave === 2) preparation = await parent(c);
        await pool.query(
          "UPDATE prepaid_preparation_jobs SET available_at=now() WHERE id=$1",
          [c.job.id],
        );
        await preparation.tick();
        await finishWave(c);
        await pool.query(
          "UPDATE prepaid_preparation_jobs SET available_at=now() WHERE id=$1",
          [c.job.id],
        );
        await preparation.tick();
      }
      expect(
        (
          await pool.query(
            "SELECT status FROM prepaid_upload_sessions WHERE id=$1",
            [c.session.id],
          )
        ).rows[0].status,
      ).toBe("ready");
      expect(
        (
          await pool.query(
            "SELECT status FROM prepaid_preparation_jobs WHERE id=$1",
            [c.job.id],
          )
        ).rows[0].status,
      ).toBe("completed");
      expect(start).toHaveBeenCalledTimes(10);
      expect(s3.objects.has(landing.lockKey)).toBe(false);
      const timed = logger.info.mock.calls
        .filter(
          ([event, fields]) =>
            [
              "prepaid.extraction.progress",
              "prepaid.extraction.completed",
              "prepaid.preparation.completed",
            ].includes(event) && fields.jobId === c.job.id,
        )
        .map(([, fields]) => fields);
      expect(timed.length).toBeGreaterThan(2);
      for (const fields of timed) {
        expect(fields.preparationQueuedAt).toBe(queuedAt.toISOString());
        expect(fields.totalElapsedMs).toBeGreaterThanOrEqual(2_225_000);
        expect(fields.totalElapsedMs).toBeGreaterThan(
          fields.tickElapsedMs + 2_000_000,
        );
        expect(fields.totalElapsed).toMatch(/^\d{2,}:\d{2}:\d{2}$/);
      }
      expect(logger.info).toHaveBeenCalledWith(
        "prepaid.extraction.completed",
        expect.objectContaining({
          jobId: c.job.id,
          workflowCount: 10,
          totalElapsedMs: expect.any(Number),
        }),
      );
      expect(logger.info).toHaveBeenCalledWith(
        "prepaid.preparation.completed",
        expect.objectContaining({
          jobId: c.job.id,
          totalElapsedMs: expect.any(Number),
          totalElapsed: expect.any(String),
        }),
      );
    });
    it("keeps the parent retryable until failed-wave peers and Glue cancellation are fully drained", async () => {
      const c = await context(true);
      const configuration = await nativeConfiguration(c);
      configuration.sourceExtraction!.parallelism = 3;
      await pool.query(
        "UPDATE prepaid_upload_sessions SET configuration=$2 WHERE id=$1",
        [c.session.id, JSON.stringify(configuration)],
      );
      const preparation = await parent(c);
      const tick = async () => {
        await pool.query(
          "UPDATE prepaid_preparation_jobs SET available_at=now() WHERE id=$1",
          [c.job.id],
        );
        await preparation.tick();
        return (
          await pool.query(
            "SELECT status FROM prepaid_preparation_jobs WHERE id=$1",
            [c.job.id],
          )
        ).rows[0].status;
      };
      await tick();
      const rows = await finishWave(c, "callcard_eg");
      executions.get(
        rows.find((row) => row.workflow === "ke24").execution_arn,
      ).status = "RUNNING";
      expect(await tick()).toBe("waiting");
      expect(s3.objects.has(landing.lockKey)).toBe(true);
      await finishWave(c, "callcard_eg");
      inspector.idle.mockRejectedValueOnce(Error("Glue is still stopping"));
      expect(await tick()).toBe("waiting");
      expect(s3.objects.has(landing.lockKey)).toBe(true);
      expect(await tick()).toBe("failed");
      expect(s3.objects.has(landing.lockKey)).toBe(false);
      expect(start).toHaveBeenCalledTimes(3);
    });
    it("publishes both layouts with explicitly independent 308 and 318 cycles", async () => {
      const c = await context(true, true);
      await nativeConfiguration(c, true);
      await allReceipts(c);
      expect(await (await parent(c)).tick()).toBe(true);
      const session = (
        await pool.query("SELECT * FROM prepaid_upload_sessions WHERE id=$1", [
          c.session.id,
        ])
      ).rows[0];
      expect(session.error).toBeNull();
      expect(session.status).toBe("ready");
      const snapshot = (
        await pool.query(
          "SELECT manifest FROM prepaid_source_snapshots WHERE run_id=$1",
          [session.run_id],
        )
      ).rows[0];
      expect(snapshot.manifest.coverage).toEqual([
        { cycle: "01", adjustments: true, charges: false },
        { cycle: "06", adjustments: false, charges: true },
      ]);
      expect(snapshot.manifest.sourceFiles).toHaveLength(10);
      expect(start).toHaveBeenCalledTimes(10);
    });
    it("does not publish when a configured report is missing from native receipts", async () => {
      const c = await context(true, true);
      // Default paired configuration still requires the absent 318_01 and 308_06.
      await nativeConfiguration(c);
      await allReceipts(c);
      await (await parent(c)).tick();
      const session = (
        await pool.query("SELECT * FROM prepaid_upload_sessions WHERE id=$1", [
          c.session.id,
        ])
      ).rows[0];
      expect(session.status).not.toBe("ready");
      expect(session.run_id).toBeNull();
      expect(session.error).toContain("missing a 308/318 cycle header");
      expect(logger.error).toHaveBeenCalledWith(
        "prepaid.preparation.failed",
        expect.objectContaining({
          jobId: c.job.id,
          totalElapsedMs: expect.any(Number),
          totalElapsed: expect.stringMatching(/^\d{2,}:\d{2}:\d{2}$/),
          tickElapsedMs: expect.any(Number),
        }),
      );
    });
    it("reuses pre-existing unmanaged inputs across all ten workflows without rewriting or removing them", async () => {
      const c = await context(true);
      await nativeConfiguration(c);
      const keys: string[] = [];
      s3.send.mockClear();
      for (const workflow of Object.keys(sourceWorkflows) as SourceWorkflow[])
        for (const source of c.job.source_files.filter((f: any) =>
          sourceBelongsTo(workflow, f.source_code),
        )) {
          let name = sourceLandingName(workflow, source.source_code);
          if (workflow === "adjustments_308" || workflow === "charges_318")
            name = name.replace(/\.xlsx$/, ".XLSX");
          const key = landing.prefix + name;
          s3.set(key, s3.objects.get(source.object_key)!.bytes);
          keys.push(key);
        }
      await allReceipts(c);
      for (const key of keys)
        expect(s3.objects.get(key)?.metadata).toBeUndefined();
      expect(keys.every((key) => s3.objects.has(key))).toBe(true);
      expect(
        s3.send.mock.calls.filter(
          ([command]: any) =>
            command.constructor.name === "PutObjectCommand" &&
            command.input.Key.startsWith(landing.prefix),
        ),
      ).toHaveLength(0);
      expect(logger.info).toHaveBeenCalledWith(
        "prepaid.extraction.progress",
        expect.objectContaining({
          stage: "step_function_started",
          jobId: c.job.id,
          sessionId: c.session.id,
          workflow: "ke24",
          executionArn: expect.any(String),
        }),
      );
      await (await parent(c)).tick();
      expect(
        (
          await pool.query(
            "SELECT status FROM prepaid_upload_sessions WHERE id=$1",
            [c.session.id],
          )
        ).rows[0].status,
      ).toBe("ready");
    });
    it("attaches file, workflow and staging context when an unmanaged input differs", async () => {
      const c = await context(true);
      const key = landing.prefix + "KE24.xlsx";
      s3.set(key, Buffer.from("different input"));
      await expect(
        worker.advance(
          c.job,
          c.session,
          { ...settings, coverage: "all_sources" },
          c.token,
          () => false,
        ),
      ).rejects.toMatchObject({
        prepaidContext: {
          jobId: c.job.id,
          workflow: "ke24",
          stage: "stage_shared_inputs",
          key,
          reason: "source_bytes_conflict",
        },
      });
      expect(start).not.toHaveBeenCalled();
      await pool.query(
        "UPDATE prepaid_preparation_jobs SET status='failed' WHERE id=$1",
        [c.job.id],
      );
    });
    it("preflights later source files before dispatching even a valid KE24", async () => {
      const c = await context(true);
      const original = normalizer.normalize.getMockImplementation()!;
      normalizer.normalize.mockImplementation(async (workflow, code) => {
        if (workflow === "load_up_eg") throw Error("Wrong Load Up EG template");
        return original(workflow, code);
      });
      try {
        await expect(
          worker.advance(
            c.job,
            c.session,
            { ...settings, coverage: "all_sources" },
            c.token,
            () => false,
          ),
        ).rejects.toMatchObject({
          message: "Wrong Load Up EG template",
          prepaidContext: {
            workflow: "load_up_eg",
            stage: "normalize_sources",
          },
        });
        expect(start).not.toHaveBeenCalled();
        expect(s3.objects.has(landing.lockKey)).toBe(false);
      } finally {
        normalizer.normalize.mockImplementation(original);
        await pool.query(
          "UPDATE prepaid_preparation_jobs SET status='failed' WHERE id=$1",
          [c.job.id],
        );
      }
    });
    it("adapts original EG reports for unchanged native readers and attests both original and native hashes", async () => {
      const c = await context(true);
      const config = await nativeConfiguration(c);
      const mapping = {
        profile: "provided-eg-reports-v1" as const,
        approved: true as const,
        callcardScope: "eg_report" as const,
        loadupAmount: "gross" as const,
      };
      config.sourceExtraction!.egReportMapping = mapping;
      await pool.query(
        "UPDATE prepaid_upload_sessions SET configuration=$2 WHERE id=$1",
        [c.session.id, JSON.stringify(config)],
      );
      c.session.configuration = config;
      const actual = new BackendSourceNormalizer();
      const adaptedNormalizer: SourceNormalizer = {
        revision: normalizer.revision,
        normalizeRaw: normalizer.normalizeRaw,
        normalize: (workflow, code, bytes, period, policy) =>
          ["callcard_eg", "load_up_eg"].includes(workflow)
            ? actual.normalize(workflow, code, bytes, period, policy)
            : normalizer.normalize(workflow, code),
        prepare: async (workflow, code, bytes, period, policy) =>
          ["callcard_eg", "load_up_eg"].includes(workflow)
            ? actual.prepare(workflow, code, bytes, period, policy)
            : { datasets: await normalizer.normalize(workflow, code) },
      };
      const child = new PrepaidSourceExtractionWorker(
        repo,
        storage,
        runner,
        {
          normalizer: adaptedNormalizer,
          inspector,
          landing,
          rawReader: fixtureReader(async (workflow, code) => {
            if (!["callcard_eg", "load_up_eg"].includes(workflow))
              return normalizer.normalize.getMockImplementation()!(
                workflow,
                code,
              );
            const source = c.job.source_files.find(
              (f: any) => f.source_code === code,
            );
            return actual.normalize(
              workflow,
              code,
              s3.objects.get(source.object_key)!.bytes,
              "2026-09",
              mapping,
            );
          }),
        },
        logger,
      );
      for (const workflow of ["callcard_eg", "load_up_eg"] as const) {
        const book = new ExcelJS.Workbook();
        book.addWorksheet("Source").addRows(
          workflow === "callcard_eg"
            ? [
                ["Company Code", "SO Number", "Customer", "Gross Amount"],
                ["GLOB", "SO1", "TEST", "1.50"],
                ["GLOB", "SO2", "TEST", "1.50"],
              ]
            : [
                ["summary"],
                [],
                [],
                [],
                ["CFU", "Transaction ID", "GROSS", "NET TOP UP"],
                ["EG", "TX1", "112.00", "100.00"],
              ],
        );
        const bytes = Buffer.from(await book.xlsx.writeBuffer());
        const file = c.job.source_files.find(
          (f: any) => f.source_code === workflow,
        );
        file.sha256 = sha256(bytes);
        file.size_bytes = bytes.length;
        s3.set(file.object_key, bytes);
        s3.set(landing.prefix + sourceLandingName(workflow, workflow), bytes);
      }
      await pool.query(
        "UPDATE prepaid_preparation_jobs SET source_files=$2 WHERE id=$1",
        [c.job.id, JSON.stringify(c.job.source_files)],
      );
      const settingsWithMapping = {
        ...settings,
        coverage: "all_sources" as const,
        egReportMapping: mapping,
      };
      let receipts = await child.advance(
        c.job,
        c.session,
        settingsWithMapping,
        c.token,
        () => false,
      );
      for (let i = 0; i < 10; i++) {
        await complete(c);
        receipts = await child.advance(
          c.job,
          c.session,
          settingsWithMapping,
          c.token,
          () => false,
        );
      }
      expect(receipts).toHaveLength(10);
      expect(start).toHaveBeenCalledTimes(10);
      for (const workflow of ["callcard_eg", "load_up_eg"]) {
        const row = (
          await pool.query(
            "SELECT receipt FROM prepaid_source_extractions WHERE preparation_id=$1 AND workflow=$2",
            [c.job.id, workflow],
          )
        ).rows[0].receipt;
        expect(row.egReportMapping).toEqual(mapping);
        expect(row.nativeInputs).toHaveLength(1);
        expect(row.nativeInputs[0].sha256).not.toBe(row.sources[0].sha256);
        expect(s3.objects.has(row.sources[0].key)).toBe(true);
        expect(s3.objects.get(row.nativeInputs[0].key)?.bytes.length).toBe(
          row.nativeInputs[0].size,
        );
        expect(
          [...s3.objects.keys()].some(
            (key) =>
              key.includes("input-backups/") &&
              key.endsWith(
                sourceLandingName(workflow as SourceWorkflow, workflow),
              ),
          ),
        ).toBe(true);
      }
      await (await parent(c)).tick();
      const session = (
        await pool.query(
          "SELECT status,error FROM prepaid_upload_sessions WHERE id=$1",
          [c.session.id],
        )
      ).rows[0];
      expect(session.error).toBeNull();
      expect(session.status).toBe("ready");
    }, 30000);
    it("publishes native layouts from PostgreSQL references without reading or writing any reference S3 object", async () => {
      const c = await context(true);
      const old = await nativeConfiguration(c);
      const original = JSON.parse(
        s3.objects.get(old.referenceExport!.key)!.bytes.toString(),
      );
      const source = Object.fromEntries(
        legacyReferenceFields.map((field) => [
          field,
          original[field] ?? (field === "PSTKY" ? "50" : ""),
        ]),
      );
      const bytes = Buffer.from(JSON.stringify(source) + "\n");
      const catalog = new PrepaidReferenceCatalog(repo);
      const descriptor = await catalog.import(c.owner, bytes, {
        sha256: sha256(bytes),
        rowCount: 1,
        approved: true,
        approvalScope: "development-testing",
        period: "2026-09",
        label: "Isolated reference",
        provenance: { fixture: true },
      });
      const configuration = manualIntegrationSchema.parse({
        ...old,
        referenceExport: undefined,
        referenceVersion: descriptor,
      });
      s3.objects.delete(old.referenceExport!.key);
      await pool.query(
        "UPDATE prepaid_upload_sessions SET configuration=$2 WHERE id=$1",
        [c.session.id, JSON.stringify(configuration)],
      );
      c.session.configuration = configuration;
      await allReceipts(c);
      const callsBefore = s3.send.mock.calls.length;
      const preparation = await parent(c);
      await preparation.tick();
      const session = (
        await pool.query("SELECT * FROM prepaid_upload_sessions WHERE id=$1", [
          c.session.id,
        ])
      ).rows[0];
      expect(session.error).toBeNull();
      expect(session.status).toBe("ready");
      const snapshot = (
        await pool.query(
          "SELECT * FROM prepaid_source_snapshots WHERE run_id=$1",
          [session.run_id],
        )
      ).rows[0];
      expect(snapshot.manifest.referenceVersion).toEqual(descriptor);
      expect(snapshot.manifest.referenceSource).toBeUndefined();
      expect(
        snapshot.manifest.datasets.some((d: any) => d.name === "reference"),
      ).toBe(false);
      expect(
        (
          await pool.query(
            "SELECT data FROM prepaid_stage_reference WHERE snapshot_id=$1",
            [snapshot.id],
          )
        ).rows[0].data,
      ).toMatchObject({ average_rate: "10", cost_element: "0000000123" });
      expect(
        s3.send.mock.calls
          .slice(callsBefore)
          .some(([command]: any) => /reference/i.test(command.input.Key ?? "")),
      ).toBe(false);
      expect(await catalog.export(c.owner, descriptor.sha256)).toEqual(bytes);
      await expect(
        pool.query("DELETE FROM prepaid_reference_versions WHERE sha256=$1", [
          descriptor.sha256,
        ]),
      ).rejects.toThrow("IMMUTABLE");
      await expect(
        pool.query(
          "UPDATE prepaid_reference_version_rows SET data='{}' WHERE version_sha256=$1",
          [descriptor.sha256],
        ),
      ).rejects.toThrow("IMMUTABLE");
      expect(
        await catalog.import(c.owner, bytes, {
          sha256: sha256(bytes),
          rowCount: 1,
          approved: true,
          approvalScope: "development-testing",
          period: "2026-09",
          label: "Retry",
          provenance: { retry: true },
        }),
      ).toEqual(descriptor);
    }, 30000);
    it("fails preparation before dispatch when its pinned PostgreSQL reference version is missing, without S3 fallback", async () => {
      const c = await context(true);
      const old = await nativeConfiguration(c);
      const configuration = {
        ...old,
        referenceExport: undefined,
        referenceVersion: {
          sha256: "a".repeat(64),
          rowCount: 1,
          approved: true,
        },
      };
      await pool.query(
        "UPDATE prepaid_upload_sessions SET configuration=$2 WHERE id=$1",
        [c.session.id, JSON.stringify(configuration)],
      );
      c.session.configuration = configuration;
      await (await parent(c)).tick();
      expect(start).not.toHaveBeenCalled();
      const job = (
        await pool.query(
          "SELECT error FROM prepaid_preparation_jobs WHERE id=$1",
          [c.job.id],
        )
      ).rows[0];
      expect(job.error).toContain(
        "Import the exact approved reference version",
      );
    });
    it("runs all ten extractors, assembles a native manifest and publishes both layouts atomically without an extra AWS adapter", async () => {
      const c = await context(true);
      await nativeConfiguration(c);
      await allReceipts(c);
      const preparation = await parent(c);
      expect(await preparation.tick()).toBe(true);
      const session = (
        await pool.query("SELECT * FROM prepaid_upload_sessions WHERE id=$1", [
          c.session.id,
        ])
      ).rows[0];
      expect(session.error).toBeNull();
      expect(session.status).toBe("ready");
      const job = (
        await pool.query("SELECT * FROM prepaid_preparation_jobs WHERE id=$1", [
          c.job.id,
        ])
      ).rows[0];
      expect(job.status).toBe("completed");
      expect(job.execution_arn).toBeNull();
      const snapshot = (
        await pool.query(
          "SELECT * FROM prepaid_source_snapshots WHERE run_id=$1",
          [session.run_id],
        )
      ).rows[0];
      expect(snapshot.manifest).toMatchObject({
        producer: "backend",
        period: "2026-09",
        executionArn: `backend:preparation:${c.job.id}`,
      });
      expect(snapshot.manifest.datasets).toHaveLength(8);
      expect(snapshot.manifest.extractionReceipts).toHaveLength(10);
      expect(start).toHaveBeenCalledTimes(10);
      expect(
        start.mock.calls.every(
          ([, input]) =>
            JSON.stringify(input) ===
            JSON.stringify({ env_prefix: "isg-esatp-dv" }),
        ),
      ).toBe(true);
      const layout = (
        await pool.query(
          "SELECT l.* FROM prepaid_layout_rows l JOIN prepaid_region_revisions r ON r.id=l.revision_id WHERE r.run_id=$1 AND r.region='eg'",
          [session.run_id],
        )
      ).rows;
      expect(layout.find((r) => r.label === "CALLCARD").gp_mt_gross).toBe(
        "4.00",
      );
      expect(
        layout.find((r) => r.label === "RECHARGE INSTRUCTION (recharge report)")
          .hy_mt_gross,
      ).toBe("-10.00");
      expect(layout.find((r) => r.label === "AMAXCE").hy_mt_gross).toBe(
        "10.00",
      );
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM prepaid_deliveries d JOIN prepaid_region_revisions r ON r.id=d.revision_id WHERE r.run_id=$1",
            [session.run_id],
          )
        ).rows[0].n,
      ).toBe(0);
    });
    it("publishes Glue output amounts rather than the independently parsed upload amounts", async () => {
      const c = await context(true);
      await nativeConfiguration(c);
      const original = rawReader.capture;
      rawReader.capture = async (request) => {
        const capture = await original(request);
        if (request.workflow === "callcard_eg") {
          const row = capture.tables.dcmanualcallcard[0];
          const datasets = JSON.parse(row.__datasets);
          datasets.callcard.forEach((entry: any) => {
            entry.amount = "20.00";
          });
          row.__datasets = JSON.stringify(datasets);
        }
        return capture;
      };
      try {
        await allReceipts(c);
        await (await parent(c)).tick();
        const session = (
          await pool.query(
            "SELECT * FROM prepaid_upload_sessions WHERE id=$1",
            [c.session.id],
          )
        ).rows[0];
        expect(session.status).toBe("ready");
        const layout = (
          await pool.query(
            "SELECT l.* FROM prepaid_layout_rows l JOIN prepaid_region_revisions r ON r.id=l.revision_id WHERE r.run_id=$1 AND r.region='eg' AND l.label='CALLCARD'",
            [session.run_id],
          )
        ).rows[0];
        expect(layout.gp_mt_gross).toBe("40.00"); // original upload preflight was 4.00 after row rounding
        const rows = (
          await pool.query(
            "SELECT receipt FROM prepaid_source_extractions WHERE preparation_id=$1",
            [c.job.id],
          )
        ).rows;
        expect(
          rows.every(
            (row) =>
              row.receipt.financialSource === "glue_raw_v1" &&
              row.receipt.rawCapture,
          ),
        ).toBe(true);
      } finally {
        rawReader.capture = original;
      }
    });
    it("retains the input lock on a raw database outage and resumes without starting another extraction", async () => {
      const c = await context(true);
      const config = { ...settings, coverage: "all_sources" as const };
      await worker.advance(c.job, c.session, config, c.token, () => false);
      await complete(c);
      const original = rawReader.capture;
      rawReader.capture = async () => {
        throw Error("Raw database temporarily unavailable");
      };
      try {
        await expect(
          worker.advance(c.job, c.session, config, c.token, () => false),
        ).rejects.toThrow("temporarily unavailable");
        expect(s3.objects.has(landing.lockKey)).toBe(true);
        const row = await current(c);
        expect(row.context.cleaned).toBe(false);
        expect(row.status).toBe("waiting");
        expect(start).toHaveBeenCalledTimes(1);
      } finally {
        rawReader.capture = original;
      }
      await worker.advance(c.job, c.session, config, c.token, () => false);
      expect(start).toHaveBeenCalledTimes(2); // proceeds to the next workflow, not a repeated KE24 run
    });
    it("recovers an acknowledged-but-lost manifest write without restarting any extractor or duplicating a run", async () => {
      const c = await context(true);
      await nativeConfiguration(c);
      await allReceipts(c);
      const preparation = await parent(c, true);
      await preparation.tick();
      let job = (
        await pool.query("SELECT * FROM prepaid_preparation_jobs WHERE id=$1", [
          c.job.id,
        ])
      ).rows[0];
      expect(job.status).toBe("waiting");
      expect(job.error).toContain("Lost manifest");
      expect(
        (
          await pool.query(
            "SELECT status FROM prepaid_upload_sessions WHERE id=$1",
            [c.session.id],
          )
        ).rows[0].status,
      ).toBe("pending");
      await pool.query(
        "UPDATE prepaid_preparation_jobs SET available_at=now() WHERE id=$1",
        [c.job.id],
      );
      await preparation.tick();
      job = (
        await pool.query("SELECT * FROM prepaid_preparation_jobs WHERE id=$1", [
          c.job.id,
        ])
      ).rows[0];
      expect(job.error).toBeNull();
      expect(job.status).toBe("completed");
      expect(start).toHaveBeenCalledTimes(10);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM prepaid_runs WHERE workspace_id=$1",
            [c.session.workspace_id],
          )
        ).rows[0].n,
      ).toBe(1);
    });
    it("fails closed on a changed approved reference without publishing a ready run", async () => {
      const c = await context(true);
      await nativeConfiguration(c);
      await allReceipts(c);
      s3.set("trusted-reference/export.jsonl", Buffer.from("{}\n"));
      await (await parent(c)).tick();
      const job = (
        await pool.query("SELECT * FROM prepaid_preparation_jobs WHERE id=$1", [
          c.job.id,
        ])
      ).rows[0];
      expect(job.status).toBe("failed");
      expect(job.error).toContain("Reference source checksum");
      expect(
        (
          await pool.query(
            "SELECT status FROM prepaid_upload_sessions WHERE id=$1",
            [c.session.id],
          )
        ).rows[0].status,
      ).toBe("failed");
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM prepaid_runs WHERE workspace_id=$1",
            [c.session.workspace_id],
          )
        ).rows[0].n,
      ).toBe(0);
    });
    it("starts four native children sequentially and creates backend receipts from verified originals", async () => {
      const c = await context();
      expect(await advance(c)).toBeUndefined();
      expect(start).toHaveBeenCalledTimes(1);
      expect(start.mock.calls[0][1]).toEqual({ env_prefix: "isg-esatp-dv" });
      let receipts;
      for (let i = 0; i < 4; i++) {
        await complete(c);
        receipts = await advance(c);
        if (i < 3) expect(receipts).toBeUndefined();
      }
      expect(receipts).toHaveLength(4);
      expect(start).toHaveBeenCalledTimes(4);
      expect(await advance(c)).toEqual(receipts);
      expect(normalizer.normalize).toHaveBeenCalledTimes(5);
      expect(
        [...s3.objects.keys()].filter((k) => k.startsWith(landing.prefix)),
      ).toEqual([]);
      expect(s3.objects.has(landing.lockKey)).toBe(false);
      for (const f of c.job.source_files)
        expect(sha256(s3.objects.get(f.object_key)!.bytes)).toBe(f.sha256);
      const rows = (
        await pool.query(
          "SELECT execution_input,receipt,context FROM prepaid_source_extractions WHERE preparation_id=$1",
          [c.job.id],
        )
      ).rows;
      expect(
        rows.every(
          (r) =>
            r.receipt.producer === "backend" &&
            !r.execution_input.portalExtraction &&
            r.context.cleaned,
        ),
      ).toBe(true);
      await expect(
        verifiedExtractionBridge(
          storage,
          receipts!,
          "2026-08",
          storage.sessionPrefix(c.session.id),
        ),
      ).rejects.toThrow("Call Card period");
      expect(
        await verifiedExtractionBridge(
          storage,
          receipts!,
          "2026-09",
          storage.sessionPrefix(c.session.id),
        ),
      ).toBeDefined();
    });
    it("rejects incompatible AWS definitions without creating shared files or starting AWS", async () => {
      const c = await context();
      invalidDefinition = true;
      await expect(advance(c)).rejects.toThrow("missing state");
      expect(start).not.toHaveBeenCalled();
      expect(s3.objects.has(landing.lockKey)).toBe(false);
    });
    it("recovers a lost start response without recopying already consumed shared inputs", async () => {
      const c = await context();
      loseNextStart = true;
      await expect(advance(c)).rejects.toThrow("Lost AWS response");
      const first = start.mock.calls[0];
      // Simulate Glue moving its disposable input after starting.
      s3.objects.delete(landing.prefix + "CALLCARD_SG.xlsx");
      expect(await advance(c)).toBeUndefined();
      expect(start.mock.calls[1]).toEqual(first);
      expect(s3.objects.has(landing.prefix + "CALLCARD_SG.xlsx")).toBe(false);
      expect(executions.size).toBe(1);
    });
    it("detects tampered originals before dispatch", async () => {
      const c = await context();
      s3.set(c.job.source_files[0].object_key, Buffer.from("changed"));
      await expect(advance(c)).rejects.toThrow("checksum");
      expect(start).not.toHaveBeenCalled();
    });
    it("releases the serial landing lock when the pre-dispatch idle check fails", async () => {
      const c = await context();
      inspector.idle.mockImplementationOnce(async () => {
        expect(s3.objects.has(landing.lockKey)).toBe(true);
        throw new Error("Shared Glue job unavailable");
      });
      await expect(advance(c)).rejects.toThrow("Shared Glue job unavailable");
      expect(start).not.toHaveBeenCalled();
      expect(s3.objects.has(landing.lockKey)).toBe(false);
    });
    it("rejects a changed immutable normalized artifact after successful native Glue execution", async () => {
      const c = await context();
      await advance(c);
      const row = await complete(c);
      s3.set(row.context.artifacts[0].key, Buffer.from("{}\n"));
      await expect(advance(c)).rejects.toThrow();
      expect(
        (
          await pool.query(
            "SELECT status FROM prepaid_source_extractions WHERE id=$1",
            [row.id],
          )
        ).rows[0].status,
      ).toBe("failed");
      expect(s3.objects.has(landing.lockKey)).toBe(false);
    });
    it("rejects success metadata for the wrong Glue job rather than fabricating a portal receipt", async () => {
      const c = await context();
      await advance(c);
      const row = await complete(c);
      executions.get(row.execution_arn).output = JSON.stringify({
        JobRunState: "SUCCEEDED",
        Id: "jr_other",
        JobName: "wrong",
      });
      await expect(advance(c)).rejects.toThrow("native Glue success metadata");
      expect(
        (
          await pool.query(
            "SELECT receipt FROM prepaid_source_extractions WHERE id=$1",
            [row.id],
          )
        ).rows[0].receipt,
      ).toBeNull();
    });
    it("retains the lock for RUNNING/unknown outcomes and releases owned copies only after terminal failure", async () => {
      const c = await context();
      await advance(c);
      await advance(c);
      expect(s3.objects.has(landing.lockKey)).toBe(true);
      const row = await current(c);
      executions.get(row.execution_arn).status = "UNKNOWN";
      await expect(advance(c)).rejects.toThrow("Unknown");
      expect(s3.objects.has(landing.lockKey)).toBe(true);
      await complete(c, true);
      await expect(advance(c)).rejects.toThrow("Source workflow failed");
      expect(s3.objects.has(landing.lockKey)).toBe(false);
    });
    it("polls a running child with three DB reads and no full source/AWS contract rescan, then verifies drift before progressing", async () => {
      const c = await context(true);
      await worker.advance(
        c.job,
        c.session,
        { ...settings, coverage: "all_sources" },
        c.token,
        () => false,
      );
      const query = vi.spyOn(pool, "query"),
        describe = vi.spyOn(runner, "describeStateMachineDefinition"),
        normalizeCount = normalizer.normalize.mock.calls.length,
        verificationCount = inspector.verify.mock.calls.length,
        starts = start.mock.calls.length;
      try {
        expect(
          await worker.advance(
            c.job,
            c.session,
            { ...settings, coverage: "all_sources" },
            c.token,
            () => false,
          ),
        ).toBeUndefined();
        expect(query.mock.calls).toHaveLength(3); // lease, all contexts, final lease
        expect(describe).not.toHaveBeenCalled();
        expect(inspector.verify.mock.calls).toHaveLength(verificationCount);
        expect(normalizer.normalize.mock.calls).toHaveLength(normalizeCount);
        expect(start.mock.calls).toHaveLength(starts);
        expect(s3.objects.has(landing.lockKey)).toBe(true);
        await complete(c);
        invalidDefinition = true;
        await expect(
          worker.advance(
            c.job,
            c.session,
            { ...settings, coverage: "all_sources" },
            c.token,
            () => false,
          ),
        ).rejects.toThrow("missing state");
        expect(start.mock.calls).toHaveLength(starts);
        expect(s3.objects.has(landing.lockKey)).toBe(true);
      } finally {
        query.mockRestore();
        describe.mockRestore();
      }
    });
    it("does not let another portal preparation use the shared folder", async () => {
      const c = await context();
      await advance(c);
      const other = await context();
      await expect(advance(other)).rejects.toThrow("Another extraction owns");
      expect(start).toHaveBeenCalledTimes(1);
    });
    it("refuses dispatch after losing the preparation lease", async () => {
      const c = await context();
      await expect(advance(c, () => true)).rejects.toThrow("lease lost");
      expect(start).not.toHaveBeenCalled();
    });
    it("blocks a foreign matching shared input rather than overwriting or deleting it", async () => {
      const c = await context(),
        key = landing.prefix + "CALLCARD_SG.xlsx";
      s3.set(key, Buffer.from("other user's original"));
      await expect(advance(c)).rejects.toThrow(
        "differs from the uploaded file",
      );
      expect(start).not.toHaveBeenCalled();
      expect(s3.objects.get(key)!.bytes.toString()).toBe(
        "other user's original",
      );
    });
  },
);
