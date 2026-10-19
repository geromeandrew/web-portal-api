import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import { prepaidMaximumSourceBytes } from "../domain/limits.js";
import {
  sourceWorkflows,
  type SourceWorkflow,
} from "../domain/sourceExtraction.js";

export class SharedExtractionBusy extends Error {}
const missing = (e: any) =>
  e.name === "NoSuchKey" || e.$metadata?.httpStatusCode === 404;
const conflict = (e: any) => [409, 412].includes(e.$metadata?.httpStatusCode);
export interface LandingFile {
  name: string;
  bytes: Buffer;
  sha256: string;
}
export interface SourceLanding {
  acquire(owner: string): Promise<void>;
  stage(
    owner: string,
    workflow: SourceWorkflow,
    files: LandingFile[],
  ): Promise<void>;
  finish(
    owner: string,
    workflow: SourceWorkflow,
    files: { name: string; sha256: string }[],
  ): Promise<void>;
}

/** Cross-database portal coordination. Never steal an orphaned lock: a timed-out
 * API response does not establish that the AWS execution stopped. Originals are
 * never deleted; only byte-verified, owned disposable inbound copies are removed.
 * External producers must also honor this lock (or use a separate input folder).
 */
export class LegacyLanding implements SourceLanding {
  readonly prefix = "prepaid_reclass/inbound/";
  readonly lockKey = "prepaid_reclass/portal-coordination/extract.lock.json";
  constructor(
    private readonly client: Pick<S3Client, "send">,
    readonly bucket: string,
  ) {}
  private async lock() {
    try {
      const object = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.lockKey }),
      );
      if ((object.ContentLength ?? 0) > 4096) {
        (object.Body as any)?.destroy?.();
        throw Error("Invalid extraction coordination lock.");
      }
      const text = await object.Body?.transformToString();
      if (!text || text.length > 4096 || !object.ETag)
        throw Error("Invalid extraction coordination lock.");
      return { owner: JSON.parse(text).owner, etag: object.ETag };
    } catch (e) {
      if (missing(e)) return undefined;
      throw e;
    }
  }
  async acquire(owner: string) {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.lockKey,
          IfNoneMatch: "*",
          Body: JSON.stringify({ owner }),
          ContentType: "application/json",
        }),
      );
    } catch (e) {
      if (!conflict(e)) throw e;
      if ((await this.lock())?.owner !== owner)
        throw new SharedExtractionBusy(
          "Another extraction owns the shared input folder. Wait, or ask an operator to reconcile an abandoned execution; locks are never automatically stolen.",
        );
    }
  }
  private async assertOwner(owner: string) {
    const lock = await this.lock();
    if (lock?.owner !== owner)
      throw new SharedExtractionBusy(
        "Shared extraction lock ownership changed.",
      );
    return lock;
  }
  private name(name: string) {
    if (
      !name ||
      name.includes("/") ||
      name.includes("\\") ||
      name.includes("..")
    )
      throw Error("Unsafe shared input filename.");
    return this.prefix + name;
  }
  private async owned(owner: string, file: { name: string; sha256: string }) {
    try {
      const object = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: this.name(file.name),
        }),
      );
      if (
        object.Metadata?.["portal-owner"] !== owner ||
        object.Metadata?.["portal-sha256"] !== file.sha256 ||
        !object.ETag ||
        (object.ContentLength ?? 0) > prepaidMaximumSourceBytes
      ) {
        (object.Body as any)?.destroy?.();
        throw new SharedExtractionBusy(
          "A shared input object is not owned by this extraction; refusing overwrite/delete.",
        );
      }
      const body = object.Body as Readable | undefined;
      if (!body) throw Error("Shared input object has no body.");
      const digest = createHash("sha256");
      let length = 0;
      try {
        for await (const chunk of body) {
          const bytes = Buffer.from(chunk);
          length += bytes.length;
          if (length > prepaidMaximumSourceBytes)
            throw Error("Shared input exceeds the source byte limit.");
          digest.update(bytes);
        }
      } finally {
        body.destroy();
      }
      if (digest.digest("hex") !== file.sha256)
        throw Error("Shared input checksum differs from the uploaded source.");
      return object.ETag;
    } catch (e) {
      if (missing(e)) return undefined;
      throw e;
    }
  }
  async stage(owner: string, workflow: SourceWorkflow, files: LandingFile[]) {
    await this.assertOwner(owner);
    const names = new Map(files.map((f) => [f.name, f]));
    if (names.size !== files.length)
      throw Error("Duplicate shared input filenames.");
    const pattern = sourceWorkflows[workflow].inputPattern;
    const matches = (name: string) => {
      const [prefix, suffix] = pattern.toLowerCase().split("**");
      return suffix === undefined
        ? name.toLowerCase() === prefix
        : name.toLowerCase().startsWith(prefix) &&
            name.toLowerCase().endsWith(suffix);
    };
    if (!files.length || files.some((f) => !matches(f.name)))
      throw Error(
        "Source filename does not match the existing Glue input contract.",
      );
    if (
      files.some(
        (file) =>
          file.bytes.length > prepaidMaximumSourceBytes ||
          createHash("sha256").update(file.bytes).digest("hex") !== file.sha256,
      )
    )
      throw Error(
        "Shared input bytes do not match the uploaded source checksum/size.",
      );
    let continuation: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: this.prefix,
          ContinuationToken: continuation,
        }),
      );
      for (const object of page.Contents ?? []) {
        const name = object.Key?.slice(this.prefix.length) ?? "";
        // The existing wildcard Glue script matches os.path.basename() even
        // for nested keys. Those must be treated as conflicts too.
        if (matches(name.split("/").at(-1) ?? "")) {
          const file = names.get(name);
          if (!file)
            throw new SharedExtractionBusy(
              "Foreign files match this Glue job's shared input pattern; refusing to process them.",
            );
          await this.owned(owner, file);
        }
      }
      if (page.IsTruncated && !page.NextContinuationToken)
        throw Error("Incomplete shared input listing.");
      continuation = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuation);
    for (const file of files) {
      await this.assertOwner(owner);
      try {
        await this.client.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: this.name(file.name),
            Body: file.bytes,
            IfNoneMatch: "*",
            Metadata: { "portal-owner": owner, "portal-sha256": file.sha256 },
            ChecksumSHA256: createHash("sha256")
              .update(file.bytes)
              .digest("base64"),
            ContentType:
              sourceWorkflows[workflow].format === "csv"
                ? "text/csv"
                : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          }),
        );
      } catch (e) {
        if (!conflict(e)) throw e;
        if (!(await this.owned(owner, file))) throw e;
      }
    }
  }
  async finish(
    owner: string,
    _workflow: SourceWorkflow,
    files: { name: string; sha256: string }[],
  ) {
    await this.assertOwner(owner);
    for (const file of files) {
      const etag = await this.owned(owner, file);
      if (etag)
        await this.client.send(
          new DeleteObjectCommand({
            Bucket: this.bucket,
            Key: this.name(file.name),
            IfMatch: etag,
          }),
        );
    }
    await this.release(owner);
  }
  /** Idempotent release for a reference-only operation; never remove inbound files. */
  async release(owner: string) {
    const lock = await this.lock();
    if (!lock) return;
    if (lock.owner !== owner)
      throw new SharedExtractionBusy(
        "Shared extraction lock is owned by another operation; refusing release.",
      );
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: this.lockKey,
        IfMatch: lock.etag,
      }),
    );
  }
}
