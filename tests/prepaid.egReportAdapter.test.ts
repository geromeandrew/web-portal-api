import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { BackendSourceNormalizer } from "../src/modules/prepaid/infrastructure/sourceNormalizer.js";
import { egReportMappingSchema } from "../src/modules/prepaid/domain/sourceExtraction.js";
import { approvedProvidedEgReportMapping } from "../src/modules/prepaid/domain/builtinConfiguration.js";
const mapping = egReportMappingSchema.parse({
  profile: "provided-eg-reports-v1",
  approved: true,
  callcardScope: "eg_report",
  loadupAmount: "gross",
});
async function workbook(rows: unknown[][]) {
  const book = new ExcelJS.Workbook();
  book.addWorksheet("Source").addRows(rows);
  return Buffer.from(await book.xlsx.writeBuffer());
}
describe("EG report mapping through the actual backend Python boundary", () => {
  it("uses the approved VAT-inclusive NET TOP UP amount, without removing VAT twice", async () => {
    const input = await workbook([
      ["summary"],
      [],
      [],
      [],
      ["CFU", "Transaction ID", "GROSS", "VAT", "NET TOP UP"],
      ["EG", "TEST-APPROVED", "31250.00", "3750.00", "35000.00"],
      ["SG", "TEST-OTHER-REGION", "12500.00", "1500.00", "14000.00"],
    ]);
    const normalizer = new BackendSourceNormalizer();
    const prepared = await normalizer.prepare(
      "load_up_eg",
      "load_up_eg",
      input,
      undefined,
      approvedProvidedEgReportMapping,
    );
    expect(prepared.datasets.loadup).toEqual([
      { region: "eg", amount: "35000.00" },
    ]);
    expect(
      await normalizer.normalize("load_up_eg", "load_up_eg", prepared.landing!),
    ).toEqual(prepared.datasets);
    const native = new ExcelJS.Workbook();
    await native.xlsx.load(prepared.landing! as any);
    expect(native.worksheets[0].getCell("J5").value).toBe("35000.00");
  }, 15000);
  it("has no implicit accounting approval or gross/net default", () => {
    expect(
      egReportMappingSchema.safeParse({ ...mapping, approved: false }).success,
    ).toBe(false);
    expect(
      egReportMappingSchema.parse({ profile: mapping.profile, approved: true })
        .loadupAmount,
    ).toBeUndefined();
  });
  it("creates a deterministic native copy preserving per-record Call Card amounts", async () => {
    const input = await workbook([
      ["Company Code", "Customer", "SO Number", "Gross Amount"],
      ["GLOB", "TEST", "SO-1", "1.50"],
      ["GLOB", "TEST", "SO-2", "1.50"],
    ]);
    const normalizer = new BackendSourceNormalizer();
    await expect(
      normalizer.prepare("callcard_eg", "callcard_eg", input, "2023-09"),
    ).rejects.toThrow("egReportMapping.callcardScope");
    const a = await normalizer.prepare(
      "callcard_eg",
      "callcard_eg",
      input,
      "2023-09",
      mapping,
    );
    const b = await normalizer.prepare(
      "callcard_eg",
      "callcard_eg",
      input,
      "2023-09",
      mapping,
    );
    expect(a.landing).toEqual(b.landing);
    const staged = await normalizer.prepare(
      "callcard_eg", "callcard_eg", input, undefined, mapping, true,
    );
    expect(staged.landing).toEqual(a.landing);
    expect(staged.datasets.callcard).toEqual(["1.50", "1.50"]);
    await expect(normalizer.prepare("callcard_eg", "callcard_eg", input, undefined, mapping))
      .rejects.toThrow("requires the verified KE24 period");
    expect(a.datasets.callcard).toHaveLength(2);
    expect((a.datasets.callcard[0] as any).amount).toBe("1.50");
    expect(
      await normalizer.normalize(
        "callcard_eg",
        "callcard_eg",
        a.landing!,
        "2023-09",
      ),
    ).toEqual(a.datasets);
    const native = new ExcelJS.Workbook();
    await native.xlsx.load(a.landing! as any);
    expect(native.worksheets[0].getCell("C1").value).toBe("business");
    expect(native.worksheets[0].getCell("I2").value).toBe("1.50");
  }, 20000);
  it.each(["gross", "net_top_up"] as const)(
    "uses only the explicitly selected %s field",
    async (loadupAmount) => {
      const input = await workbook([
        ["summary"],
        [],
        [],
        [],
        ["CFU", "Transaction ID", "GROSS", "NET TOP UP"],
        ["EG", "TEST-1", "112.00", "100.00"],
        ["SG", "TEST-2", "224.00", "200.00"],
      ]);
      const normalizer = new BackendSourceNormalizer();
      const result = await normalizer.prepare(
        "load_up_eg",
        "load_up_eg",
        input,
        undefined,
        { ...mapping, loadupAmount },
      );
      expect(result.datasets.loadup).toEqual([
        {
          region: "eg",
          amount: loadupAmount === "gross" ? "112.00" : "100.00",
        },
      ]);
      expect(
        await normalizer.normalize("load_up_eg", "load_up_eg", result.landing!),
      ).toEqual(result.datasets);
    },
    15000,
  );
});
