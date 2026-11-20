import { describe, expect, it } from "vitest";
import { assessReferenceCoverage } from "../src/modules/prepaid/domain/referenceCoverage.js";
const used = {
  cost_element: "123",
  brand: "GP",
  cfu: "SG",
  revenue_type: "BB",
  sub_product: "SUB",
  amount: "10",
  absolute_activity: "10",
  source_entries: "1",
};
const row = {
  period: "2023-09",
  client: "300" as const,
  company: "GLOB" as const,
  cost_element: "123",
  brand: "GP",
  cfu: "CB",
  revenue_type: "BB",
  sub_product: "SUB",
  tax_rate: "0.12",
  average_rate: "10",
  uom: "EA",
  posting_key: "40",
};
describe("Reference repair assessment", () => {
  it("uses the legacy posting-key fallback without guessing account or sub-product mappings", () => {
    expect(assessReferenceCoverage([used], [row])).toMatchObject({
      complete: true,
      missing: [],
    });
    expect(
      assessReferenceCoverage([{ ...used, cost_element: "999" }], [row])
        .missing,
    ).toHaveLength(1);
  });
  it("preserves conflicting fallback rates for different posting keys", () => {
    const report = assessReferenceCoverage(
      [used],
      [row, { ...row, cfu: "SG", posting_key: "50", tax_rate: "0.10" }],
    );
    expect(report.ambiguous).toHaveLength(1);
    expect(report.complete).toBe(false);
  });
  it("recognizes equivalent decimals and key casing without floating-point rounding", () => {
    expect(
      assessReferenceCoverage(
        [{ ...used, sub_product: "sub" }],
        [row, { ...row, tax_rate: "0.120000", average_rate: "10.0000" }],
      ).complete,
    ).toBe(true);
  });
  it("does not approve zero rates or an old snapshot that dropped posting keys", () => {
    expect(
      assessReferenceCoverage([used], [{ ...row, average_rate: "0.000" }])
        .zeroRates,
    ).toHaveLength(1);
    expect(
      assessReferenceCoverage([used], [{ ...row, posting_key: undefined }])
        .complete,
    ).toBe(false);
  });
  it("accepts explicit legacy rate handling without hiding diagnostics or permitting missing keys", () => {
    const references = [row, { ...row, average_rate: "0" }];
    const report = assessReferenceCoverage(
      [used],
      references,
      "legacy_all_matches",
    );
    expect(report.complete).toBe(true);
    expect(report.ambiguous).toHaveLength(1);
    expect(report.zeroRates).toHaveLength(1);
    expect(assessReferenceCoverage([used], references).complete).toBe(false);
    expect(
      assessReferenceCoverage(
        [{ ...used, sub_product: "ABSENT" }],
        references,
        "legacy_all_matches",
      ).complete,
    ).toBe(false);
    expect(
      assessReferenceCoverage(
        [used],
        [{ ...row, posting_key: undefined }],
        "legacy_all_matches",
      ).complete,
    ).toBe(false);
  });
});
