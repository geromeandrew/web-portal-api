import { describe, it, expect } from "vitest";
import { convertLegacyReference } from "../src/modules/prepaid/domain/referenceConverter.js";
const row = {
  MANDT: "300",
  BUKRS: "GLOB",
  HKONT: "00123",
  BRAND: "GHP-PREPAID",
  WWBRD: "GP",
  WWSPA: "CM",
  WWST: "MT",
  SPB: "SUB",
  TAXRATE: "0.1200000000",
  AVERATE: "10.1234567890",
  DUOM: "EA",
  PSTKY: "50",
};
const bytes = (rows: unknown[]) =>
  Buffer.from(rows.map((r) => JSON.stringify(r)).join("\r\n") + "\r\n");
describe("Legacy ZTF0455S reference conversion", () => {
  it("maps allocation WWBRD, retains exact decimal/identifier values and original evidence", () => {
    const output = convertLegacyReference(bytes([row]), "2026-09");
    expect(output.rows[0]).toMatchObject({
      brand: "GP",
      source_brand: "GHP-PREPAID",
      cost_element: "0000000123",
      tax_rate: row.TAXRATE,
      average_rate: row.AVERATE,
      period: "2026-09",
    });
    expect(output.provenance[0].source).toEqual(row);
    expect(output.report).toMatchObject({
      inputRows: 1,
      rowCount: 1,
      verifiedMappingSource: false,
    });
    expect(output.report.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it("selects client 300 without inventing a period", () => {
    expect(
      convertLegacyReference(bytes([{ ...row, MANDT: "100" }, row]), "2026-09")
        .report.skippedClientRows,
    ).toBe(1);
    expect(() => convertLegacyReference(bytes([row]), "2026-13")).toThrow();
  });
  it.each([
    { ...row, HKONT: 123 },
    { ...row, TAXRATE: 0.12 },
    { ...row, TAXRATE: "12" },
    { ...row, AVERATE: "-1" },
    { ...row, BUKRS: "OTHER" },
    { ...row, SPB: "" },
  ])("rejects invalid and lossy rows", (invalid) => {
    expect(() => convertLegacyReference(bytes([invalid]), "2026-09")).toThrow(
      "Reference line 1",
    );
  });
  it("rejects empty, invalid UTF8 and malformed JSON", () => {
    expect(() => convertLegacyReference(bytes([]), "2026-09")).toThrow(
      "No client-300",
    );
    expect(() =>
      convertLegacyReference(Buffer.from([255]), "2026-09"),
    ).toThrow();
    expect(() =>
      convertLegacyReference(Buffer.from("{}\ninvalid"), "2026-09"),
    ).toThrow();
  });
});
