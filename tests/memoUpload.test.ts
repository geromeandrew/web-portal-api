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
      "valid MMDDYYYY date",
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
