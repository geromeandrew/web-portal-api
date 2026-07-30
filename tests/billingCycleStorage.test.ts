import { GetObjectCommand, ListObjectsV2Command, type S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import { BillingCycleStorage } from "../src/billingCycleStorage.js";

function createStorage(send = vi.fn()) {
  return { send, storage: new BillingCycleStorage({ send } as unknown as Pick<S3Client, "send">, "billing-cycle-files") };
}

describe("BillingCycleStorage", () => {
  it("discovers and sorts only first-level pipeline folders", async () => {
    const { send, storage } = createStorage();
    send.mockResolvedValueOnce({ CommonPrefixes: [{ Prefix: "zeta/" }, { Prefix: "alpha/" }], IsTruncated: true, NextContinuationToken: "next" });
    send.mockResolvedValueOnce({ CommonPrefixes: [{ Prefix: "beta/" }] });

    await expect(storage.listPipelines()).resolves.toEqual(["alpha", "beta", "zeta"]);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][0]).toBeInstanceOf(ListObjectsV2Command);
    expect((send.mock.calls[0][0] as { input: unknown }).input).toMatchObject({ Bucket: "billing-cycle-files", Delimiter: "/" });
    expect((send.mock.calls[1][0] as { input: unknown }).input).toMatchObject({ ContinuationToken: "next" });
  });

  it("lists files beneath the selected status prefix and ignores folder markers", async () => {
    const { send, storage } = createStorage();
    send.mockResolvedValue({
      Contents: [
        { Key: "pipeline-a/inbound/", Size: 0 },
        { Key: "pipeline-a/inbound/nested/report.csv", Size: 1240, LastModified: new Date("2026-07-29T02:00:00Z") },
      ],
      IsTruncated: true,
      NextContinuationToken: "cursor-2",
    });

    await expect(storage.listFiles("pipeline-a", "inbound")).resolves.toEqual({ files: [{ key: "pipeline-a/inbound/nested/report.csv", name: "nested/report.csv", size: 1240, lastModified: "2026-07-29T02:00:00.000Z" }], nextCursor: "cursor-2" });
    expect((send.mock.calls[0][0] as { input: unknown }).input).toMatchObject({ Bucket: "billing-cycle-files", Prefix: "pipeline-a/inbound/", MaxKeys: 500 });
  });

  it("rejects object keys outside the selected pipeline and status", async () => {
    const { storage } = createStorage();
    await expect(storage.getFile("pipeline-a", "processed", "pipeline-a/error/report.csv")).rejects.toThrow("outside the selected Billing Cycle folder");
  });

  it("requests an allowed object from the configured bucket", async () => {
    const { send, storage } = createStorage();
    send.mockResolvedValue({ Body: {} });
    await storage.getFile("pipeline-a", "processed", "pipeline-a/processed/report.csv");
    expect(send.mock.calls[0][0]).toBeInstanceOf(GetObjectCommand);
    expect((send.mock.calls[0][0] as { input: unknown }).input).toMatchObject({ Bucket: "billing-cycle-files", Key: "pipeline-a/processed/report.csv" });
  });
});
