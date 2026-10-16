import { Readable } from "node:stream";
import { describe, it, expect, vi } from "vitest";
import {
  PrepaidStorage,
  sha256,
} from "../src/modules/prepaid/infrastructure/prepaidStorage.js";
import { PrepaidReferenceProvider } from "../src/modules/prepaid/application/referenceProvider.js";
const row = {
  MANDT: "300",
  BUKRS: "GLOB",
  HKONT: "123",
  BRAND: "GHP-PREPAID",
  WWBRD: "GP",
  WWSPA: "EG",
  WWST: "MT",
  SPB: "SUB",
  TAXRATE: "0.12",
  AVERATE: "10",
  DUOM: "EA",
};
describe("Verified legacy reference export provider", () => {
  const bytes = Buffer.from(JSON.stringify(row) + "\n");
  const send = vi.fn(async () => ({ Body: Readable.from([bytes]) }));
  const provider = new PrepaidReferenceProvider(
    new PrepaidStorage({ send } as any, "test-only"),
  );
  const descriptor = {
    key: "approved-reference/v1.jsonl",
    prefix: "approved-reference/",
    sha256: sha256(bytes),
    rowCount: 1,
  };
  it("reads exact bounded export bytes and retains legacy membership category", async () => {
    const result = await provider.load(descriptor, "2026-09");
    expect(result.rows[0]).toMatchObject({
      source_brand: "GHP-PREPAID",
      cost_element: "0000000123",
    });
    expect(result.report.sourceSha256).toBe(descriptor.sha256);
    expect(result.report.verifiedMappingSource).toBe(false);
  });
  it("rejects bad hash and row-count attestation", async () => {
    await expect(
      provider.load({ ...descriptor, sha256: "0".repeat(64) }, "2026-09"),
    ).rejects.toThrow("checksum");
    await expect(
      provider.load({ ...descriptor, rowCount: 2 }, "2026-09"),
    ).rejects.toThrow("row count");
  });
  it("rejects keys outside the approved prefix before reading", async () => {
    const count = send.mock.calls.length;
    await expect(
      provider.load({ ...descriptor, key: "elsewhere/v1.jsonl" }, "2026-09"),
    ).rejects.toThrow("prefix");
    expect(send.mock.calls.length).toBe(count);
  });
  it("enforces streamed byte limit even when content length is not provided", async () => {
    await expect(
      provider.storage.bytes(descriptor.key, descriptor.prefix, 1),
    ).rejects.toThrow("byte limit");
  });
});
