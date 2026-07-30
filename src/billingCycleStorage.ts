import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import type { Config } from "./config.js";

export const billingCycleStatuses = ["inbound", "outbound", "processed", "error"] as const;
export type BillingCycleStatus = (typeof billingCycleStatuses)[number];

export type BillingCycleFile = {
  key: string;
  name: string;
  size: number;
  lastModified: string | null;
};

type S3Sender = Pick<S3Client, "send">;

export class BillingCycleStorage {
  constructor(private readonly client: S3Sender, private readonly bucket: string) {}

  private prefix(pipelineName: string, status: BillingCycleStatus) {
    return `${pipelineName}/${status}/`;
  }

  async listPipelines() {
    const pipelines = new Set<string>();
    let continuationToken: string | undefined;
    do {
      const page = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Delimiter: "/", ContinuationToken: continuationToken }));
      for (const prefix of page.CommonPrefixes ?? []) {
        const name = prefix.Prefix?.replace(/\/$/, "");
        if (name) pipelines.add(name);
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);
    return [...pipelines].sort((left, right) => left.localeCompare(right));
  }

  async listFiles(pipelineName: string, status: BillingCycleStatus, cursor?: string) {
    const prefix = this.prefix(pipelineName, status);
    const page = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: cursor, MaxKeys: 500 }));
    const files = (page.Contents ?? [])
      .filter((object) => object.Key && object.Key !== prefix && !object.Key.endsWith("/"))
      .map((object): BillingCycleFile => ({
        key: object.Key!,
        name: object.Key!.slice(prefix.length),
        size: object.Size ?? 0,
        lastModified: object.LastModified?.toISOString() ?? null,
      }));
    return { files, ...(page.IsTruncated && page.NextContinuationToken ? { nextCursor: page.NextContinuationToken } : {}) };
  }

  async getFile(pipelineName: string, status: BillingCycleStatus, key: string) {
    const prefix = this.prefix(pipelineName, status);
    if (!key.startsWith(prefix) || key === prefix || key.endsWith("/")) throw new Error("Requested key is outside the selected Billing Cycle folder.");
    return this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

export function createBillingCycleStorage(config: Config) {
  return new BillingCycleStorage(new S3Client({ region: config.AWS_REGION }), config.S3_BUCKET);
}
