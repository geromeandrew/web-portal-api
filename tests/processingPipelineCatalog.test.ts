import { describe, expect, it } from "vitest";
import {
  bayanBillCycleStateMachines,
  bayanBillCycleStepFunctionMapping,
  bayanBillCycleSuffixes,
  canonicalizeProcessingPipelineExpectedFileName,
  globeBillCycleStateMachines,
  matchesProcessingPipelineRequirement,
  processingPipelineSeedRequirements,
} from "../src/processingPipelineCatalog.js";

describe("Processing Pipeline catalogue", () => {
  it("contains generic pipeline requirements", () => {
    expect(
      processingPipelineSeedRequirements.some(
        (item) => item.pipelineCode === "prepaid_reclass",
      ),
    ).toBe(true);
  });
  it("matches exact and wildcard file requirements", () => {
    const exact = processingPipelineSeedRequirements.find(
      (item) => item.match === "exact",
    )!;
    expect(matchesProcessingPipelineRequirement(exact, exact.fileName)).toBe(
      true,
    );
    const glob = processingPipelineSeedRequirements.find(
      (item) => item.match === "glob",
    )!;
    expect(
      matchesProcessingPipelineRequirement(
        glob,
        glob.fileName.replace("*", "20260731"),
      ),
    ).toBe(true);
  });
  it("normalizes only the Excel extension for caller-supplied expected filenames", () => {
    expect(
      canonicalizeProcessingPipelineExpectedFileName(
        "308. Billed Adjustments Monthly Summary Report_B_01.xlsx",
      ),
    ).toBe("308. Billed Adjustments Monthly Summary Report_B_01.XLSX");
    expect(
      canonicalizeProcessingPipelineExpectedFileName(
        "308. billed adjustments monthly summary report_B_01.xlsx",
      ),
    ).toBe("308. billed adjustments monthly summary report_B_01.XLSX");
  });
  it("keeps the production pipeline and filename mappings", () => {
    expect(processingPipelineSeedRequirements).toContainEqual(
      expect.objectContaining({
        pipelineCode: "bss_billcycle_glob",
        fileName: "308. Billed Adjustments Monthly Summary Report_G_01.XLSX",
      }),
    );
    expect(processingPipelineSeedRequirements).toContainEqual(
      expect.objectContaining({
        pipelineCode: "prepaid_reclass",
        fileName: "318. Billed Charges Summary Report_G_BC27.XLSX",
      }),
    );
  });
  it("maps every Bayan bill-cycle file to a state machine and its filename suffix", () => {
    const bayanRequirements = processingPipelineSeedRequirements.filter(
      (item) => item.pipelineCode === "bss_billcycle_bayn",
    );
    expect(bayanRequirements).toHaveLength(55);
    expect(
      bayanRequirements.every((item) => item.fileName.includes("_B_")),
    ).toBe(true);
    expect(
      processingPipelineSeedRequirements.every(
        (item) => !/_[a-z]+_\d{2}\.[^.]+$/.test(item.fileName),
      ),
    ).toBe(true);
    expect(
      processingPipelineSeedRequirements
        .filter((item) => item.fileName.toLowerCase().endsWith(".xlsx"))
        .every((item) => item.fileName.endsWith(".XLSX")),
    ).toBe(true);
    expect(
      new Set(
        bayanRequirements.map(
          (item) =>
            bayanBillCycleStepFunctionMapping(item.fileName)?.stateMachineCode,
        ),
      ),
    ).toEqual(
      new Set(
        Object.values(bayanBillCycleStateMachines).map((item) => item.code),
      ),
    );
    for (const suffix of bayanBillCycleSuffixes) {
      const mappings = bayanRequirements
        .filter((item) => item.fileName.includes(`_${suffix}.`))
        .map((item) => bayanBillCycleStepFunctionMapping(item.fileName));
      expect(mappings).toHaveLength(5);
      expect(mappings.every((mapping) => mapping?.batchCycle === suffix)).toBe(
        true,
      );
    }
  });
  it("uses the refreshed bill-cycle files and Step Functions targets", () => {
    expect(
      processingPipelineSeedRequirements.filter(
        (item) => item.pipelineCode === "bss_billcycle_glob",
      ),
    ).toHaveLength(44);
    expect(
      processingPipelineSeedRequirements.filter(
        (item) => item.pipelineCode === "bss_billcycle_inov",
      ),
    ).toHaveLength(55);
    expect(
      processingPipelineSeedRequirements.filter(
        (item) => item.pipelineCode === "memo_sst",
      ),
    ).toHaveLength(72);
    expect(
      processingPipelineSeedRequirements.filter(
        (item) => item.pipelineCode === "iccbs_bayn",
      ),
    ).toHaveLength(44);
    expect(bayanBillCycleStateMachines.billedAdjustments.name).toBe(
      "isg-esatp-dv-bss_billcycle_bayn_preload-state_machine_308",
    );
    expect(globeBillCycleStateMachines.sapGlbilled.name).toBe(
      "isg-esatp-dv-bss_billcycle_glob_preload-state_machine_SAPgbilled",
    );
  });
});
