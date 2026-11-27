import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it, vi, describe } from "vitest";
import { PrepaidWorkspaceService } from "../src/modules/prepaid/application/workspaceService.js";
import { PrepaidRunService } from "../src/modules/prepaid/application/runService.js";
import { PrepaidFullBatch } from "../src/modules/prepaid/application/fullBatch.js";
import { PrepaidRepository } from "../src/modules/prepaid/infrastructure/repository.js";
import { prepaidFullBatchMigrationSql } from "../src/modules/prepaid/infrastructure/fullBatchMigration.js";
import {
  sha256,
  type PrepaidStorage,
} from "../src/modules/prepaid/infrastructure/prepaidStorage.js";
import type { StepFunctionsRunner } from "../src/stepFunctionsRunner.js";
import { sourceCodes } from "../src/modules/prepaid/domain/contracts.js";
import { sourceWorkflows } from "../src/modules/prepaid/domain/sourceExtraction.js";
import { BackendSourceNormalizer } from "../src/modules/prepaid/infrastructure/sourceNormalizer.js";

const endpoint = process.env.PREPAID_TEST_DATABASE_URL;
if (endpoint) {
  const url = new URL(endpoint);
  if (
    url.hostname !== "127.0.0.1" ||
    url.port !== "55479" ||
    url.username !== "prepaid_test"
  )
    throw Error("Use the disposable Prepaid test database.");
}
describe.skipIf(!endpoint).each([
  ["isg-esatp-dv", "us-east-1"],
  ["isg-esatp-st", "ap-southeast-1"],
] as const)("Portal AWS batch lifecycle in %s", (envPrefix, region) => {
  const pool = new Pool({ connectionString: endpoint });
  const schema = "batch_" + randomUUID().replaceAll("-", "");
  const repo = new PrepaidRepository(pool, schema);
  const session = randomUUID();
  const user = randomUUID();
  const workspace = randomUUID();
  const mark = "2026-11-18T13:00:00Z";
  const content = Buffer.from("journal bytes\n");
  beforeAll(async () => {
    await pool.query(`CREATE SCHEMA ${schema};
      CREATE TABLE ${schema}.workspaces(id uuid PRIMARY KEY,user_id uuid);
      CREATE TABLE ${schema}.prepaid_workspace_selection(workspace_id uuid,run_id uuid);
      CREATE TABLE ${schema}.prepaid_integrations(id boolean,configuration jsonb);
      CREATE TABLE ${schema}.prepaid_upload_sessions(id uuid PRIMARY KEY,workspace_id uuid,active boolean,status text,configuration jsonb,version integer DEFAULT 0,error text,run_id uuid);
      CREATE TABLE ${schema}.prepaid_session_files(session_id uuid,active boolean DEFAULT true,source_code text,object_key text,sha256 text,id uuid,original_name text,size_bytes bigint,uploaded_by uuid);
      CREATE SCHEMA dswtdir1_prepaid_dbo;
      CREATE SCHEMA sdbtdir1_prepaid_dbo;
      CREATE TABLE sdbtdir1_prepaid_dbo.billed_adjustments_header_cycles (filename text, dateread timestamp, column1 text, column2 text);
      CREATE TABLE sdbtdir1_prepaid_dbo.billed_charges_header_cycles (LIKE sdbtdir1_prepaid_dbo.billed_adjustments_header_cycles);
      CREATE FUNCTION dswtdir1_prepaid_dbo.prepaid_import_source_enabled(text)
        RETURNS boolean LANGUAGE sql AS 'SELECT true';
      CREATE PROCEDURE dswtdir1_prepaid_dbo.sp_prepaid1_eglayout_compute_topup_pgx()
        LANGUAGE plpgsql AS 'BEGIN NULL; END';
      CREATE TABLE dswtdir1_prepaid_dbo.dcprepaidsystems("Layout Number" int,"REVENUES BEFORE RECLASS" text,total_gross text,total_net text,freezedata boolean);
      CREATE TABLE dswtdir1_prepaid_dbo.dcprepaidsystems_sg(LIKE dswtdir1_prepaid_dbo.dcprepaidsystems);
      INSERT INTO dswtdir1_prepaid_dbo.dcprepaidsystems VALUES(27,'Variance','0.00','0.00',false);
      INSERT INTO dswtdir1_prepaid_dbo.dcprepaidsystems_sg VALUES(27,'Variance',NULL,NULL,false);
      ALTER TABLE dswtdir1_prepaid_dbo.dcprepaidsystems ADD gp_eg_mt_gross text, ADD hy_eg_mt_gross text, ADD gp_eg_bb_gross text,
        ADD gp_eg_mt_net text, ADD hy_eg_mt_net text, ADD gp_eg_bb_net text;
      CREATE TABLE dswtdir1_prepaid_dbo.webprepaidsystems_formatc145 (
        revenuetype2 text, revenuetype text, allocationtype text, "Profit Center" text, "Cost Element" text,
        "Sub-Product Group B" text, "Unit of Measure" text, "Tax Rate" numeric, splitpercentage numeric, hits2 numeric, amount2 numeric,
        "Period/year" text, "Ave Rate" numeric, amount numeric, amount_sum_revenuetype numeric, allocation numeric, gross numeric, postingkey int);
      CREATE TABLE dswtdir1_prepaid_dbo.webprepaidsystems_formatc133
        (LIKE dswtdir1_prepaid_dbo.webprepaidsystems_formatc145);
      INSERT INTO dswtdir1_prepaid_dbo.webprepaidsystems_formatc133 (revenuetype2,revenuetype,"Tax Rate",gross,amount2,postingkey)
        VALUES ('EG','GP_EG_BB',.12,112,100,50);
      INSERT INTO dswtdir1_prepaid_dbo.webprepaidsystems_formatc145 (revenuetype2,revenuetype,allocationtype) VALUES
        ('EG','GP_EG_MT','GP_CM_MT'),('EG','GP_EG_BB','GP_CB_BB'),('SG','GP_SG_MT','GP_CM_MT');`);
    await pool.query(prepaidFullBatchMigrationSql(schema));
    await pool.query(readFileSync(new URL("../infrastructure/prepaid/020_batch_continuation.sql", import.meta.url), "utf8")
      .replace("web_portal.prepaid_full_batches", repo.table("full_batches"))
      .replace(/^ALTER .* OWNER TO esatp_adm;$/gm, ""));
    await pool.query(`INSERT INTO ${schema}.workspaces VALUES ($1,$2)`, [
      workspace,
      user,
    ]);
    await pool.query(
      `INSERT INTO ${repo.table("upload_sessions")} (id,workspace_id,active,status,configuration) VALUES ($1,$2,true,'collecting',$3)`,
      [
        session,
        workspace,
        JSON.stringify({
          expectedCycles: ["21"],
          reportCycles: { adjustments: ["21"], charges: ["21"] },
          preparationMode: "native_sources",
          format: {
            fileType: "xlsx",
            profile: "prepaid-manual-xlsx-v1",
            approved: true,
          },
          sourceExtraction: {
            envPrefix: "isg-esatp-dv",
            coverage: "all_sources",
            sharedWritesApproved: true,
          },
          referenceVersion: {
            sha256: "0".repeat(64),
            rowCount: 1,
            approved: true,
          },
        }),
      ],
    );
    for (const code of [
      ...sourceCodes.filter((code) => code !== "monthly_recharge"),
      "308_21",
      "318_27",
    ])
      await pool.query(
        `INSERT INTO ${repo.table("session_files")} (session_id,active,source_code,object_key,sha256) VALUES ($1,true,$2,$3,$4)`,
        [
          session,
          code,
          `prepaid_reclass/sessions/${session}/${code}`,
          sha256(content),
        ],
      );
  });
  afterAll(async () => {
    await pool.query(
      `DROP SCHEMA IF EXISTS ${schema} CASCADE; DROP SCHEMA IF EXISTS dswtdir1_prepaid_dbo CASCADE;
       DROP SCHEMA IF EXISTS sdbtdir1_prepaid_dbo CASCADE;`,
    );
    await pool.end();
  });
  it("owns the inputs through review and archives only the selected successful journal", async () => {
    const landing = {
      acquire: vi.fn(),
      owns: vi.fn(async () => true),
      stage: vi.fn(),
      assertOwner: vi.fn(),
      finish: vi.fn(),
      release: vi.fn(),
    };
    const workingCopy = Buffer.from("adapted workbook");
    const archive = vi.fn(async (key: string, _prefix?: string, body = content) => ({
      key,
      sha256: sha256(body),
      size: body.length,
    }));
    const storage = {
      legacyLanding: () => landing,
      bytes: async (key: string) => key.endsWith(".xlsx") ? workingCopy : content,
      sessionPrefix: (id: string) => `prepaid_reclass/sessions/${id}/`,
      deliveredJournalKey: async (prefix: string, name: string) => prefix + "20261118-1300/" + name,
      get: async (key: string) => {
        expect(key).toBe("prepaid_reclass/outbound/sftp-pushed/20261118-1300/txPrepaid_JV_EGSel.txt");
        return {
        LastModified: new Date(mark),
        ContentLength: content.length,
        Body: { transformToByteArray: async () => content },
        };
      },
      putVerified: archive,
    } as unknown as PrepaidStorage;
    const startExecution = vi.fn(async (machine: string) => ({
      executionArn: machine,
      startedAt: mark,
    }));
    let executionStatus = "SUCCEEDED";
    const runner = {
      describeStateMachineDefinition: async () => ({
        type: "STANDARD",
        status: "ACTIVE",
        definition: JSON.stringify({ States: {
          Extract_All: Object.keys(sourceWorkflows).map((key) => "$.extract_sources." + key),
          Import: { "--CODE.$": "$$.Execution.Name" },
        } }),
      }),
      describeStateMachine: async (machine: string) => ({
        name: machine,
        arn: `arn:aws:states:${region}:123456789012:stateMachine:${machine}`,
        type: "STANDARD",
        status: "ACTIVE",
      }),
      startExecution,
      describeExecution: async () => ({ status: executionStatus, completedAt: mark }),
    } as unknown as StepFunctionsRunner;
    const normalizer = new BackendSourceNormalizer();
    const prepare = vi.spyOn(normalizer, "prepare").mockResolvedValue({ datasets: {}, landing: workingCopy });
    const service = new PrepaidFullBatch(repo, storage, runner, envPrefix, true, normalizer);
    const workspaceApi = new PrepaidWorkspaceService(
      new PrepaidRunService(repo, storage),
      service,
    );
    expect(await service.status(user)).toBeNull();
    const source = {
      originalname: "DL_Monthly_Recharge_summary_report.csv",
      buffer: content,
      mimetype: "text/csv",
    };
    const uploadId = randomUUID();
    await workspaceApi.upload(user, "monthly_recharge", source, uploadId);
    const inputs = await workspaceApi.state(user);
    expect(inputs.sources.missing).toEqual([]);
    expect(inputs.error).toBeNull();
    expect(await service.status(user)).toBeNull();
    expect(await workspaceApi.resumeCollectingUploads()).toBe(false);
    await workspaceApi.prepare(user);
    const batch = await service.status(user);
    expect(batch?.status).toBe("queued");
    await workspaceApi.upload(user, "monthly_recharge", source, uploadId);
    expect(await service.status(user)).toEqual(batch);
    expect(await service.status(randomUUID())).toBeNull();
    await expect(service.downloadAmaxee(user, batch!.id)).rejects.toMatchObject({
      code: "PREPAID_AMAXEE_NOT_READY",
    });
    await service.tick();
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(landing.stage).not.toHaveBeenCalled();
    await service.tick();
    expect(landing.stage).toHaveBeenCalledTimes(10);
    expect(landing.stage).toHaveBeenCalledWith(batch!.id, "load_up_eg", [
      expect.objectContaining({ bytes: workingCopy, sha256: sha256(workingCopy) }),
    ]);
    expect(startExecution).not.toHaveBeenCalled();
    await service.tick();
    expect(startExecution).toHaveBeenCalledWith(
      `${envPrefix}-prcl_proc-sf`,
      {
        env_prefix: envPrefix, skip_extract: false,
        extract_sources: Object.fromEntries(Object.keys(sourceWorkflows).map((key) => [key, true])),
      },
      `portal-prepaid-${batch!.id}-import`,
    );
    const resetContext = {
      sessionId: inputs.session!.id,
      sessionVersion: inputs.session!.version,
    };
    await expect(workspaceApi.reset(user, resetContext)).rejects.toMatchObject({
      code: "PREPAID_BATCH_NOT_READY",
    });
    const poll = async () => {
      await pool.query(
        `UPDATE ${repo.table("full_batches")} SET next_check=now()`,
      );
      await service.tick();
    };
    await poll();
    expect(await service.status(user)).toMatchObject({
      status: "review", canReview: true, amaxeeReportAvailable: true,
    });
    await expect(workspaceApi.upload(user, "monthly_recharge", source)).rejects.toMatchObject({
      code: "PREPAID_BATCH_ACTIVE",
    });
    await expect(service.downloadAmaxee(randomUUID(), batch!.id)).rejects.toMatchObject({
      code: "PREPAID_BATCH_NOT_FOUND",
    });
    await expect(service.review(user, batch!.id, "eg", "layout", "mt", 0)).resolves.toMatchObject({
      rows: [{ label: "Variance", total_gross: "0.00" }],
    });
    await expect(service.review(user, batch!.id, "eg", "allocation", "bb", 0)).resolves.toMatchObject({
      rows: [{ revenue_type: "GP_EG_BB", allocation_type: "" }, { revenue_type: "GP_EG_BB", allocation_type: "GP_CB_BB" }],
    });
    await expect(service.review(user, batch!.id, "eg", "allocation-summary", "bb", 0)).resolves.toMatchObject({
      rows: expect.arrayContaining([
        expect.objectContaining({ type: "GP EG BB", gross: "112", amount: "100" }),
        expect.objectContaining({ type: "Posting Key 50", amount: "100.00" }),
      ]),
    });
    await expect(service.review(user, batch!.id, "eg", "jv", "mt", 0)).resolves.toMatchObject({
      rows: [], pendingJournal: true,
    });
    await expect(service.review(randomUUID(), batch!.id, "eg", "layout", "mt", 0)).rejects.toMatchObject({
      code: "PREPAID_BATCH_NOT_READY",
    });
    await expect(service.action(user, "sg")).rejects.toMatchObject({
      code: "PREPAID_BATCH_FREEZE_NOT_READY",
    });
    await expect(
      new PrepaidFullBatch(repo, storage, runner, envPrefix, false).action(user, "eg"),
    ).rejects.toMatchObject({ code: "PREPAID_BATCH_DELIVERY_DISABLED" });
    await service.action(user, "eg");
    await service.tick();
    expect(startExecution).toHaveBeenLastCalledWith(
      `${envPrefix}-prcl_egfrz-sf`,
      { env_prefix: envPrefix },
      `portal-prepaid-${batch!.id}-eg`,
    );
    await poll();
    expect(
      archive.mock.calls
        .map(([key]) => key)
        .filter((key) => key.endsWith(".txt")),
    ).toEqual([
      `prepaid_reclass/sessions/${session}/aws-batch/${batch!.id}/txPrepaid_JV_EGSel.txt`,
    ]);
    expect(await service.download(user, "eg")).toEqual({
      filename: "txPrepaid_JV_EGSel.txt",
      content: content.toString("base64"),
    });
    await expect(service.download(randomUUID(), "eg")).rejects.toMatchObject({
      code: "PREPAID_BATCH_JOURNAL_MISSING",
    });
    const reset = await workspaceApi.reset(user, resetContext);
    expect(reset.session).toBeNull();
    expect(reset.sources.files).toEqual([]);
    expect(await service.status(user)).toMatchObject({ phase: "cleanup", status: "queued" });
    await service.tick();
    expect(landing.finish).toHaveBeenCalledWith(batch!.id, "load_up_eg", [
      { name: "LOAD UP_EG.xlsx", sha256: sha256(workingCopy) },
    ], false);
    expect(landing.release).not.toHaveBeenCalled();
    await service.tick();
    expect(landing.release).toHaveBeenCalledWith(batch!.id, true);
    expect((await service.status(user))?.status).toBe("closed");
    await expect(service.downloadAmaxee(user, batch!.id)).rejects.toMatchObject({
      code: "PREPAID_AMAXEE_NOT_READY",
    });
    await expect(workspaceApi.prepare(user)).rejects.toMatchObject({ code: "PREPAID_BATCH_INPUT_REQUIRED" });
    expect((await service.status(user))?.status).toBe("closed");

    // A new session containing only recharge still starts the parent.
    await pool.query(`UPDATE ${repo.table("upload_sessions")} SET active=true WHERE id=$1`, [session]);
    await pool.query(`UPDATE ${repo.table("session_files")} SET active=false WHERE session_id=$1 AND source_code <> 'monthly_recharge'`, [session]);
    await pool.query(`INSERT INTO dswtdir1_prepaid_dbo.dcprepaidsystems("Layout Number", "REVENUES BEFORE RECLASS")
      VALUES (11,'RECHARGE INSTRUCTION (recharge report)'), (12,'AMAXCE')`);
    await workspaceApi.prepare(user);
    const partial = (await service.status(user))!;
    landing.stage.mockClear();
    await service.tick();
    expect(landing.stage).toHaveBeenCalledTimes(1);
    await service.tick();
    expect(startExecution).toHaveBeenLastCalledWith(
      `${envPrefix}-prcl_proc-sf`, { env_prefix: envPrefix, skip_extract: false, extract_sources: { monthly_recharge: true } },
      `portal-prepaid-${partial.id}-import`,
    );
    await poll();
    const partialLayout = await service.review(user, partial.id, "eg", "layout", "mt", 0);
    expect(partialLayout).toMatchObject({ rows: expect.arrayContaining([
      expect.objectContaining({ layout_number: 12, editable_fields: ["hy_mt_gross"], hy_mt_gross: null }),
    ]) });
    expect(partialLayout).toHaveProperty("layoutVersion");
    await expect(service.saveLayout(user, partial.id, "eg", (partialLayout as { layoutVersion: string }).layoutVersion, [
      { layoutNumber: 12, field: "hy_mt_gross", value: "12.34" },
    ])).resolves.toMatchObject({ rows: expect.arrayContaining([
      expect.objectContaining({ layout_number: 12, hy_mt_gross: "12.34" }),
    ]) });
    await expect(service.action(user, "eg")).rejects.toMatchObject({ code: "PREPAID_BATCH_FREEZE_NOT_READY" });
    await expect(service.review(user, partial.id, "eg", "allocation", "bb", 0)).resolves.toMatchObject({ rows: [], unavailableReason: expect.stringContaining("KE24") });
    const callcard = { originalname: "CALLCARD_SG.xlsx", buffer: Buffer.from("PK workbook"), mimetype: "application/octet-stream" };
    await workspaceApi.upload(user, "callcard_sg", callcard, randomUUID());
    expect(await service.status(user)).toMatchObject({ id: partial.id, status: "review", canUpload: true });
    await workspaceApi.prepare(user);
    await expect(workspaceApi.upload(user, "callcard_sg", callcard)).rejects.toMatchObject({ code: "PREPAID_BATCH_ACTIVE" });
    await service.tick();
    await service.tick();
    expect(startExecution).toHaveBeenLastCalledWith(
      `${envPrefix}-prcl_proc-sf`, { env_prefix: envPrefix, skip_extract: false, extract_sources: { callcard_sg: true } },
      expect.stringMatching(new RegExp(`^portal-prepaid-${partial.id}-import-[0-9a-f]+$`)),
    );
    const firstAttempt = startExecution.mock.lastCall;
    executionStatus = "FAILED";
    await poll();
    expect(await service.status(user)).toMatchObject({ status: "failed", canRetryImport: true });
    await workspaceApi.prepare(user);
    landing.stage.mockClear();
    await service.tick();
    expect(landing.stage).toHaveBeenCalledTimes(1);
    expect(landing.stage).toHaveBeenCalledWith(partial.id, "callcard_sg", expect.any(Array));
    await service.tick();
    expect(startExecution.mock.lastCall).not.toEqual(firstAttempt);
    executionStatus = "SUCCEEDED";
    await poll();
    expect(await service.status(user)).toMatchObject({ id: partial.id, canReview: true, canUpload: true, sourceCodes: ["callcard_sg", "monthly_recharge"] });
    await workspaceApi.reset(user, { sessionId: session, sessionVersion: (await workspaceApi.state(user)).session!.version });
    await service.tick();
    await service.tick();
  });
  it("scopes a continued import to both retained and newly extracted billing rows", async () => {
    const id = randomUUID();
    const execution = `portal-prepaid-${id}-import-0123456789abcdef`;
    const files = [
      { workflow: "adjustments_308", code: "308_21", name: "308_21.xlsx", extractedAt: "2026-11-18T13:00:00Z" },
      { workflow: "charges_318", code: "318_27", name: "318_27.xlsx" },
      { workflow: "ke24", code: "ke24", name: "KE24.xlsx", extractedAt: "2026-11-18T13:00:00Z" },
    ];
    await repo.transaction(async (db) => {
      await db.query(
        `INSERT INTO ${repo.table("full_batches")} (id,session_id,files,phase,status,inputs_staged,executions)
         VALUES($1,$2,$3,'import','running',true,$4)`,
        [id, session, JSON.stringify(files), JSON.stringify({ import: {
          arn: `arn:aws:states:${region}:123456789012:execution:prepaid:${execution}`,
          startedAt: "2026-11-20T13:00:00Z",
        } })],
      );
      await db.query(`INSERT INTO sdbtdir1_prepaid_dbo.billed_adjustments_header_cycles
        VALUES ('308_21.xlsx - generated', '2026-11-18 13:05', 'Cycle Code:', '21');
        INSERT INTO sdbtdir1_prepaid_dbo.billed_charges_header_cycles
        VALUES ('318_27.xlsx', '2026-11-20 13:05', 'Cycle Code:', '27')`);
      await db.query("CALL dswtdir1_prepaid_dbo.prepaid_scope_billing_import($1)", [execution]);
      const { rows } = await db.query(`SELECT
        dswtdir1_prepaid_dbo.prepaid_billing_row_matches('308_21.xlsx - generated','2026-11-18 13:05') AS retained,
        dswtdir1_prepaid_dbo.prepaid_billing_row_matches('308_21.xlsx','2026-11-18 12:59') AS stale,
        dswtdir1_prepaid_dbo.prepaid_billing_row_matches('318_27.xlsx','2026-11-20 13:05') AS fresh,
        dswtdir1_prepaid_dbo.prepaid_billing_row_matches('318_27.xlsx','2026-11-18 13:05') AS old_charge`);
      expect(rows[0]).toEqual({ retained: true, stale: false, fresh: true, old_charge: false });
    });
  });
});
