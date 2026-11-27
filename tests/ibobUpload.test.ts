import { describe, expect, it } from "vitest";
import { matchesIbobUpload } from "../src/processingPipelineCatalog.js";

describe("ISMS IBOB source filenames", () => {
  it.each([
    [
      "ACT_ISMS_IB_OB_01.XLSX",
      "ISMS IB & OB ACTUALIZATION SUMMARY OF INVOICE 10222026.any",
    ],
    ["ACT_ISMS_IB_OB_02.XLSX", "summary of accrual ib and ob sap upload"],
    ["ACT_ISMS_IB_OB_01.XLSX", "act_isms_ib_ob_01.xlsx.xlsx"],
  ])("accepts %s mapping for %s", (expected, name) => {
    expect(matchesIbobUpload(expected, name)).toBe(true);
  });
  it("rejects a different source mapping", () => {
    expect(
      matchesIbobUpload(
        "ACT_ISMS_IB_OB_01.XLSX",
        "SUMMARY OF ACCRUAL IB and OB SAP UPLOAD.csv",
      ),
    ).toBe(false);
  });
});
