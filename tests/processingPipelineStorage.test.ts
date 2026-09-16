import {
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import { ProcessingPipelineStorage } from "../src/processingPipelineStorage.js";

describe("ProcessingPipelineStorage", () => {
  it("uses the selected pipeline inbound folder as the S3 prefix", async () => {
    const send = vi.fn().mockResolvedValue({});
    const storage = new ProcessingPipelineStorage(
      { send } as unknown as Pick<S3Client, "send">,
      "pipeline-files",
    );
    await storage.fileExists(
      "prepaid_reclass",
      "prepaid_reclass/inbound/source.xlsx",
    );
    expect(send.mock.calls[0][0]).toBeInstanceOf(HeadObjectCommand);
  });
  it("lists and uploads files in the pipeline inbound folder", async () => {
    const send = vi.fn().mockResolvedValue({
      Contents: [
        {
          Key: "prepaid_reclass/inbound/source.xlsx",
          Size: 1,
          LastModified: new Date("2026-08-20T00:00:00.000Z"),
        },
      ],
    });
    const storage = new ProcessingPipelineStorage(
      { send } as unknown as Pick<S3Client, "send">,
      "pipeline-files",
    );

    const listed = await storage.listFiles("prepaid_reclass");
    await storage.uploadFile(
      "prepaid_reclass",
      "source.xlsx",
      new Uint8Array([1]),
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );

    expect(send.mock.calls[0][0]).toBeInstanceOf(ListObjectsV2Command);
    expect(send.mock.calls[0][0].input.Prefix).toBe("prepaid_reclass/inbound/");
    expect(listed.files).toEqual([
      {
        key: "prepaid_reclass/inbound/source.xlsx",
        name: "source.xlsx",
        size: 1,
        lastModified: "2026-08-20T00:00:00.000Z",
      },
    ]);
    expect(send.mock.calls[1][0]).toBeInstanceOf(PutObjectCommand);
    expect(send.mock.calls[1][0].input.Key).toBe(
      "prepaid_reclass/inbound/source.xlsx",
    );
  });
  it("rejects object keys outside the selected pipeline", async () => {
    const storage = new ProcessingPipelineStorage(
      { send: vi.fn() } as unknown as Pick<S3Client, "send">,
      "pipeline-files",
    );
    await expect(storage.getFile("alpha", "beta/report.csv")).rejects.toThrow(
      "processing pipeline folder",
    );
  });
  it("rejects root-level keys in the selected pipeline", async () => {
    const storage = new ProcessingPipelineStorage(
      { send: vi.fn() } as unknown as Pick<S3Client, "send">,
      "pipeline-files",
    );
    await expect(storage.getFile("alpha", "alpha/report.csv")).rejects.toThrow(
      "processing pipeline folder",
    );
  });
});
