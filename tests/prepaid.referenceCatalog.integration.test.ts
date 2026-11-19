import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import express from "express";
import multer from "multer";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { migratePrepaid } from "../src/modules/prepaid/infrastructure/migrationRunner.js";
import { PrepaidRepository } from "../src/modules/prepaid/infrastructure/repository.js";
import { PrepaidReferenceCatalog } from "../src/modules/prepaid/infrastructure/referenceCatalog.js";
import {
  PrepaidStorage,
  sha256,
} from "../src/modules/prepaid/infrastructure/prepaidStorage.js";
import { legacyReferenceFields } from "../src/modules/prepaid/domain/referenceRefresh.js";
import { createPrepaidRouter } from "../src/modules/prepaid/api/router.js";
import { createErrorHandler } from "../src/errors.js";

const url = process.env.PREPAID_TEST_DATABASE_URL;
if (url) {
  const target = new URL(url);
  if (
    target.hostname !== "127.0.0.1" ||
    target.port !== "55479" ||
    target.username !== "prepaid_test"
  )
    throw Error(
      "Use only the disposable prepaid_test cluster on localhost:55479.",
    );
}
describe.skipIf(!url)(
  "Reference catalog API and immutable PostgreSQL storage",
  () => {
    const schema = `prepaid_catalog_${randomUUID().replaceAll("-", "")}`,
      raw = `${schema}_raw`;
    const pool = new Pool({
      connectionString: url,
      options: `-c search_path=${schema},public`,
    });
    const catalog = new PrepaidReferenceCatalog(
      new PrepaidRepository(pool, schema),
    );
    const admin = randomUUID(),
      business = randomUUID();
    let server: Server, base: string;
    const record = {
      ...Object.fromEntries(legacyReferenceFields.map((k) => [k, ""])),
      MANDT: "300",
      BUKRS: "GLOB",
      HKONT: "420105",
      BRAND: "GHP-PREPAID",
      WWSPA: "EG",
      WWBRD: "GP",
      SPB: "EXACT",
      WWST: "MT",
      PSTKY: "50",
      TAXRATE: "0.12",
      AVERATE: "9007199254740993.01",
      DUOM: "EA",
    };
    const bytes = Buffer.from(JSON.stringify(record) + "\n");
    const metadata = {
      period: "2023-09",
      label: "Exact decimal fixture",
      sha256: sha256(bytes),
      rowCount: 1,
      approved: true,
      approvalScope: "development-testing",
      provenance: { fixture: true },
    };
    async function request(
      method: string,
      path: string,
      user = admin,
      body?: BodyInit,
    ) {
      return fetch(base + path, {
        method,
        headers: { "x-test-user": user },
        body,
      });
    }
    function form(data: Buffer = bytes, meta: unknown = metadata) {
      const body = new FormData();
      body.append("file", new Blob([new Uint8Array(data)]), "reference.jsonl");
      body.append("metadata", JSON.stringify(meta));
      return body;
    }
    beforeAll(async () => {
      await pool.query(
        `CREATE SCHEMA "${schema}"; CREATE TABLE app_user(id uuid PRIMARY KEY,is_active boolean DEFAULT true,is_admin boolean DEFAULT false); CREATE TABLE workspaces(id uuid PRIMARY KEY,user_id uuid UNIQUE); CREATE TABLE app_modules(module_id text PRIMARY KEY,is_active boolean DEFAULT true); CREATE TABLE app_user_modules(user_id uuid,module_id text)`,
      );
      const db = await pool.connect();
      try {
        await db.query("BEGIN");
        await migratePrepaid(db, schema, raw);
        await db.query("COMMIT");
      } finally {
        db.release();
      }
      await pool.query(
        "INSERT INTO app_user(id,is_admin) VALUES($1,true),($2,false);",
        [admin, business],
      );
      await pool.query(
        "INSERT INTO app_modules(module_id) VALUES('prepaid_reclass')",
      );
      await pool.query(
        "INSERT INTO app_user_modules(user_id,module_id) VALUES($1,'prepaid_reclass')",
        [business],
      );
      const app = express();
      app.use(express.json());
      app.use(
        "/api/workflows/prepaid",
        createPrepaidRouter(
          {
            pool,
            config: {
              DATABASE_SCHEMA: schema,
              S3_BUCKET: "unused",
              AWS_REGION: "us-east-1",
              DATABASE_HOST: "isolated",
            },
            authenticate: (req: any, _res: any, next: any) => {
              req.auth = { userId: req.get("x-test-user") };
              next();
            },
            prepaidStorage: new PrepaidStorage(
              {
                send: async () => {
                  throw Error("Catalog API must not access S3");
                },
              } as any,
              "unused",
            ),
          } as any,
          multer({ storage: multer.memoryStorage() }).single("file"),
        ),
      );
      app.use(
        createErrorHandler({ info: () => {}, error: () => {} }, {
          DATABASE_SCHEMA: schema,
        } as any),
      );
      server = await new Promise<Server>((resolve) => {
        const s = app.listen(0, "127.0.0.1", () => resolve(s));
      });
      base = `http://127.0.0.1:${(server.address() as any).port}/api/workflows/prepaid`;
    }, 30000);
    afterAll(async () => {
      if (server)
        await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.query(
        `DROP SCHEMA IF EXISTS "${schema}" CASCADE; DROP SCHEMA IF EXISTS "${raw}" CASCADE`,
      );
      await pool.end();
    });
    it("requires administrator permission for listing, import and raw export", async () => {
      for (const [method, path, body] of [
        ["GET", "/reference-versions", undefined],
        ["POST", "/reference-versions", form()],
        ["GET", `/reference-versions/${metadata.sha256}/file`, undefined],
      ] as const)
        expect((await request(method, path, business, body)).status).toBe(403);
    });
    it("rejects wrong checksum, row count and malformed fields without partial rows", async () => {
      expect(
        (
          await request(
            "POST",
            "/reference-versions",
            admin,
            form(bytes, { ...metadata, sha256: "0".repeat(64) }),
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await request(
            "POST",
            "/reference-versions",
            admin,
            form(bytes, { ...metadata, rowCount: 2 }),
          )
        ).status,
      ).toBe(400);
      const invalid = Buffer.from(
        JSON.stringify({ ...record, AVERATE: 1 }) + "\n",
      );
      expect(
        (
          await request(
            "POST",
            "/reference-versions",
            admin,
            form(invalid, { ...metadata, sha256: sha256(invalid) }),
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await pool.query(
            "SELECT count(*)::integer n FROM prepaid_reference_versions",
          )
        ).rows[0].n,
      ).toBe(0);
    });
    it("imports, lists and exports byte-identical records without AWS access or decimal loss", async () => {
      const response = await request(
        "POST",
        "/reference-versions",
        admin,
        form(),
      );
      expect(response.status).toBe(201);
      const descriptor = await response.json();
      expect(descriptor).toEqual({
        sha256: metadata.sha256,
        rowCount: 1,
        approved: true,
      });
      expect(
        (await catalog.load(descriptor, "2023-09")).rows[0].average_rate,
      ).toBe("9007199254740993.01");
      const list = await (await request("GET", "/reference-versions")).json();
      expect(list.versions[0].source_bytes).toBeUndefined();
      expect(list.versions[0].approved_by).toBe(admin);
      const original = await request(
        "GET",
        `/reference-versions/${metadata.sha256}/file`,
      );
      expect(Buffer.from(await original.arrayBuffer())).toEqual(bytes);
      expect(
        (
          await pool.query(
            "SELECT data->>'AVERATE' rate FROM prepaid_reference_version_rows",
          )
        ).rows[0].rate,
      ).toBe("9007199254740993.01");
      await catalog.import(admin, bytes, metadata);
      expect(
        (
          await pool.query(
            "SELECT count(*)::integer n FROM prepaid_reference_versions",
          )
        ).rows[0].n,
      ).toBe(1);
    });
    it("transfers the same version into a separate fresh database with a different administrator and no S3 dependency", async () => {
      const database = `prepaid_catalog_target_${randomUUID().replaceAll("-", "")}`;
      await pool.query(`CREATE DATABASE "${database}"`);
      const targetUrl = new URL(url!);
      targetUrl.pathname = `/${database}`;
      const target = new Pool({
        connectionString: targetUrl.toString(),
        options: "-c search_path=web_portal,public",
      });
      try {
        await target.query(
          "CREATE SCHEMA web_portal; CREATE TABLE app_user(id uuid PRIMARY KEY,is_active boolean DEFAULT true,is_admin boolean DEFAULT true); CREATE TABLE workspaces(id uuid PRIMARY KEY,user_id uuid)",
        );
        const db = await target.connect();
        try {
          await db.query("BEGIN");
          await migratePrepaid(db, "web_portal");
          await db.query("COMMIT");
        } finally {
          db.release();
        }
        const actor = randomUUID();
        await target.query("INSERT INTO app_user(id) VALUES($1)", [actor]);
        const copy = new PrepaidReferenceCatalog(
          new PrepaidRepository(target, "web_portal"),
        );
        const descriptor = await copy.import(
          actor,
          await catalog.export(admin, metadata.sha256),
          await catalog.approvalMetadata(admin, metadata.sha256),
        );
        expect(descriptor.sha256).toBe(metadata.sha256);
        expect(
          (await copy.load(descriptor, "2023-09")).rows[0].average_rate,
        ).toBe("9007199254740993.01");
        expect((await copy.list(actor))[0].approved_by).toBe(actor);
        expect(await copy.export(actor, metadata.sha256)).toEqual(bytes);
      } finally {
        await target.end();
        await pool.query(`DROP DATABASE "${database}"`);
      }
    }, 30000);
    it("prevents mutation, deletion, appending and truncation of sealed reference records", async () => {
      for (const sql of [
        "UPDATE prepaid_reference_versions SET row_count=2",
        "DELETE FROM prepaid_reference_versions",
        "UPDATE prepaid_reference_version_rows SET data='{}'",
        "DELETE FROM prepaid_reference_version_rows",
        "TRUNCATE prepaid_reference_version_rows",
        "TRUNCATE prepaid_reference_versions CASCADE",
      ])
        await expect(pool.query(sql)).rejects.toThrow("IMMUTABLE");
      await expect(
        pool.query(
          "INSERT INTO prepaid_reference_version_rows VALUES($1,2,'{}')",
          [metadata.sha256],
        ),
      ).rejects.toThrow("IMMUTABLE");
    });
  },
);
