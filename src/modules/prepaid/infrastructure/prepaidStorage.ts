import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { createAwsClientOptions } from "../../../aws.js";
import type { Config } from "../../../config.js";
import { AppError } from "../../../errors.js";
import { LegacyLanding } from "./legacyLanding.js";
import type { Logger } from "../../../platform/logger.js";

export const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
export class PrepaidStorage {
  constructor(
    private readonly client: Pick<S3Client, "send">,
    readonly bucket: string,
  ) {}
  legacyLanding(logger?: Logger) {
    return new LegacyLanding(this.client, this.bucket, logger);
  }
  async putVerified(
    key: string,
    prefix: string,
    body: Uint8Array,
    contentType: string,
  ) {
    this.assertKey(key, prefix);
    try {
      return await this.put(key, body, contentType);
    } catch (e) {
      if ((e as any).$metadata?.httpStatusCode !== 412) throw e;
      const saved = await this.bytes(key, prefix, Math.max(body.byteLength, 1));
      if (sha256(saved) !== sha256(body))
        throw Error(
          "Immutable backend artifact already exists with different content.",
        );
      return { key, sha256: sha256(body), size: body.byteLength };
    }
  }
  prefix(runId: string) {
    return `prepaid_reclass/runs/${runId}/`;
  }
  sessionPrefix(sessionId: string) {
    return `prepaid_reclass/sessions/${sessionId}/`;
  }
  assertKey(key: string, prefix: string) {
    if (
      !key.startsWith(prefix) ||
      key === prefix ||
      key.includes("..") ||
      key.includes("\\") ||
      key.endsWith("/")
    )
      throw new AppError(
        400,
        "INVALID_SOURCE_KEY",
        "The object is outside the permitted Prepaid prefix.",
      );
  }
  async put(key: string, body: Uint8Array, contentType: string) {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        IfNoneMatch: "*",
        ChecksumSHA256: createHash("sha256").update(body).digest("base64"),
      }),
    );
    return { key, sha256: sha256(body), size: body.byteLength };
  }
  async json(key: string, prefix: string) {
    this.assertKey(key, prefix);
    const object = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if ((object.ContentLength ?? 0) > 2_000_000)
      throw new Error("Prepaid manifest exceeds 2 MB.");
    const body = await object.Body?.transformToString();
    if (!body || Buffer.byteLength(body) > 2_000_000)
      throw new Error("Invalid Prepaid manifest.");
    return JSON.parse(body) as unknown;
  }
  async *rows(key: string, prefix: string, checksum: string, count: number) {
    this.assertKey(key, prefix);
    const object = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!object.Body) throw new Error("Dataset object has no body.");
    const hash = createHash("sha256");
    let rows = 0;
    const stream = object.Body as Readable;
    stream.on("data", (chunk) => hash.update(chunk));
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        if (Buffer.byteLength(line) > 128_000)
          throw new Error("Dataset row exceeds 128 KB.");
        rows++;
        yield JSON.parse(line) as unknown;
      }
    } finally {
      lines.close();
      stream.destroy();
    }
    if (rows !== count || hash.digest("hex") !== checksum)
      throw new Error(
        "Dataset checksum or row count does not match its manifest.",
      );
  }
  async deliveredJournalKey(prefix: string, filename: string, startedAt: string, completedAt: string | null) {
    const start = Date.parse(startedAt);
    const end = completedAt ? Date.parse(completedAt) : Date.now();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
      throw Error("Invalid journal delivery window.");

    let match: string | undefined;
    let token: string | undefined;
    do {
      const page = await this.client.send(new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
        ContinuationToken: token,
      }));
      for (const object of page.Contents ?? []) {
        const key = object.Key;
        const timestamp = object.LastModified?.getTime();
        if (!key || timestamp == null || timestamp < start || timestamp > end)
          continue;
        const [folder, name, extra] = key.slice(prefix.length).split("/");
        if (!/^\d{8}[-_]\d{4}$/.test(folder) || name !== filename || extra !== undefined)
          continue;
        if (match) throw Error("Multiple delivered journals match this operation.");
        match = key;
      }
      token = page.NextContinuationToken;
    } while (token);
    if (!match) throw Error("No journal was found in the delivery archive.");
    return match;
  }
  async get(key: string, prefix: string) {
    this.assertKey(key, prefix);
    return this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }
  async bytes(key: string, prefix: string, maximumBytes: number) {
    const object = await this.get(key, prefix);
    if (!object.Body) throw Error("Source object has no body.");
    const stream = object.Body as Readable;
    const chunks: Buffer[] = [];
    let length = 0;
    try {
      if ((object.ContentLength ?? 0) > maximumBytes)
        throw Error("Source object exceeds the byte limit.");
      for await (const chunk of stream) {
        const bytes = Buffer.from(chunk);
        length += bytes.length;
        if (length > maximumBytes)
          throw Error("Source object exceeds the byte limit.");
        chunks.push(bytes);
      }
      return Buffer.concat(chunks, length);
    } finally {
      stream.destroy();
    }
  }
}
export const createPrepaidStorage = (config: Config) =>
  new PrepaidStorage(
    new S3Client(createAwsClientOptions(config)),
    config.S3_BUCKET,
  );
