import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrations } from "../src/migrations.js";
import { ensureWorkspace } from "../src/workspace.js";
import {
  createPipelineUploadBatch,
  getPipelineUploadBatches,
  markPipelineUploadFileRemoved,
  recordPipelineUploadBatchFile,
} from "../src/processingPipelineRepository.js";

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "Per-file uploader attribution over PostgreSQL",
  () => {
    const schema = `uploader_test_${randomUUID().replaceAll("-", "")}`;
    let pool: Pool;
    let requirementId: number;
    beforeAll(async () => {
      pool = new Pool({
        connectionString: process.env.TEST_DATABASE_URL,
        max: 1,
      });
      await pool.query(`CREATE SCHEMA ${schema}`);
      await pool.query(`SET search_path TO ${schema}, public`);
      for (const migration of migrations) await pool.query(migration.sql);
      requirementId = (
        await pool.query(
          `SELECT requirement.id FROM processing_pipeline_file_requirements requirement JOIN processing_pipelines pipeline ON pipeline.id = requirement.pipeline_id WHERE pipeline.code = 'memo_sst' AND requirement.file_name = '3PComms_01.XLSX'`,
        )
      ).rows[0].id;
    }, 60_000);
    afterAll(async () => {
      if (!pool) return;
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await pool.end();
    });
    const create = async (displayName: string, email: string) => {
      const userId = randomUUID();
      await pool.query(
        "INSERT INTO app_user (id,email,okta_subject,display_name) VALUES ($1,$2,$4,$3)",
        [userId, email, displayName, `uploader-test-${userId}`],
      );
      const workspaceId = await ensureWorkspace(pool, userId);
      const batchId = randomUUID();
      await createPipelineUploadBatch(pool, {
        id: batchId,
        pipelineCode: "memo_sst",
        workspaceId,
        userId,
      });
      const objectKey = `memo_sst/inbound/${batchId}.XLSX`;
      expect(
        await recordPipelineUploadBatchFile(pool, {
          batchId,
          pipelineCode: "memo_sst",
          workspaceId,
          requirementId,
          originalName: "3PComms_20261023_anything.xlsx",
          objectKey,
        }),
      ).toBe(true);
      return { batchId, objectKey };
    };

    it("returns each file's uploader across batches owned by different people", async () => {
      const first = await create("Rodelio", "rodelio@example.test");
      const second = await create("Lance", "lance@example.test");
      const batches = await getPipelineUploadBatches(pool, {
        pipelineCode: "memo_sst",
      });
      expect(
        batches.find((batch) => batch.id === first.batchId)?.files[0]
          .uploadedBy,
      ).toBe("Rodelio");
      expect(
        batches.find((batch) => batch.id === second.batchId)?.files[0]
          .uploadedBy,
      ).toBe("Lance");
    });

    it("uses the email when the uploader has no display name", async () => {
      const { batchId } = await create("  ", "fallback@example.test");
      const batch = (
        await getPipelineUploadBatches(pool, { pipelineCode: "memo_sst" })
      ).find((item) => item.id === batchId)!;
      expect(batch.files[0].uploadedBy).toBe("fallback@example.test");
    });

    it("upgrades the active AUR mapping in place, retains legacy history and leaves inactive mappings intact", async () => {
      await pool.query("BEGIN");
      try {
        const before = (
          await pool.query(
            "SELECT requirement.* FROM processing_pipeline_file_requirements requirement JOIN processing_pipelines pipeline ON pipeline.id = requirement.pipeline_id WHERE pipeline.code = 'aprm_voice_accrual' AND requirement.file_name = 'AUR Extract FINAL.XLSX' AND requirement.is_active",
          )
        ).rows[0];
        await pool.query(
          "UPDATE processing_pipeline_file_requirements SET file_name = 'AUR Extract FINAL_BILLING.XLSX' WHERE id = $1",
          [before.id],
        );
        const inactive = (
          await pool.query(
            "INSERT INTO processing_pipeline_file_requirements (pipeline_id, file_name, match_type, display_order, is_active) VALUES ($1, 'aur extract final_billing.xlsx', 'exact', 9999, false) RETURNING *",
            [before.pipeline_id],
          )
        ).rows[0];
        const seed = await create(
          "Historical AUR uploader",
          "aur-history@example.test",
        );
        const owner = (
          await pool.query(
            "SELECT workspace_id, created_by_user_id FROM processing_pipeline_upload_batches WHERE id = $1",
            [seed.batchId],
          )
        ).rows[0];
        const batchId = randomUUID();
        await createPipelineUploadBatch(pool, {
          id: batchId,
          pipelineCode: "aprm_voice_accrual",
          workspaceId: owner.workspace_id,
          userId: owner.created_by_user_id,
        });
        const objectKey =
          "aprm_voice_accrual/inbound/AUR Extract FINAL_BILLING.XLSX";
        await recordPipelineUploadBatchFile(pool, {
          batchId,
          pipelineCode: "aprm_voice_accrual",
          workspaceId: owner.workspace_id,
          requirementId: before.id,
          originalName: "AUR Extract_10262026.xlsx",
          objectKey,
        });
        const migration = migrations.find(
          (item) => item.id === "027_aprm_accrual_aur_extract_final",
        )!;
        await pool.query(migration.sql);
        await pool.query(migration.sql);
        expect(
          (
            await pool.query(
              "SELECT * FROM processing_pipeline_file_requirements WHERE id = $1",
              [before.id],
            )
          ).rows[0],
        ).toEqual(before);
        expect(
          (
            await pool.query(
              "SELECT * FROM processing_pipeline_file_requirements WHERE id = $1",
              [inactive.id],
            )
          ).rows[0],
        ).toEqual(inactive);
        const history = await getPipelineUploadBatches(pool, {
          pipelineCode: "aprm_voice_accrual",
        });
        expect(
          history.find((batch) => batch.id === batchId)?.files[0],
        ).toMatchObject({
          objectKey,
          uploadedBy: "Historical AUR uploader",
          expectedFileName: "AUR Extract FINAL.XLSX",
        });
      } finally {
        await pool.query("ROLLBACK");
      }
    });

    it("retains file attribution after removal", async () => {
      const { batchId, objectKey } = await create(
        "Original uploader",
        "original@example.test",
      );
      await markPipelineUploadFileRemoved(pool, "memo_sst", objectKey);
      const batch = (
        await getPipelineUploadBatches(pool, { pipelineCode: "memo_sst" })
      ).find((item) => item.id === batchId)!;
      expect(batch.files[0]).toMatchObject({
        uploadedBy: "Original uploader",
        removedAt: expect.any(String),
      });
    });
  },
);
