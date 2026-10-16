import { randomUUID } from "node:crypto";
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
import { verifiedExtractionBridge } from "../src/modules/prepaid/application/sourceExtractionBridge.js";
import {
  sourceWorkflows,
  type SourceWorkflow,
} from "../src/modules/prepaid/domain/sourceExtraction.js";
import type { StepFunctionsRunner } from "../src/stepFunctionsRunner.js";
import { fakeS3, legacyDefinition } from "./fixtures/prepaidSource.js";

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
  "Backend-owned four-workflow preparation (isolated DB, mocked AWS)",
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
      idle: vi.fn(async () => {}),
    };
    const normalizer = {
      revision: async () => "a".repeat(64),
      normalize: vi.fn(async (workflow: SourceWorkflow, code: string) =>
        workflow === "callcard_sg"
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
    const worker = new PrepaidSourceExtractionWorker(repo, storage, runner, {
      normalizer,
      inspector,
      landing,
    });
    beforeAll(async () => {
      await pool.query(
        `CREATE SCHEMA "${schema}"; CREATE TABLE app_user(id uuid PRIMARY KEY); CREATE TABLE workspaces(id uuid PRIMARY KEY,user_id uuid)`,
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
      normalizer.normalize.mockClear();
      invalidDefinition = false;
      loseNextStart = false;
    });
    afterAll(async () => {
      await pool.query(
        `DROP SCHEMA "${raw}" CASCADE; DROP SCHEMA "${schema}" CASCADE`,
      );
      await pool.end();
    });
    async function context() {
      const owner = randomUUID(),
        workspace = randomUUID(),
        sessionId = randomUUID(),
        id = randomUUID(),
        token = randomUUID();
      const files = [
        "callcard_sg",
        "load_api_eg",
        "load_api_sg",
        "308_01",
        "308_06",
      ].map((code) => {
        const source = randomUUID(),
          key = `prepaid_reclass/sessions/${sessionId}/sources/${source}/${code}.xlsx`,
          bytes = Buffer.from(code);
        s3.set(key, bytes);
        return {
          id: source,
          source_code: code,
          object_key: key,
          sha256: sha256(bytes),
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
      await expect(advance(c)).rejects.toThrow("not owned");
      expect(start).not.toHaveBeenCalled();
      expect(s3.objects.get(key)!.bytes.toString()).toBe(
        "other user's original",
      );
    });
  },
);
