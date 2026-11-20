import { randomUUID } from "node:crypto";
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
      CREATE TABLE dswtdir1_prepaid_dbo.dcprepaidsystems("Layout Number" int,"REVENUES BEFORE RECLASS" text,total_gross text,total_net text,freezedata boolean);
      CREATE TABLE dswtdir1_prepaid_dbo.dcprepaidsystems_sg(LIKE dswtdir1_prepaid_dbo.dcprepaidsystems);
      INSERT INTO dswtdir1_prepaid_dbo.dcprepaidsystems VALUES(27,'Variance','0.00','0.00',false);
      INSERT INTO dswtdir1_prepaid_dbo.dcprepaidsystems_sg VALUES(27,'Variance','1','1',false);
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
          expectedCycles: ["21", "27"],
          reportCycles: { adjustments: ["21"], charges: ["27"] },
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
      `DROP SCHEMA IF EXISTS ${schema} CASCADE; DROP SCHEMA IF EXISTS dswtdir1_prepaid_dbo CASCADE;`,
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
    const archive = vi.fn(async (key: string) => ({
      key,
      sha256: sha256(content),
      size: content.length,
    }));
    const storage = {
      legacyLanding: () => landing,
      bytes: async () => content,
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
    const runner = {
      describeStateMachine: async (machine: string) => ({
        name: machine,
        arn: `arn:aws:states:${region}:123456789012:stateMachine:${machine}`,
        type: "STANDARD",
        status: "ACTIVE",
      }),
      startExecution,
      describeExecution: async () => ({ status: "SUCCEEDED", completedAt: mark }),
    } as unknown as StepFunctionsRunner;
    const service = new PrepaidFullBatch(repo, storage, runner, envPrefix, true);
    const workspaceApi = new PrepaidWorkspaceService(
      new PrepaidRunService(repo, storage),
      service,
    );
    await workspaceApi.prepare(user);
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
    const batch = await service.status(user);
    expect(batch?.status).toBe("queued");
    await workspaceApi.upload(user, "monthly_recharge", source, uploadId);
    expect(await service.status(user)).toEqual(batch);
    expect(await service.status(randomUUID())).toBeNull();
    await service.tick();
    expect(landing.stage).toHaveBeenCalledTimes(10);
    expect(startExecution).not.toHaveBeenCalled();
    await service.tick();
    expect(startExecution).toHaveBeenCalledWith(
      `${envPrefix}-prcl_proc-sf`,
      { env_prefix: envPrefix, skip_extract: false },
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
    expect(await service.status(user)).toMatchObject({status: "review", canReview: true});
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
        .filter((key) => key.includes("/aws-batch/")),
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
    expect(landing.release).not.toHaveBeenCalled();
    await service.tick();
    expect(landing.release).toHaveBeenCalledWith(batch!.id, true);
    expect((await service.status(user))?.status).toBe("closed");
    await workspaceApi.prepare(user);
    expect((await service.status(user))?.status).toBe("closed");
  });
});
