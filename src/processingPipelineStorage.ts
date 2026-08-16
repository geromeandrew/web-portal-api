import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { Config } from "./config.js";
import { matchesProcessingPipelineRequirement, type ProcessingPipelineFileRequirement } from "./processingPipelineCatalog.js";

export type ProcessingPipelineFile = { key: string; name: string; size: number; lastModified: string | null };
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
  constructor(private readonly client: S3Sender, private readonly bucket: string) {}

  private prefix(pipelineCode: string) { return `${pipelineCode}/`; }

  async listFiles(pipelineCode: string, cursor?: string) {
    const prefix = this.prefix(pipelineCode);
    const page = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: cursor, MaxKeys: 500 }));
    const files = (page.Contents ?? []).filter((object) => object.Key && object.Key !== prefix && !object.Key.endsWith("/")).map((object): ProcessingPipelineFile => ({ key: object.Key!, name: object.Key!.slice(prefix.length), size: object.Size ?? 0, lastModified: object.LastModified?.toISOString() ?? null }));
    return { files, ...(page.IsTruncated && page.NextContinuationToken ? { nextCursor: page.NextContinuationToken } : {}) };
  }

  async listAllFiles(pipelineCode: string) {
    const files: ProcessingPipelineFile[] = []; let cursor: string | undefined;
    do { const page = await this.listFiles(pipelineCode, cursor); files.push(...page.files); cursor = page.nextCursor; } while (cursor);
    return files;
  }

  async listExpectedFiles(pipelineCode: string, requirements: readonly ProcessingPipelineFileRequirement[]): Promise<ProcessingPipelineExpectedFile[]> {
    const files = await this.listAllFiles(pipelineCode);
    return requirements.flatMap<ProcessingPipelineExpectedFile>((requirement, requirementIndex) => {
      const matches = files.filter((file) => matchesProcessingPipelineRequirement(requirement, file.name)).sort((left, right) => left.name.localeCompare(right.name));
      if (!matches.length) return [{ id: `${requirementIndex}:missing`, expectedFileName: requirement.fileName, matchedFileName: null, legacyPackageName: requirement.legacyPackageName, jobName: requirement.jobName, availability: "missing" as const, key: null, size: null, lastModified: null }];
      return matches.map((file, matchIndex) => ({ id: `${requirementIndex}:${matchIndex}:${file.key}`, expectedFileName: requirement.fileName, matchedFileName: file.name, legacyPackageName: requirement.legacyPackageName, jobName: requirement.jobName, availability: "present" as const, key: file.key, size: file.size, lastModified: file.lastModified }));
    });
  }

  async getFile(pipelineCode: string, key: string) {
    const prefix = this.prefix(pipelineCode);
    if (!key.startsWith(prefix) || key === prefix || key.endsWith("/")) throw new Error("Requested key is outside the selected processing pipeline folder.");
    return this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async fileExists(pipelineCode: string, key: string) {
    const prefix = this.prefix(pipelineCode);
    if (!key.startsWith(prefix) || key === prefix || key.endsWith("/")) throw new Error("Requested key is outside the selected processing pipeline folder.");
    try { await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key })); return true; }
    catch (error) { const name = error && typeof error === "object" && "name" in error ? String(error.name) : ""; if (name === "NotFound" || name === "NoSuchKey" || name === "NoSuchBucket") return false; throw error; }
  }

  async uploadFile(pipelineCode: string, name: string, body: Uint8Array, contentType: string) {
    const key = `${this.prefix(pipelineCode)}${name}`;
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
    return { key, name, size: body.byteLength };
  }
}

export function createProcessingPipelineStorage(config: Config) { return new ProcessingPipelineStorage(new S3Client({ region: config.AWS_REGION }), config.S3_BUCKET); }
