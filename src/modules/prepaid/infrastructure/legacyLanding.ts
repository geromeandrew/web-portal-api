import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import type { Logger } from "../../../platform/logger.js";
import { prepaidMaximumSourceBytes } from "../domain/limits.js";
import {
  sourceWorkflows,
  type SourceWorkflow,
} from "../domain/sourceExtraction.js";

export class SharedExtractionBusy extends Error {
  constructor(
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "SharedExtractionBusy";
  }
}
const missing = (e: any) =>
  e.name === "NoSuchKey" || e.$metadata?.httpStatusCode === 404;
const conflict = (e: any) => [409, 412].includes(e.$metadata?.httpStatusCode);
export interface LandingFile {
  name: string;
  bytes: Buffer;
  sha256: string;
  original?: { bytes: Buffer; sha256: string };
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
    releaseLock?: boolean,
  ): Promise<void>;
  release?(owner: string, onlyIfOwned?: boolean): Promise<void>;
}

/** Cross-database portal coordination. Never steal an orphaned lock: a timed-out
 * API response does not establish that the AWS execution stopped. Session originals
 * are never deleted; only byte-verified, owned disposable inbound copies are removed.
 * Matching unmanaged inputs can be reused without portal overwrite/delete; the
 * unchanged native Glue job may consume/move them through its normal success path.
 * External producers must also honor this lock (or use a separate input folder).
 */
export class LegacyLanding implements SourceLanding {
  readonly prefix = "prepaid_reclass/inbound/";
  readonly lockKey = "prepaid_reclass/portal-coordination/extract.lock.json";
  constructor(
    private readonly client: Pick<S3Client, "send">,
    readonly bucket: string,
    private readonly logger?: Logger,
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
      const lock = await this.lock();
      if (lock?.owner !== owner)
        throw new SharedExtractionBusy(
          "Another extraction owns the shared input folder. Wait, or ask an operator to reconcile an abandoned execution; locks are never automatically stolen.",
          {
            bucket: this.bucket,
            key: this.lockKey,
            expectedOwner: owner,
            actualOwner: lock?.owner ?? null,
            reason: "coordination_lock_owned",
          },
        );
    }
  }
  async owns(owner: string) {
    return (await this.lock())?.owner === owner;
  }
  async assertOwner(owner: string) {
    const lock = await this.lock();
    if (lock?.owner !== owner)
      throw new SharedExtractionBusy(
        "Shared extraction lock ownership changed.",
        {
          bucket: this.bucket,
          key: this.lockKey,
          expectedOwner: owner,
          actualOwner: lock?.owner ?? null,
          reason: "coordination_lock_changed",
        },
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
  private async owned(
    owner: string,
    file: { name: string; sha256: string },
    allowUnmanaged = false,
  ) {
    try {
      const object = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: this.name(file.name),
        }),
      );
      const unmanaged =
        object.Metadata?.["portal-owner"] === undefined &&
        object.Metadata?.["portal-sha256"] === undefined;
      const owned =
        object.Metadata?.["portal-owner"] === owner &&
        object.Metadata?.["portal-sha256"] === file.sha256;
      if (
        (!owned && !(allowUnmanaged && unmanaged)) ||
        !object.ETag ||
        (object.ContentLength ?? 0) > prepaidMaximumSourceBytes
      ) {
        (object.Body as any)?.destroy?.();
        throw new SharedExtractionBusy(
          `Shared input ${file.name} is not owned by this extraction or has conflicting metadata; refusing overwrite/delete.`,
          {
            bucket: this.bucket,
            key: this.name(file.name),
            expectedOwner: owner,
            actualOwner: object.Metadata?.["portal-owner"] ?? null,
            reason: "ownership_or_metadata_conflict",
          },
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
        throw new SharedExtractionBusy(
          `Shared input ${file.name} differs from the uploaded file. An operator must reconcile it; it was not overwritten or deleted.`,
          {
            bucket: this.bucket,
            key: this.name(file.name),
            expectedOwner: owner,
            reason: "source_bytes_conflict",
          },
        );
      return { etag: object.ETag, owned };
    } catch (e) {
      if (missing(e)) return undefined;
      throw e;
    }
  }
  private async replaceVerifiedOriginal(
    owner: string,
    file: LandingFile,
    name: string,
  ) {
    const original = file.original;
    if (!original || !/^[A-Za-z0-9_-]{1,100}$/.test(owner))
      throw Error("Missing adaptation provenance.");
    const verified = await this.owned(
      owner,
      { name, sha256: original.sha256 },
      true,
    );
    if (!verified)
      throw new SharedExtractionBusy(
        "Original input disappeared during adaptation; retry safely.",
      );
    const backupKey = `prepaid_reclass/portal-coordination/input-backups/${owner}/${original.sha256}/${name}`;
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: backupKey,
          IfNoneMatch: "*",
          Body: original.bytes,
          Metadata: { "portal-owner": owner, "portal-sha256": original.sha256 },
          ChecksumSHA256: createHash("sha256")
            .update(original.bytes)
            .digest("base64"),
        }),
      );
    } catch (error) {
      if (!conflict(error)) throw error;
      const backup = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: backupKey }),
      );
      if (
        !backup.Body ||
        backup.Metadata?.["portal-owner"] !== owner ||
        backup.Metadata?.["portal-sha256"] !== original.sha256 ||
        (backup.ContentLength ?? 0) > prepaidMaximumSourceBytes
      ) {
        (backup.Body as any)?.destroy?.();
        throw Error("Invalid retained original input.");
      }
      const body = backup.Body as Readable;
      const digest = createHash("sha256");
      let length = 0;
      try {
        for await (const chunk of body) {
          length += chunk.length;
          if (length > prepaidMaximumSourceBytes)
            throw Error("Retained input exceeds byte limit.");
          digest.update(chunk);
        }
      } finally {
        body.destroy();
      }
      if (digest.digest("hex") !== original.sha256)
        throw Error("Retained original input checksum mismatch.");
    }
    await this.assertOwner(owner);
    // Conditional replacement is limited to a byte-proven original of THIS
    // upload. Retain it before replacing this disposable shared working copy.
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.name(name),
        IfMatch: verified.etag,
        Body: file.bytes,
        ContentType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        Metadata: {
          "portal-owner": owner,
          "portal-sha256": file.sha256,
          "portal-original-sha256": original.sha256,
          "portal-backup-key": backupKey,
        },
        ChecksumSHA256: createHash("sha256")
          .update(file.bytes)
          .digest("base64"),
      }),
    );
    this.logger?.info("prepaid.landing.adapted", {
      extractionId: owner,
      key: this.name(name),
      backupKey,
      originalSha256: original.sha256,
      stagedSha256: file.sha256,
    });
  }
  async stage(owner: string, workflow: SourceWorkflow, files: LandingFile[]) {
    await this.assertOwner(owner);
    const names = new Map(files.map((f) => [f.name.toLowerCase(), f]));
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
          createHash("sha256").update(file.bytes).digest("hex") !==
            file.sha256 ||
          (file.original &&
            (!["callcard_eg", "load_up_eg"].includes(workflow) ||
              file.original.bytes.length > prepaidMaximumSourceBytes ||
              createHash("sha256").update(file.original.bytes).digest("hex") !==
                file.original.sha256)),
      )
    )
      throw Error(
        "Shared input bytes do not match the uploaded source checksum/size.",
      );
    let continuation: string | undefined;
    const existing = new Set<string>();
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
          const file = names.get(name.toLowerCase());
          if (!file || name.includes("/") || existing.has(name.toLowerCase()))
            throw new SharedExtractionBusy(
              "Foreign files match this Glue job's shared input pattern; refusing to process them.",
              {
                bucket: this.bucket,
                key: object.Key,
                reason: "unexpected_or_duplicate_input",
              },
            );
          let verified;
          try {
            verified = await this.owned(owner, { ...file, name }, true);
          } catch (error) {
            if (
              !file.original ||
              !(error instanceof SharedExtractionBusy) ||
              ![
                "source_bytes_conflict",
                "ownership_or_metadata_conflict",
              ].includes(String(error.details.reason))
            )
              throw error;
            await this.replaceVerifiedOriginal(owner, file, name);
            verified = await this.owned(owner, { ...file, name });
          }
          if (!verified)
            throw new SharedExtractionBusy(
              "Shared input changed during verification; retry after reconciliation.",
              {
                bucket: this.bucket,
                key: object.Key,
                reason: "input_disappeared",
              },
            );
          existing.add(name.toLowerCase());
          this.logger?.info("prepaid.landing.reused", {
            extractionId: owner,
            workflow,
            bucket: this.bucket,
            key: object.Key,
            disposition: verified.owned
              ? "owned_copy"
              : "verified_existing_input",
          });
        }
      }
      if (page.IsTruncated && !page.NextContinuationToken)
        throw Error("Incomplete shared input listing.");
      continuation = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuation);
    for (const file of files) {
      await this.assertOwner(owner);
      // Native Glue consumes the existing shared input. Exact-byte unmanaged
      // files can be read in place, but the portal never claims/deletes them.
      // Reject another portal owner's objects even when their bytes match.
      if (existing.has(file.name.toLowerCase())) continue;
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
        // A file appeared after listing. Never replace this race winner: retry
        // the full inventory and ownership check instead.
        if (!(await this.owned(owner, file, true))) throw e;
      }
    }
  }
  async finish(
    owner: string,
    _workflow: SourceWorkflow,
    files: { name: string; sha256: string }[],
    releaseLock = true,
  ) {
    await this.assertOwner(owner);
    const actualNames = new Map<string, string>();
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
        if (
          !files.some((file) => file.name.toLowerCase() === name.toLowerCase())
        )
          continue;
        if (actualNames.has(name.toLowerCase()))
          throw new SharedExtractionBusy(
            "Duplicate case-insensitive inputs prevent safe cleanup.",
            { key: object.Key, reason: "duplicate_cleanup_input" },
          );
        actualNames.set(name.toLowerCase(), name);
      }
      if (page.IsTruncated && !page.NextContinuationToken)
        throw Error("Incomplete shared input listing.");
      continuation = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuation);
    for (const file of files) {
      const actualName = actualNames.get(file.name.toLowerCase());
      if (!actualName) continue;
      const verified = await this.owned(
        owner,
        { ...file, name: actualName },
        true,
      );
      if (verified?.owned)
        await this.client.send(
          new DeleteObjectCommand({
            Bucket: this.bucket,
            Key: this.name(actualName),
            IfMatch: verified.etag,
          }),
        );
    }
    if (releaseLock) await this.release(owner);
  }
  /** Idempotent release for a reference-only operation; never remove inbound files. */
  async release(owner: string, onlyIfOwned = false) {
    const lock = await this.lock();
    if (!lock) return;
    if (lock.owner !== owner) {
      if (onlyIfOwned) return;
      throw new SharedExtractionBusy(
        "Shared extraction lock is owned by another operation; refusing release.",
      );
    }
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: this.lockKey,
        IfMatch: lock.etag,
      }),
    );
  }
}
