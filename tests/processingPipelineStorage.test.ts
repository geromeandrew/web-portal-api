import { HeadObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import { ProcessingPipelineStorage } from "../src/processingPipelineStorage.js";

describe("ProcessingPipelineStorage", () => {
  it("uses the selected pipeline and stage as the S3 prefix", async () => {
    const send = vi.fn().mockResolvedValue({});
    const storage = new ProcessingPipelineStorage({ send } as unknown as Pick<S3Client, "send">, "pipeline-files");
    await storage.fileExists("prepaid_reclass", "inbound", "prepaid_reclass/inbound/source.xlsx");
    expect(send.mock.calls[0][0]).toBeInstanceOf(HeadObjectCommand);
  });
  it("rejects object keys outside the selected pipeline stage", async () => {
    const storage = new ProcessingPipelineStorage({ send: vi.fn() } as unknown as Pick<S3Client, "send">, "pipeline-files");
    await expect(storage.getFile("alpha", "processed", "alpha/error/report.csv")).rejects.toThrow("processing pipeline folder");
  });
});
