import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { S3Client } from "@aws-sdk/client-s3";
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { LegacyLanding } from "../src/modules/prepaid/infrastructure/legacyLanding.js";
import { sha256 } from "../src/modules/prepaid/infrastructure/prepaidStorage.js";

// Actual SDK HTTP/streaming against the observed S3 protocol, never AWS writes.
describe("Shared input reuse over real S3 SDK HTTP", () => {
  let server: Server, client: S3Client, landing: LegacyLanding;
  const objects = new Map<
    string,
    { bytes: Buffer; metadata: Record<string, string> }
  >();
  const writes: string[] = [],
    deletes: string[] = [];
  const etag = (bytes: Buffer) =>
    `"${createHash("sha256").update(bytes).digest("hex")}"`;
  let replaceBeforeConditional = false;
  const file = {
    name: "KE24.xlsx",
    bytes: Buffer.from("verified original workbook bytes"),
    sha256: "",
  };
  file.sha256 = sha256(file.bytes);
  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const url = new URL(req.url!, "http://localhost");
      const key = decodeURIComponent(url.pathname).replace(
        /^\/test-bucket\/?/,
        "",
      );
      const prior = objects.get(key);
      res.setHeader("x-amz-request-id", "local-landing-test");
      if (req.method === "GET" && url.searchParams.has("list-type")) {
        const prefix = url.searchParams.get("prefix") ?? "";
        res.setHeader("content-type", "application/xml");
        res.end(
          `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>false</IsTruncated>${[
            ...objects.keys(),
          ]
            .filter((k) => k.startsWith(prefix))
            .map((k) => `<Contents><Key>${k}</Key></Contents>`)
            .join("")}</ListBucketResult>`,
        );
      } else if (req.method === "GET") {
        if (!prior) {
          res.writeHead(404);
          res.end("<Error><Code>NoSuchKey</Code></Error>");
          return;
        }
        res.setHeader("etag", etag(prior.bytes));
        res.setHeader("content-length", prior.bytes.length);
        for (const [name, value] of Object.entries(prior.metadata))
          res.setHeader(`x-amz-meta-${name}`, value);
        res.end(prior.bytes);
      } else if (req.method === "PUT") {
        if (replaceBeforeConditional && req.headers["if-match"]) {
          replaceBeforeConditional = false;
          objects.set(key, {
            bytes: Buffer.from("external race winner"),
            metadata: {},
          });
        }
        if (
          req.headers["if-match"] &&
          (!objects.has(key) ||
            req.headers["if-match"] !== etag(objects.get(key)!.bytes))
        ) {
          res.writeHead(412);
          res.end("<Error><Code>PreconditionFailed</Code></Error>");
          return;
        }
        if (prior && req.headers["if-none-match"] === "*") {
          res.writeHead(412);
          res.end("<Error><Code>PreconditionFailed</Code></Error>");
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        objects.set(key, {
          bytes: Buffer.concat(chunks),
          metadata: Object.fromEntries(
            Object.entries(req.headers)
              .filter(([k]) => k.startsWith("x-amz-meta-"))
              .map(([k, v]) => [k.slice(11), String(v)]),
          ),
        });
        writes.push(key);
        res.setHeader("etag", etag(objects.get(key)!.bytes));
        res.end();
      } else if (req.method === "DELETE") {
        deletes.push(key);
        objects.delete(key);
        res.writeHead(204);
        res.end();
      } else {
        res.writeHead(501);
        res.end();
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    client = new S3Client({
      region: "us-east-1",
      endpoint: `http://127.0.0.1:${(server.address() as any).port}`,
      forcePathStyle: true,
      maxAttempts: 1,
      credentials: { accessKeyId: "fake", secretAccessKey: "fake" },
    });
    landing = new LegacyLanding(client, "test-bucket");
  });
  beforeEach(() => {
    objects.clear();
    writes.length = 0;
    deletes.length = 0;
    replaceBeforeConditional = false;
  });
  afterAll(async () => {
    client.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  it("streams and hashes an unmanaged existing file, reuses it and deletes only its own coordination lock", async () => {
    const key = landing.prefix + file.name;
    objects.set(key, { bytes: file.bytes, metadata: {} });
    await landing.acquire("our-extraction");
    await landing.stage("our-extraction", "ke24", [file]);
    await landing.finish("our-extraction", "ke24", [file]);
    expect(writes).toEqual([landing.lockKey]);
    expect(deletes).toEqual([landing.lockKey]);
    expect(objects.get(key)?.bytes).toEqual(file.bytes);
  });
  it("blocks different bytes and a different portal owner before any input write/delete", async () => {
    const key = landing.prefix + file.name;
    objects.set(key, { bytes: Buffer.from("different bytes"), metadata: {} });
    await landing.acquire("our-extraction");
    await expect(
      landing.stage("our-extraction", "ke24", [file]),
    ).rejects.toMatchObject({
      details: { reason: "source_bytes_conflict", key },
    });
    objects.set(key, {
      bytes: file.bytes,
      metadata: {
        "portal-owner": "other-extraction",
        "portal-sha256": file.sha256,
      },
    });
    await expect(
      landing.stage("our-extraction", "ke24", [file]),
    ).rejects.toMatchObject({
      details: {
        reason: "ownership_or_metadata_conflict",
        actualOwner: "other-extraction",
      },
    });
    expect(writes).toEqual([landing.lockKey]);
    expect(deletes).toEqual([]);
  });
  it.each([false, true])(
    "retains an original and conditionally replaces only the verified working copy (race=%s)",
    async (race) => {
      const name = "CALLCARD_EG.xlsx",
        key = landing.prefix + name;
      objects.set(key, { bytes: file.bytes, metadata: {} });
      const native = Buffer.from("adapted native input");
      const input = {
        name,
        bytes: native,
        sha256: sha256(native),
        original: { bytes: file.bytes, sha256: file.sha256 },
      };
      await landing.acquire("our-extraction");
      replaceBeforeConditional = race;
      const operation = landing.stage("our-extraction", "callcard_eg", [input]);
      if (race)
        await expect(operation).rejects.toMatchObject({
          $metadata: { httpStatusCode: 412 },
        });
      else await operation;
      const backup = `prepaid_reclass/portal-coordination/input-backups/our-extraction/${file.sha256}/${name}`;
      expect(objects.get(backup)?.bytes).toEqual(file.bytes);
      expect(objects.get(key)?.bytes).toEqual(
        race ? Buffer.from("external race winner") : native,
      );
      if (!race) {
        await landing.finish("our-extraction", "callcard_eg", [input]);
        expect(objects.has(backup)).toBe(true);
      }
    },
  );
});
