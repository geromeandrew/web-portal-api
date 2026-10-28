import { describe, expect, it } from "vitest";
import { planMemoUploads } from "../src/memoUpload.js";
import {
  matchesProcessingPipelineRequirement,
  processingPipelineSeedRequirements,
} from "../src/processingPipelineCatalog.js";

const requirements = processingPipelineSeedRequirements.filter(
  (file) => file.pipelineCode === "memo_sst",
);
const select = (
  originalName: string,
  expectedFileName = "3PComms_01.XLSX",
) => ({ originalName, expectedFileName });

describe("Memo upload numbering", () => {
  it("sorts YYYYMMDD sources by date and natural suffix independently for each mapped base", () => {
    const names = [
      "NewProponent_20261023_0128.xlsx",
      "NewProponent_20261023_0127.xlsx",
      "NewProponent_20261022_2359.xlsx.xlsx",
      "NewProponent_20270101_0000.xlsx",
    ];
    const plan = planMemoUploads(
      names.map((name) => select(name, "NewProponent_01.XLSX")),
      requirements,
      ["NewProponent_04.XLSX"],
    );
    expect(plan.map((file) => file.originalName)).toEqual([
      names[2],
      names[1],
      names[0],
      names[3],
    ]);
    expect(plan.map((file) => file.savedFileName)).toEqual([
      "NewProponent_05.XLSX",
      "NewProponent_06.XLSX",
      "NewProponent_07.XLSX",
      "NewProponent_08.XLSX",
    ]);
  });

  it("orders legacy and YYYYMMDD dates together before other suffixes", () => {
    const names = [
      "3PComms_revision2.xlsx",
      "3PComms_20261023_0127.xlsx",
      "3PComms_10232026.xlsx",
    ];
    expect(
      planMemoUploads(
        names.map((name) => select(name)),
        requirements,
      ).map((file) => file.originalName),
    ).toEqual([names[2], names[1], names[0]]);
    expect(
      planMemoUploads([select("3PComms_20240229_2359.xlsx")], requirements),
    ).toHaveLength(1);
  });

  it.each([
    "20260230_0127",
    "20250229_0127",
    "20261301_0127",
    "20260230_any_suffix",
    "20260230",
  ])("rejects an invalid YYYYMMDD date regardless of suffix: %s", (suffix) => {
    expect(() =>
      planMemoUploads([select(`3PComms_${suffix}.xlsx`)], requirements),
    ).toThrow("valid YYYYMMDD date");
  });

  it.each([
    "2400",
    "0160",
    "999999",
    "revision-A",
    "revision_2_final",
    "",
    undefined,
  ])(
    "accepts any suffix after the date without interpreting it as a time: %s",
    (suffix) => {
      const name = `NewProponent_20261023${suffix === undefined ? "" : `_${suffix}`}.xlsx`;
      expect(
        planMemoUploads(
          [select(name, "NewProponent_01.XLSX")],
          requirements,
        )[0],
      ).toEqual({
        ...select(name, "NewProponent_01.XLSX"),
        savedFileName: "NewProponent_01.XLSX",
      });
    },
  );

  it("rejects duplicate dated sources across case and hidden extensions", () => {
    expect(() =>
      planMemoUploads(
        [
          select("NewProponent_20261023_0127.xlsx", "NewProponent_01.XLSX"),
          select(
            "newproponent_20261023_0127.XLSX.xlsx",
            "NewProponent_01.XLSX",
          ),
        ],
        requirements,
      ),
    ).toThrow("Duplicate files");
  });

  it("continues after the highest inbound suffix per base without filling gaps", () => {
    const plan = planMemoUploads(
      [
        select("3PComms_01022027.xlsx"),
        select("3PComms_12312025.xlsx"),
        select("Dental_10272026.xlsx", "Dental_01.XLSX"),
      ],
      requirements,
      [
        "3PComms_01.XLSX",
        "3pcomms_04.xlsx",
        "Dental_02.XLSX",
        "Travel_99.XLSX",
      ],
    );
    expect(plan.map((file) => file.savedFileName)).toEqual([
      "3PComms_05.XLSX",
      "3PComms_06.XLSX",
      "Dental_03.XLSX",
    ]);
    expect(plan[0].originalName).toBe("3PComms_12312025.xlsx");
  });

  it("resets only the file types with no matching objects left in inbound", () => {
    expect(
      planMemoUploads(
        [
          select("3PComms_10272026.xlsx"),
          select("Dental_10272026.xlsx", "Dental_01.XLSX"),
        ],
        requirements,
        ["Dental_04.XLSX", "processed/3PComms_09.XLSX"],
      ).map((file) => file.savedFileName),
    ).toEqual(["3PComms_01.XLSX", "Dental_05.XLSX"]);
  });

  it("sorts dates chronologically across years and numbers each mapped base independently", () => {
    expect(
      planMemoUploads(
        [
          select("3PComms_01022027.xlsx"),
          select("Dental_10152026.XLSX", "Dental_01.XLSX"),
          select("3PComms_12312025.xlsx"),
          select("3PComms_02012026.xlsx"),
          select("Dental_01012026.xlsx", "Dental_01.XLSX"),
        ],
        requirements,
      ),
    ).toEqual([
      { ...select("3PComms_12312025.xlsx"), savedFileName: "3PComms_01.XLSX" },
      { ...select("3PComms_02012026.xlsx"), savedFileName: "3PComms_02.XLSX" },
      { ...select("3PComms_01022027.xlsx"), savedFileName: "3PComms_03.XLSX" },
      {
        ...select("Dental_01012026.xlsx", "Dental_01.XLSX"),
        savedFileName: "Dental_01.XLSX",
      },
      {
        ...select("Dental_10152026.XLSX", "Dental_01.XLSX"),
        savedFileName: "Dental_02.XLSX",
      },
    ]);
  });

  it("accepts arbitrary suffixes and repeated Excel extensions using natural order after dates", () => {
    const names = [
      "3PComms_revision10.xlsx",
      "3PComms_revision2.xlsx",
      "3pcomms_02292024.xlsx.xlsx",
    ];
    expect(
      planMemoUploads(
        names.map((name) => select(name)),
        requirements,
      ).map((file) => file.originalName),
    ).toEqual([names[2], names[1], names[0]]);
  });

  it.each([
    "3PComms_02302026.xlsx",
    "3PComms_02292025.xlsx",
    "3PComms_13012026.xlsx",
  ])("rejects an invalid date: %s", (name) => {
    expect(() => planMemoUploads([select(name)], requirements)).toThrow(
      /valid (?:MMDDYYYY|YYYYMMDD) date/,
    );
  });

  it.each([
    "Unknown_10272026.xlsx",
    "3PComms_10272026.csv",
    "3PComms_.xlsx",
    "3PCommsExtra_10272026.xlsx",
    "../3PComms_10272026.xlsx",
  ])("rejects an unmapped base, extension or invalid suffix: %s", (name) => {
    expect(() => planMemoUploads([select(name)], requirements)).toThrow(
      "current Memo file mapping",
    );
  });

  it("rejects duplicate source names even with different case or hidden extensions", () => {
    expect(() =>
      planMemoUploads(
        [select("3PComms_10272026.xlsx"), select("3pcomms_10272026.XLSX.xlsx")],
        requirements,
      ),
    ).toThrow("Duplicate files");
  });

  it("recognizes numbered stored files for every required Memo type without broadening other pipelines", () => {
    for (const requirement of requirements) {
      for (const suffix of ["01", "02", "99", "100"]) {
        expect(
          matchesProcessingPipelineRequirement(
            requirement,
            requirement.fileName.replace("_01", `_${suffix}`),
          ),
        ).toBe(true);
      }
      expect(
        matchesProcessingPipelineRequirement(
          requirement,
          requirement.fileName.replace("_01", "_00"),
        ),
      ).toBe(false);
    }
    expect(
      matchesProcessingPipelineRequirement(
        { ...requirements[0], pipelineCode: "other" },
        "3PComms_02.XLSX",
      ),
    ).toBe(false);
  });
});
