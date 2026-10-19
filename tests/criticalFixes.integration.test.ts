import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Pool } from "pg";
import {
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApplication } from "../src/app/createApp.js";
import { PostgresRateLimiter } from "../src/app/security.js";
import { loadConfig } from "../src/config.js";
import { migrations } from "../src/migrations.js";
import { processingPipelineSeedRequirements } from "../src/processingPipelineCatalog.js";
import { ProcessingPipelineStorage } from "../src/processingPipelineStorage.js";
import {
  createPipelineUploadBatch,
  createStepFunctionExecution,
  getPipelineUploadBatches,
  getProcessingPipelineBatchStepFunctionMapping,
  getProcessingPipelineRequirements,
  getStepFunctionExecution,
  recordPipelineUploadBatchFile,
} from "../src/processingPipelineRepository.js";
import { ensureWorkspace } from "../src/workspace.js";
import type { AppDependencies } from "../src/app/dependencies.js";

// Run against a disposable local database, never a deployed portal database:
// TEST_DATABASE_URL=postgres://... pnpm exec vitest run tests/criticalFixes.integration.test.ts
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "critical fixes with PostgreSQL and HTTP",
  () => {
    const schema = `critical_test_${randomUUID().replaceAll("-", "")}`;
    let pool: Pool;
    let server: Server;
    let baseUrl: string;
    const userIds = [randomUUID(), randomUUID(), randomUUID()];
    const workspaceIds: string[] = [];
    const historicalBatch = randomUUID();
    const historicalExecution = randomUUID();
    const legacyKey = "bss_billcycle_bayn/inbound/sap_glbilled_B_01.XLSX";
    const writes: { key: string; size: number; hash: string }[] = [];
    const config = loadConfig({
      DATABASE_HOST: "127.0.0.1",
      DATABASE_PORT: "5432",
      DATABASE_NAME: "postgres",
      DATABASE_USER: "critical_tests",
      DATABASE_PASSWORD: "unused-local-test-value",
      OKTA_ISSUER: "https://example.okta.com/oauth2/default",
      OKTA_CLIENT_ID: "test-client",
      RATE_LIMIT_HMAC_SECRET:
        "critical-tests-only-rate-limit-secret-32-characters",
      S3_BUCKET: "critical-tests",
      AWS_REGION: "ap-southeast-1",
      NODE_ENV: "test",
      MAX_UPLOAD_BYTES: "1024", // Legacy environment settings must not lower the fixed limit.
    });

    beforeAll(async () => {
      pool = new Pool({
        connectionString: process.env.TEST_DATABASE_URL,
        max: 1,
      });
      await pool.query(`CREATE SCHEMA ${schema}`);
      await pool.query(`SET search_path TO ${schema}, public`);
      await pool.query("CREATE TABLE schema_migrations (id text PRIMARY KEY)");
      for (const migration of migrations.slice(0, -1)) {
        await pool.query("BEGIN");
        try {
          await pool.query(migration.sql);
          await pool.query("INSERT INTO schema_migrations VALUES ($1)", [
            migration.id,
          ]);
          await pool.query("COMMIT");
        } catch (error) {
          await pool.query("ROLLBACK");
          throw new Error(`Migration ${migration.id} failed`, { cause: error });
        }
      }
      for (const [index, userId] of userIds.entries()) {
        await pool.query(
          "INSERT INTO app_user(id, email, display_name) VALUES ($1,$2,$3)",
          [userId, `user${index}@example.com`, `Uploader ${index}`],
        );
        workspaceIds.push(await ensureWorkspace(pool, userId));
        if (index < 2) {
          await pool.query(
            "INSERT INTO app_user_modules(user_id,module_id) SELECT $1,module_id FROM app_modules",
            [userId],
          );
        }
      }
      const old = (
        await getProcessingPipelineRequirements(pool, "bss_billcycle_bayn")
      ).find((row) => row.fileName === "sap_glbilled_B_01.XLSX")!;
      await createPipelineUploadBatch(pool, {
        id: historicalBatch,
        pipelineCode: "bss_billcycle_bayn",
        workspaceId: workspaceIds[0],
        userId: userIds[0],
      });
      await recordPipelineUploadBatchFile(pool, {
        batchId: historicalBatch,
        pipelineCode: "bss_billcycle_bayn",
        workspaceId: workspaceIds[0],
        requirementId: old.id!,
        originalName: "sap_glbilled_B_01.txt",
        objectKey: legacyKey,
      });
      await createStepFunctionExecution(pool, {
        id: historicalExecution,
        fileMappingId: old.stepFunction!.mappingId,
        executionArn: `arn:aws:states:ap-southeast-1:123456789012:execution:historical:${historicalExecution}`,
        executionInput: { cycle: "01" },
        sourceFiles: [{ key: legacyKey }],
        workspaceId: workspaceIds[0],
        startedByUserId: userIds[0],
        status: "SUCCEEDED",
        startedAt: new Date().toISOString(),
      });
      const migration = migrations.at(-1)!;
      await pool.query("BEGIN");
      try {
        await pool.query(migration.sql);
        await pool.query("INSERT INTO schema_migrations VALUES ($1)", [
          migration.id,
        ]);
        await pool.query("COMMIT");
      } catch (error) {
        await pool.query("ROLLBACK");
        throw error;
      }

      // Exercise the real router, multipart parser and S3 command construction.
      // Only the S3 transport is replaced; no live AWS objects are written.
      const storage = new ProcessingPipelineStorage(
        {
          send: async (command: unknown) => {
            if (command instanceof HeadObjectCommand)
              throw Object.assign(new Error("Not found"), { name: "NotFound" });
            if (command instanceof PutObjectCommand) {
              const body = command.input.Body as Uint8Array;
              writes.push({
                key: command.input.Key!,
                size: body.byteLength,
                hash: createHash("sha256").update(body).digest("hex"),
              });
              return {};
            }
            throw new Error("Unexpected S3 operation in test");
          },
        } as unknown as Pick<S3Client, "send">,
        config.S3_BUCKET,
      );
      const app = createApplication({
        pool,
        config,
        processingPipelineStorage: storage,
        stepFunctionsRunner: {} as AppDependencies["stepFunctionsRunner"],
        logger: { info() {}, error() {} },
        rateLimiter: new PostgresRateLimiter(pool, config),
        authenticate: (request, _response, next) => {
          request.auth = {
            userId: request.header("x-test-user") ?? userIds[0],
          } as NonNullable<typeof request.auth>;
          next();
        },
      });
      server = app.listen(0, "127.0.0.1");
      await once(server, "listening");
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/processing-pipelines`;
    }, 60000);

    afterAll(async () => {
      if (server)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      if (pool) {
        await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await pool.end();
      }
    });

    it("migrates the full fresh schema to the live catalog and preserves historical keys and executions", async () => {
      const active = await pool.query(
        "SELECT pipeline.code, requirement.file_name FROM processing_pipeline_file_requirements requirement JOIN processing_pipelines pipeline ON pipeline.id=requirement.pipeline_id WHERE requirement.is_active",
      );
      expect(
        active.rows.map((row) => `${row.code}|${row.file_name}`).sort(),
      ).toEqual(
        processingPipelineSeedRequirements
          .map((row) => `${row.pipelineCode}|${row.fileName}`)
          .sort(),
      );
      const history = await getPipelineUploadBatches(pool, {
        pipelineCode: "bss_billcycle_bayn",
      });
      expect(
        history.find((batch) => batch.id === historicalBatch)?.files[0]
          .objectKey,
      ).toBe(legacyKey);
      expect(
        (
          await getStepFunctionExecution(
            pool,
            historicalExecution,
            "bss_billcycle_bayn",
          )
        )?.sourceFiles,
      ).toEqual([{ key: legacyKey }]);
    });

    it("is safe to rerun and maintains SAP and restored Globe 308 processing mappings", async () => {
      await pool.query("BEGIN");
      try {
        await pool.query(migrations.at(-1)!.sql);
        await pool.query("COMMIT");
      } catch (error) {
        await pool.query("ROLLBACK");
        throw error;
      }
      const globe = await getProcessingPipelineRequirements(
        pool,
        "bss_billcycle_glob",
      );
      const adjustments = globe.filter((row) =>
        row.fileName.startsWith("308."),
      );
      expect(adjustments).toHaveLength(11);
      expect(
        adjustments.every((row) =>
          row.stepFunction?.stateMachineName.endsWith("_308"),
        ),
      ).toBe(true);
      const bayanBatch = await getProcessingPipelineBatchStepFunctionMapping(
        pool,
        "bss_billcycle_bayn",
        "01",
      );
      expect(
        bayanBatch?.files.some(
          (row) => row.expectedFileName === "sap_glbilled_B_01.txt",
        ),
      ).toBe(true);
      expect(
        bayanBatch?.files.some(
          (row) =>
            row.expectedFileName.endsWith(".XLSX") &&
            row.expectedFileName.startsWith("sap_"),
        ),
      ).toBe(false);
    });

    it.each([
      "bss_eom_glob",
      "bss_eom_bayn",
      "bss_eom_inov",
      "aprm_voice_accrual",
      "aprm_voice_delta",
      "isms_ibob_actzn",
      "isms_iot_da",
      "memo_sst",
    ])(
      "shares %s history across authorized users, preserves ownership, and denies unauthorized users",
      async (pipelineCode) => {
        const requirement = (
          await getProcessingPipelineRequirements(pool, pipelineCode)
        )[0];
        const ids: string[] = [];
        for (const index of [0, 1]) {
          const id = randomUUID();
          ids.push(id);
          await createPipelineUploadBatch(pool, {
            id,
            pipelineCode,
            workspaceId: workspaceIds[index],
            userId: userIds[index],
          });
          await recordPipelineUploadBatchFile(pool, {
            batchId: id,
            pipelineCode,
            workspaceId: workspaceIds[index],
            requirementId: requirement.id!,
            originalName: requirement.fileName,
            objectKey: `${pipelineCode}/inbound/${requirement.fileName}`,
          });
        }
        for (const userId of userIds.slice(0, 2)) {
          const response = await fetch(
            `${baseUrl}/${pipelineCode}/upload-batches`,
            { headers: { "x-test-user": userId } },
          );
          expect(response.status).toBe(200);
          const { batches } = await response.json();
          expect(batches.map((batch: { id: string }) => batch.id)).toEqual(
            expect.arrayContaining(ids),
          );
          expect(
            batches.map((batch: { uploadedBy: string }) => batch.uploadedBy),
          ).toEqual(expect.arrayContaining(["Uploader 0", "Uploader 1"]));
        }
        expect(
          await recordPipelineUploadBatchFile(pool, {
            batchId: ids[0],
            pipelineCode,
            workspaceId: workspaceIds[1],
            requirementId: requirement.id!,
            originalName: "forbidden",
            objectKey: "forbidden",
          }),
        ).toBe(false);
        const denied = await fetch(
          `${baseUrl}/${pipelineCode}/upload-batches`,
          { headers: { "x-test-user": userIds[2] } },
        );
        expect(denied.status).toBe(403);
      },
    );

    it("keeps the catalog response free of upload configuration", async () => {
      const response = await fetch(baseUrl);
      expect(response.status).toBe(200);
      expect(await response.json()).not.toHaveProperty("maxUploadBytes");
    });

    async function upload(
      pipeline: string,
      expected: string,
      local: string,
      bytes: Uint8Array,
    ) {
      const body = new FormData();
      body.set("expectedFileName", expected);
      body.set(
        "file",
        new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "text/plain" }),
        local,
      );
      return fetch(`${baseUrl}/${pipeline}/files`, { method: "POST", body });
    }

    it.each([
      ["glob", "G"],
      ["bayn", "B"],
      ["inov", "I"],
    ])(
      "uploads SAP text bytes with canonical entity/cycle for %s",
      async (code, entity) => {
        const bytes = Buffer.from("company|amount\r\nGlobe|123.45\r\n");
        const expected = `sap_glbilled_${entity}_06.txt`;
        const response = await upload(
          `bss_billcycle_${code}`,
          expected,
          "sap_glbilled_B_01.TXT",
          bytes,
        );
        expect(response.status).toBe(201);
        expect((await response.json()).file.name).toBe(expected);
        expect(writes.at(-1)).toEqual({
          key: `bss_billcycle_${code}/inbound/${expected}`,
          size: bytes.length,
          hash: createHash("sha256").update(bytes).digest("hex"),
        });
      },
    );

    it("accepts restored Globe 308 and corrected EOM 324 uploads", async () => {
      for (const [pipeline, name] of [
        [
          "bss_billcycle_glob",
          "308. Billed Adjustments Monthly Summary Report_G_06.XLSX",
        ],
        ["bss_eom_glob", "324. Unearned MSF Summary Report_G.XLSX"],
      ]) {
        const response = await upload(
          pipeline,
          name,
          name,
          Buffer.from("spreadsheet fixture"),
        );
        expect(response.status).toBe(201);
        expect((await response.json()).file.name).toBe(name);
      }
    });

    it.runIf(process.env.RUN_LARGE_UPLOAD_TESTS === "true")(
      "accepts files below and at 200 MiB, and rejects one byte over",
      async () => {
        for (const size of [209715199, 209715200, 209715201]) {
          const before = writes.length;
          const response = await upload(
            "bss_billcycle_glob",
            "sap_glbilled_G_06.txt",
            "sap_glbilled_G_06.txt",
            new Uint8Array(size),
          );
          expect(response.status).toBe(size > 209715200 ? 413 : 201);
          const result = await response.json();
          if (size > 209715200) {
            expect(result.error.code).toBe("FILE_TOO_LARGE");
            expect(result.error.message).toContain("200 MB");
            expect(writes.length).toBe(before);
          } else expect(result.file.size).toBe(size);
        }
      },
      60000,
    );
  },
);
