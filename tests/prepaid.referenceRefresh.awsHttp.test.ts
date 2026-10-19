import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { GlueClient } from "@aws-sdk/client-glue";
import { S3Client } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AwsReferenceRefreshRunner } from "../src/modules/prepaid/infrastructure/referenceRefreshRunner.js";
import {
  PrepaidStorage,
  sha256,
} from "../src/modules/prepaid/infrastructure/prepaidStorage.js";
import {
  referenceRefreshJob as job,
  referenceRefreshRequestSchema,
} from "../src/modules/prepaid/domain/referenceRefresh.js";
import { LegacyLanding } from "../src/modules/prepaid/infrastructure/legacyLanding.js";

// Protocol fixtures are based on the inspected GetJob/GetConnection/GetJobRuns
// responses. Real SDK HTTP calls, fake credentials, no real AWS side effects.
describe("SAP reference AWS protocol over loopback", () => {
  let server: Server,
    glue: GlueClient,
    s3: S3Client,
    runner: AwsReferenceRefreshRunner;
  const calls: { action: string; body: any }[] = [];
  const runs = new Map<string, any>();
  const objects = new Map<string, { body: string; etag: string }>();
  let drift = false,
    wrongDatabase = false,
    loseDispatchResponse = false;
  const scriptFixture =
    "# Synthetic script fixture for SHA-256 pinning tests only\n";
  const defaults = {
    "--pg_connection_name": job.connection,
    "--s4_connection_name": job.sourceConnection,
    "--s4_schema": "SAPPRD",
    "--pg_schema": job.schema,
    "--pg_table_name": job.table,
    "--where_clause": "NA",
    "--partition_column": "NA",
    "--aws_region": "us-east-1",
  };
  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString();
      const action = String(req.headers["x-amz-target"] ?? "")
        .split(".")
        .at(-1)!;
      if (!action) {
        const key = req.url!.split("?")[0];
        if (req.method === "PUT") {
          if (objects.has(key)) {
            res.statusCode = 412;
            res.end();
            return;
          }
          objects.set(key, { body: raw, etag: '"etag-lock"' });
          res.end();
          return;
        }
        if (req.method === "DELETE") {
          if (objects.get(key)?.etag !== req.headers["if-match"]) {
            res.statusCode = 412;
            res.end();
            return;
          }
          objects.delete(key);
          res.statusCode = 204;
          res.end();
          return;
        }
        const value = objects.get(key);
        if (!value) {
          res.statusCode = 404;
          res.end();
          return;
        }
        res.setHeader("etag", value.etag);
        res.setHeader("content-length", Buffer.byteLength(value.body));
        res.end(value.body);
        return;
      }
      const body = JSON.parse(raw);
      calls.push({ action, body });
      res.setHeader("content-type", "application/x-amz-json-1.1");
      const send = (data: unknown) => res.end(JSON.stringify(data));
      switch (action) {
        case "GetJob":
          send({
            Job: {
              Name: job.name,
              Command: {
                Name: "glueetl",
                ScriptLocation: `s3://${job.scriptBucket}/${job.scriptKey}`,
              },
              DefaultArguments: {
                ...defaults,
                ...(drift ? { "--pg_table_name": "wrong" } : {}),
              },
            },
          });
          return;
        case "GetConnection":
          send({
            Connection: {
              ConnectionProperties: {
                JDBC_CONNECTION_URL: `jdbc:postgresql://127.0.0.1:55479/${wrongDatabase ? "wrong" : "postgres"}`,
              },
            },
          });
          return;
        case "StartJobRun": {
          const id = `jr_${runs.size + 1}`;
          runs.set(id, {
            Id: id,
            JobName: body.JobName,
            Arguments: body.Arguments,
            JobRunState: "RUNNING",
          });
          if (loseDispatchResponse) {
            res.statusCode = 500;
            send({
              __type: "InternalServiceException",
              message: "Response lost after dispatch",
            });
            return;
          }
          send({ JobRunId: id });
          return;
        }
        case "GetJobRuns":
          send({ JobRuns: [...runs.values()] });
          return;
        case "GetJobRun":
          send({ JobRun: runs.get(body.RunId) });
          return;
        default:
          res.statusCode = 501;
          send({ message: "Unexpected operation" });
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const options = {
      endpoint: `http://127.0.0.1:${(server.address() as any).port}`,
      region: "us-east-1",
      credentials: { accessKeyId: "TESTONLY", secretAccessKey: "TESTONLY" },
      maxAttempts: 1,
    };
    glue = new GlueClient(options);
    s3 = new S3Client({ ...options, forcePathStyle: true });
    const scripts = new PrepaidStorage(s3, job.scriptBucket);
    // Pinning mechanics use an explicit synthetic script hash, not copied AWS code.
    // Production defaults to the actual inspected hash in referenceRefresh.ts.
    runner = new AwsReferenceRefreshRunner(
      glue,
      scripts,
      sha256(Buffer.from(scriptFixture)),
    );
  });
  beforeEach(() => {
    calls.length = 0;
    runs.clear();
    objects.clear();
    drift = false;
    wrongDatabase = false;
    loseDispatchResponse = false;
    objects.set(`/${job.scriptBucket}/${job.scriptKey}`, {
      body: scriptFixture,
      etag: '"script"',
    });
  });
  afterAll(async () => {
    glue.destroy();
    s3.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  it("requires explicit scope and whole-table overwrite authorization", () => {
    const request = {
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
      period: "2026-09",
      scopeApproved: true,
      mode: "refresh_and_export",
    };
    expect(referenceRefreshRequestSchema.safeParse(request).success).toBe(
      false,
    );
    expect(
      referenceRefreshRequestSchema.safeParse({
        ...request,
        sharedWritesApproved: true,
      }).success,
    ).toBe(true);
    expect(
      referenceRefreshRequestSchema.safeParse({
        ...request,
        mode: "export_existing",
      }).success,
    ).toBe(true);
    expect(
      referenceRefreshRequestSchema.safeParse({
        ...request,
        mode: "export_existing",
        scopeApproved: false,
      }).success,
    ).toBe(false);
  });
  it("dispatches only the existing job with one ignored correlation argument, and discovers/polls the original run", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const run = await runner.start(id);
    expect(await runner.find(id)).toBe(run);
    expect(await runner.describe(id, run)).toBe("RUNNING");
    await expect(runner.idle()).rejects.toThrow("already active");
    await runner.idle(run);
    runs.get(run).JobRunState = "SUCCEEDED";
    expect(await runner.describe(id, run)).toBe("SUCCEEDED");
    await runner.idle();
    expect(calls.find((c) => c.action === "StartJobRun")!.body).toEqual({
      JobName: job.name,
      Arguments: { [job.marker]: id },
    });
    expect(
      calls.every((c) => !/Update|Create|StartExecution/.test(c.action)),
    ).toBe(true);
  });
  it("rejects a mismatched run marker and unsafe runtime overrides", async () => {
    const run = await runner.start("one");
    await expect(runner.describe("two", run)).rejects.toThrow("identity");
    runs.get(run).Arguments["--pg_schema"] = "elsewhere";
    await expect(runner.describe("one", run)).rejects.toThrow("overrides");
    runs.get(run).Arguments["--pg_schema"] = job.schema;
    expect(await runner.describe("one", run)).toBe("RUNNING");
  });
  it("does not choose between duplicate marked runs", async () => {
    await runner.start("one");
    await runner.start("one");
    await expect(runner.find("one")).rejects.toThrow("Multiple");
  });
  it("fails closed on changed job contracts and script bytes without dispatch", async () => {
    drift = true;
    await expect(
      runner.verify({
        database: "postgres",
        address: "127.0.0.1",
        port: 55479,
      }),
    ).rejects.toThrow("contract");
    drift = false;
    objects.set(`/${job.scriptBucket}/${job.scriptKey}`, {
      body: "changed script",
      etag: '"script"',
    });
    await expect(
      runner.verify({
        database: "postgres",
        address: "127.0.0.1",
        port: 55479,
      }),
    ).rejects.toThrow("script has changed");
    expect(calls.some((c) => c.action === "StartJobRun")).toBe(false);
  });
  it("checks the hidden-password JDBC destination against the actual portal server, not literal RDS hostnames", async () => {
    await runner.verify({
      database: "postgres",
      address: "127.0.0.1",
      port: 55479,
    });
    await runner.verify({
      database: "postgres",
      address: "172.31.34.32/32",
      connectedHost: "127.0.0.1",
      port: 55479,
    });
    expect(
      calls.find((c) => c.action === "GetConnection")!.body.HidePassword,
    ).toBe(true);
    wrongDatabase = true;
    await expect(
      runner.verify({
        database: "postgres",
        address: "127.0.0.1",
        port: 55479,
      }),
    ).rejects.toThrow("different database");
    wrongDatabase = false;
    await expect(
      runner.verify({
        database: "postgres",
        address: "192.0.2.1",
        port: 55479,
      }),
    ).rejects.toThrow("different database");
    expect(calls.some((c) => c.action === "StartJobRun")).toBe(false);
  });
  it("does not SDK-retry an uncertain dispatch and can discover the accepted original run", async () => {
    loseDispatchResponse = true;
    await expect(runner.start("lost-response")).rejects.toThrow();
    expect(calls.filter((c) => c.action === "StartJobRun")).toHaveLength(1);
    expect(await runner.find("lost-response")).toBe("jr_1");
  });
  it("shares the native extraction lock and releases it idempotently without touching inputs", async () => {
    const landing = new LegacyLanding(s3, "test-bucket");
    await landing.acquire("reference:one");
    await landing.acquire("reference:one");
    await expect(landing.acquire("extraction:two")).rejects.toThrow(
      "Another extraction",
    );
    await expect(landing.release("extraction:two")).rejects.toThrow(
      "refusing release",
    );
    await landing.release("reference:one");
    await landing.release("reference:one");
    expect(objects.size).toBe(1); // Only the unrelated script fixture remains.
  });
});
