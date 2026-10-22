import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createAwsClientOptions } from "./aws.js";
import type { Config } from "./config.js";
import {
  createProcessingPipelineFileMatcher,
  type ProcessingPipelineFileRequirement,
} from "./processingPipelineCatalog.js";

export type ProcessingPipelineFile = {
  key: string;
  name: string;
  size: number;
  lastModified: string | null;
};
export type ProcessingPipelineExpectedFile = {
  id: string;
  expectedFileName: string;
  matchedFileName: string | null;
  legacyPackageName: string | null;
  jobName: string | null;
  availability: "present" | "missing";
  key: string | null;
  size: number | null;
  lastModified: string | null;
};
type S3Sender = Pick<S3Client, "send">;

export class ProcessingPipelineStorage {
  constructor(
    private readonly client: S3Sender,
    private readonly bucket: string,
  ) {}

  inboundPrefix(pipelineCode: string) {
    // Public pipeline identifiers are stable; storage folder names can differ.
    const folder =
      pipelineCode === "isms_ibob_actzn"
        ? "isms_ibob_actualization"
        : pipelineCode;
    return `${folder}/inbound/`;
  }

  fileKey(pipelineCode: string, name: string) {
    return `${this.inboundPrefix(pipelineCode)}${name}`;
  }

  inboundFileName(pipelineCode: string, key: string) {
    // Historical IBOB keys remain readable/removable; new writes and listings
    // always use the corrected folder. Never move or overwrite existing data.
    const prefixes = [this.inboundPrefix(pipelineCode)];
    if (pipelineCode === "isms_ibob_actzn")
      prefixes.push("isms_ibob_actzn/inbound/");
    const prefix = prefixes.find((candidate) => key.startsWith(candidate));
    return prefix && key !== prefix && !key.endsWith("/")
      ? key.slice(prefix.length)
      : null;
  }

  async listFiles(pipelineCode: string, cursor?: string) {
    const prefix = this.inboundPrefix(pipelineCode);
    const page = await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
        ContinuationToken: cursor,
        MaxKeys: 500,
      }),
    );
    const files = (page.Contents ?? [])
      .filter(
        (object) =>
          object.Key && object.Key !== prefix && !object.Key.endsWith("/"),
      )
      .map((object): ProcessingPipelineFile => ({
        key: object.Key!,
        name: object.Key!.slice(prefix.length),
        size: object.Size ?? 0,
        lastModified: object.LastModified?.toISOString() ?? null,
      }));
    return {
      files,
      ...(page.IsTruncated && page.NextContinuationToken
        ? { nextCursor: page.NextContinuationToken }
        : {}),
    };
  }

  async listAllFiles(pipelineCode: string) {
    const files: ProcessingPipelineFile[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.listFiles(pipelineCode, cursor);
      files.push(...page.files);
      cursor = page.nextCursor;
    } while (cursor);
    return files;
  }

  async listExpectedFiles(
    pipelineCode: string,
    requirements: readonly ProcessingPipelineFileRequirement[],
  ): Promise<ProcessingPipelineExpectedFile[]> {
    const files = await this.listAllFiles(pipelineCode);
    return requirements.flatMap<ProcessingPipelineExpectedFile>(
      (requirement, requirementIndex) => {
        const matchesRequirement =
          createProcessingPipelineFileMatcher(requirement);
        const matches = files
          .filter((file) => matchesRequirement(file.name))
          .sort((left, right) => left.name.localeCompare(right.name));
        if (!matches.length)
          return [
            {
              id: `${requirementIndex}:missing`,
              expectedFileName: requirement.fileName,
              matchedFileName: null,
              legacyPackageName: requirement.legacyPackageName,
              jobName: requirement.jobName,
              availability: "missing" as const,
              key: null,
              size: null,
              lastModified: null,
            },
          ];
        return matches.map((file, matchIndex) => ({
          id: `${requirementIndex}:${matchIndex}:${file.key}`,
          expectedFileName: requirement.fileName,
          matchedFileName: file.name,
          legacyPackageName: requirement.legacyPackageName,
          jobName: requirement.jobName,
          availability: "present" as const,
          key: file.key,
          size: file.size,
          lastModified: file.lastModified,
        }));
      },
    );
  }

  async getFile(pipelineCode: string, key: string) {
    if (!this.inboundFileName(pipelineCode, key))
      throw new Error(
        "Requested key is outside the selected processing pipeline folder.",
      );
    return this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  async fileExists(pipelineCode: string, key: string) {
    if (!this.inboundFileName(pipelineCode, key))
      throw new Error(
        "Requested key is outside the selected processing pipeline folder.",
      );
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return true;
    } catch (error) {
      const name =
        error && typeof error === "object" && "name" in error
          ? String(error.name)
          : "";
      if (
        name === "NotFound" ||
        name === "NoSuchKey" ||
        name === "NoSuchBucket"
      )
        return false;
      throw error;
    }
  }

  async deleteFile(pipelineCode: string, key: string) {
    if (!this.inboundFileName(pipelineCode, key))
      throw new Error(
        "Requested key is outside the selected processing pipeline folder.",
      );
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  async uploadFile(
    pipelineCode: string,
    name: string,
    body: Uint8Array,
    contentType: string,
  ) {
    const key = this.fileKey(pipelineCode, name);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
    return { key, name, size: body.byteLength };
  }
}

export function createProcessingPipelineStorage(config: Config) {
  return new ProcessingPipelineStorage(
    new S3Client(createAwsClientOptions(config)),
    config.S3_BUCKET,
  );
}
