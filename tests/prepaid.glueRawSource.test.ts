import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { Client } from "pg";
import { GlueClient } from "@aws-sdk/client-glue";
import { SFNClient } from "@aws-sdk/client-sfn";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import {
  AwsGlueRawSourceReader,
  assertRawRows,
} from "../src/modules/prepaid/infrastructure/glueRawSourceReader.js";
import { BackendSourceNormalizer } from "../src/modules/prepaid/infrastructure/sourceNormalizer.js";
import {
  sourceWorkflows,
  sourceLandingName,
  type SourceWorkflow,
} from "../src/modules/prepaid/domain/sourceExtraction.js";
import { prepaidRawTables } from "../src/modules/prepaid/infrastructure/rawSourceMigration.js";
import { additionalRawTables } from "../src/modules/prepaid/infrastructure/allSourceMigration.js";
import { PrepaidStorage } from "../src/modules/prepaid/infrastructure/prepaidStorage.js";
import { snapshotGlueSources } from "../src/modules/prepaid/application/glueSourceSnapshot.js";
import { verifyGlueSourceCapture } from "../src/modules/prepaid/application/glueSourceSnapshot.js";
import { nativeJobFixture, fakeS3 } from "./fixtures/prepaidSource.js";

const at = new Date("2026-11-03T00:00:00Z");
function rowId(milliseconds = at.getTime() + 1000) {
  const hex = milliseconds.toString(16).padStart(12, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8)}-7000-8000-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}
describe("Glue raw row provenance", () => {
  it("rejects old, duplicate, unknown-file and missing row identities", () => {
    const valid = {
      filename: "KE24.xlsx",
      sequentialid: rowId(),
      dateread: at.toISOString(),
    };
    const check = (rows: any[]) =>
      assertRawRows(rows, ["KE24.xlsx"], at, new Date(at.getTime() + 10000));
    expect(() => check([valid])).not.toThrow();
    expect(() =>
      check([{ ...valid, sequentialid: rowId(at.getTime() - 1) }]),
    ).toThrow("stale");
    expect(() => check([valid, valid])).toThrow("duplicate");
    expect(() => check([{ ...valid, filename: "another.xlsx" }])).toThrow(
      "unexpected",
    );
    expect(() => check([{ ...valid, sequentialid: null }])).toThrow(
      "identities",
    );
  });
});

const testUrl = process.env.PREPAID_TEST_DATABASE_URL;
if (testUrl) {
  const parsed = new URL(testUrl);
  if (
    parsed.hostname !== "127.0.0.1" ||
    parsed.port !== "55479" ||
    parsed.username !== "prepaid_test"
  )
    throw Error("Use only the isolated prepaid_test database on port 55479.");
}
const runtime =
  process.env.PREPAID_PYTHON_EXECUTABLE ||
  (process.platform === "win32"
    ? ".venv-prepaid/Scripts/python.exe"
    : ".venv-prepaid/bin/python");
describe.skipIf(!testUrl || !existsSync(runtime))(
  "Real AWS HTTP protocol -> read-only PostgreSQL -> accounting datasets",
  () => {
    const database = `prepaid_raw_${randomUUID().replaceAll("-", "")}`;
    const admin = new Client({ connectionString: testUrl });
    let db: Client, server: Server, reader: AwsGlueRawSourceReader;
    let glue: GlueClient, sfn: SFNClient, secrets: SecretsManagerClient;
    let failJob = false,
      omitHeader = false,
      captureCalls = 0;
    const calls: string[] = [];
    const sources = (workflow: SourceWorkflow) => [
      {
        id: "abcdabcd-abcd-4abc-8abc-abcdabcdabcd",
        code:
          workflow === "adjustments_308"
            ? "308_21"
            : workflow === "charges_318"
              ? "318_27"
              : workflow,
      },
    ];
    const request = (workflow: SourceWorkflow) => ({
      workflow,
      executionArn: `arn:aws:states:us-east-1:123456789012:execution:fixture:${workflow}`,
      envPrefix: "isg-esatp-dv",
      bucket: "test-bucket",
      sources: sources(workflow),
    });
    const normalizer = new BackendSourceNormalizer();
    beforeAll(async () => {
      await admin.connect();
      await admin.query(`CREATE DATABASE "${database}"`);
      const url = new URL(testUrl!);
      url.pathname = `/${database}`;
      db = new Client({ connectionString: url.toString() });
      await db.connect();
      await db.query("CREATE SCHEMA sdbtdir1_prepaid_dbo");
      const shapes = { ...prepaidRawTables, ...additionalRawTables };
      for (const [table, columns] of Object.entries(shapes)) {
        await db.query(
          `CREATE TABLE sdbtdir1_prepaid_dbo."${table}" (${columns.map((c) => `"${c.name}" ${c.type}`).join(",")})`,
        );
      }
      async function insert(
        table: string,
        workflow: SourceWorkflow,
        value: Record<string, any>,
      ) {
        const data = {
          ...value,
          filename: sourceLandingName(workflow, sources(workflow)[0].code),
          sequentialid: rowId(),
          dateread: "2026-11-03 00:00:01",
        };
        const keys = Object.keys(data);
        await db.query(
          `INSERT INTO sdbtdir1_prepaid_dbo."${table}" (${keys.map((k) => `"${k}"`).join(",")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(",")})`,
          Object.values(data),
        );
      }
      await insert("dcKE24", "ke24", {
        "Period/Year": "009.2023",
        "Document number": "D1",
        "Reference document": "8001",
        "Item number": "1",
        "Cost Element": "40001",
        "Profit Center": "P1",
        "Sub-Product Group B": "SUB1",
        CACur: "PHP",
        "Value TranCurr": "-123.45",
        "Total Quantity": "12",
        "Unit of Measure": "EA",
        "Sub-Product Group A": "EG",
        Brand: "GP",
        "Product-Rev Type": "MT",
      });
      await insert("dcmanualcallcard", "callcard_eg", {
        count: "1",
        business: "EG",
        "GROSS AMOUNT": "1.50",
      });
      await insert("dccallcard_sg", "callcard_sg", {
        column1: "September 2023",
        trade: "12.30",
        "INTERNAL  (BASED ON SALES)": "4.50",
      });
      await insert("dcload_up", "load_up_eg", {
        "SFA#": "S1",
        type: "EG",
        amount: "25.50",
      });
      await insert("dcload_up_sg", "load_up_sg", {
        type: "SG",
        amount: "35.50",
      });
      await insert("dcload_api", "load_api_eg", {
        type: "EG",
        "Top up Amount": "45.50",
      });
      await insert("dcload_api_sg", "load_api_sg", {
        type: "SG",
        "Top up Amount": "55.50",
      });
      await insert("dcmonthlyrechargesummary", "monthly_recharge", {
        "CUSTOMER TYPE": "E",
        "RECHARGE METHOD": "PS",
        "RECHARGE CHANNEL": "RP",
        "RECHARGE AMOUNT": "65.50",
      });
      for (const [workflow, kind, cycle] of [
        ["adjustments_308", "adjustments", "21"],
        ["charges_318", "charges", "27"],
      ] as const) {
        for (const [column1, column2] of [
          ["Cycle Code", cycle],
          ["Cycle Year", "2023"],
          ["Cycle Instance", "9"],
        ])
          await insert(`billed_${kind}_header_cycles`, workflow, {
            column1,
            column2,
          });
      }
      await insert("billed_adjustments_lineitem_cycles", "adjustments_308", {
        "Customer Type": "E",
        "Adjustment Code": "AMAXCEP",
        currency: "PHP",
        amount: "-75.50",
      });
      await insert("billed_charges_lineitem_cycles", "charges_318", {
        "Customer Type": "E",
        "Charge Code/Tax Code": "AMAXCEP",
        currency: "PHP",
        "Total Amount": "85.50",
      });
      server = createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString());
        const action = String(req.headers["x-amz-target"]).split(".").at(-1)!;
        calls.push(action);
        res.setHeader("Content-Type", "application/x-amz-json-1.1");
        const send = (value: unknown) => res.end(JSON.stringify(value));
        if (action === "GetExecutionHistory") {
          captureCalls++;
          const workflow = body.executionArn
            .split(":")
            .at(-1) as SourceWorkflow;
          return send({
            events: sourceWorkflows[workflow].jobs
              .filter((_, i) => !(omitHeader && i === 0))
              .map((n, i) => ({
                id: i + 1,
                previousEventId: i,
                timestamp: at.getTime() / 1000,
                type: "TaskSubmitted",
                taskSubmittedEventDetails: {
                  resourceType: "glue",
                  resource: "startJobRun.sync",
                  output: JSON.stringify({
                    JobName: `isg-esatp-dv-prep_reclass-gljo-extract_${n}`,
                    JobRunId: `jr_${n}`,
                  }),
                },
              })),
          });
        }
        if (action === "GetJobRun")
          return send({
            JobRun: {
              Id: body.RunId,
              JobName: body.JobName,
              JobRunState: failJob ? "FAILED" : "SUCCEEDED",
              StartedOn: at.getTime() / 1000,
              CompletedOn: at.getTime() / 1000 + 10,
            },
          });
        if (action === "GetJob") {
          const number = Number(body.JobName.split("_").at(-1));
          const fixture = nativeJobFixture(number);
          const mapping = Object.values(sourceWorkflows).find((m) =>
            (m.jobs as readonly number[]).includes(number),
          )!;
          const index = (mapping.jobs as readonly number[]).indexOf(number);
          return send({
            Job: {
              Name: body.JobName,
              DefaultArguments: {
                ...fixture.arguments,
                "--target_table": `sdbtdir1_prepaid_dbo.${mapping.targets[index]}`,
                "--input_file_name": mapping.inputPattern,
                "--folder_location": "test-bucket/prepaid_reclass/",
              },
            },
          });
        }
        if (action === "GetConnection")
          return send({
            Connection: {
              Name: body.Name,
              ConnectionType: "JDBC",
              ConnectionProperties: {
                JDBC_CONNECTION_URL: `jdbc:postgresql://127.0.0.1:55479/${database}`,
                JDBC_ENFORCE_SSL: "false",
                SECRET_ID: "fixture-secret",
              },
            },
          });
        if (action === "GetSecretValue")
          return send({
            SecretString: JSON.stringify({
              username: "prepaid_test",
              password: "local-trust-only",
            }),
          });
        res.statusCode = 501;
        send({ message: "Unimplemented action" });
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const options = {
        region: "us-east-1",
        endpoint: `http://127.0.0.1:${(server.address() as any).port}`,
        maxAttempts: 1,
        credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
      };
      glue = new GlueClient(options);
      sfn = new SFNClient(options);
      secrets = new SecretsManagerClient(options);
      reader = new AwsGlueRawSourceReader(glue, sfn, secrets);
    }, 30000);
    afterAll(async () => {
      glue?.destroy();
      sfn?.destroy();
      secrets?.destroy();
      if (server)
        await new Promise<void>((resolve) => server.close(() => resolve()));
      await db?.end();
      if (admin._connected) {
        await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
        await admin.end();
      }
    });
    it.each(Object.keys(sourceWorkflows) as SourceWorkflow[])(
      "uses actual %s Glue table columns for financial inputs",
      async (workflow) => {
        const capture = await reader.capture(request(workflow));
        const datasets = await normalizer.normalizeRaw(
          workflow,
          sources(workflow)[0].code,
          capture.tables,
          "2023-09",
        );
        expect(Object.keys(datasets).sort()).toEqual(
          [...sourceWorkflows[workflow].artifacts].sort(),
        );
        const financial = Object.entries(datasets)
          .filter(([key]) => !key.endsWith("headers"))
          .flatMap(([, rows]) => rows) as any[];
        const expected = {
          ke24: "-123.45",
          callcard_eg: "1.50",
          callcard_sg: "12.30",
          load_up_eg: "25.50",
          load_up_sg: "35.50",
          load_api_eg: "45.50",
          load_api_sg: "55.50",
          monthly_recharge: "65.50",
          adjustments_308: "-75.5",
          charges_318: "85.5",
        };
        expect(financial[0].amount).toBe(expected[workflow]);
      },
    );
    it("resumes an immutable capture without rereading subsequently changed raw tables", async () => {
      const s3 = fakeS3(),
        storage = new PrepaidStorage({ send: s3.send } as any, "test-bucket");
      const prefix =
        "prepaid_reclass/sessions/fixture/preparation/fixture/extractions/load_api_eg/";
      const first = await snapshotGlueSources(
        request("load_api_eg"),
        prefix,
        storage,
        reader,
        normalizer,
        async () => {},
        "2023-09",
      );
      const before = captureCalls;
      await db.query(
        "UPDATE sdbtdir1_prepaid_dbo.dcload_api SET \"Top up Amount\"='999.99'",
      );
      const resumed = await snapshotGlueSources(
        request("load_api_eg"),
        prefix,
        storage,
        reader,
        normalizer,
        async () => {},
        "2023-09",
      );
      expect(resumed).toEqual(first);
      expect(captureCalls).toBe(before);
      expect(
        s3.objects.get(first.artifacts[0].key)!.bytes.toString(),
      ).toContain('"45.50"');
      const receipt = { ...first } as any;
      await expect(
        verifyGlueSourceCapture(
          receipt,
          request("load_api_eg"),
          prefix,
          storage,
        ),
      ).resolves.toBeUndefined();
      receipt.artifacts = first.artifacts.map((a) => ({
        ...a,
        key: `${prefix}preflight/loadapi.jsonl`,
      }));
      await expect(
        verifyGlueSourceCapture(
          receipt,
          request("load_api_eg"),
          prefix,
          storage,
        ),
      ).rejects.toThrow("preflight amounts");
    });
    it("checks database read access before dispatch and expands native numeric notation exactly", async () => {
      await expect(
        reader.verifyAccess({ envPrefix: "isg-esatp-dv" }),
      ).resolves.toBeUndefined();
      const result = await normalizer.normalizeRaw(
        "load_api_eg",
        "load_api_eg",
        {
          dcload_api: [{ type: "EG", "Top up Amount": "1.25E+3" }],
        },
        "2023-09",
      );
      expect((result.loadapi[0] as any).amount).toBe("1250.00");
    });
    it("reduces KE24 using legacy dimensions before rounding and validates rows hidden by grouping", async () => {
      const baseId = rowId().slice(0, 24);
      try {
        await db.query(
          `INSERT INTO sdbtdir1_prepaid_dbo."dcKE24"
          ("Period/Year","Reference document","Cost Element","Profit Center","Sub-Product Group B","CACur","Value TranCurr","Total Quantity","Unit of Measure","Sub-Product Group A","Brand","Product-Rev Type",filename,sequentialid,dateread)
          SELECT '009.2023','8001',CASE WHEN i%2=0 THEN '42' ELSE '0000000042' END,'rounding-fixture','SUB1','PHP','0.000000000006','0','EA','SG','GP','MT','KE24.xlsx',$1||lpad(i::text,12,'0'),'2026-11-03 00:00:01' FROM generate_series(1,10) i`,
          [baseId],
        );
        const capture = await reader.capture(request("ke24"));
        expect(capture.rowCounts?.dcKE24).toBe(11);
        expect(capture.tables.dcKE24).toHaveLength(2);
        const normalized = await normalizer.normalizeRaw(
          "ke24",
          "ke24",
          capture.tables,
        );
        const grouped = (normalized.ke24 as any[]).find(
          (row) => row.profit_center === "rounding-fixture",
        );
        expect(grouped.amount).toBe("0.0000000001");
        expect(grouped.reference_document).toBe("8");
        expect(grouped.cost_element).toBe("0000000042");
        await db.query(
          `UPDATE sdbtdir1_prepaid_dbo."dcKE24" SET sequentialid=(SELECT sequentialid FROM sdbtdir1_prepaid_dbo."dcKE24" WHERE "Profit Center"='P1' LIMIT 1) WHERE "Profit Center"='rounding-fixture'`,
        );
        await expect(reader.capture(request("ke24"))).rejects.toThrow(
          "duplicate extraction row identities",
        );
      } finally {
        await db.query(
          `DELETE FROM sdbtdir1_prepaid_dbo."dcKE24" WHERE "Profit Center"='rounding-fixture'`,
        );
      }
    });
    it("rejects a missing header job and a failed native job without querying financial data", async () => {
      omitHeader = true;
      try {
        await expect(
          reader.capture(request("adjustments_308")),
        ).rejects.toThrow("missing an expected");
      } finally {
        omitHeader = false;
      }
      failJob = true;
      try {
        await expect(reader.capture(request("ke24"))).rejects.toThrow(
          "successful job-run",
        );
      } finally {
        failJob = false;
      }
      expect(
        calls.every((action) =>
          [
            "GetExecutionHistory",
            "GetJobRun",
            "GetJob",
            "GetConnection",
            "GetSecretValue",
          ].includes(action),
        ),
      ).toBe(true);
    });
  },
);
