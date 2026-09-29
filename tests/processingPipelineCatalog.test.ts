import { describe, expect, it } from "vitest";
import {
  bayanBillCycleStateMachines,
  bayanBillCycleStepFunctionMapping,
  bayanBillCycleSuffixes,
  canonicalizeProcessingPipelineExpectedFileName,
  matchesBillCycleUploadFile,
  globeBillCycleStateMachines,
  matchesProcessingPipelineRequirement,
  processingPipelineSeedRequirements,
} from "../src/processingPipelineCatalog.js";
import { processingPipelineSeedRequirements as migration019Requirements } from "../src/migrationSnapshots/processingPipelineCatalogue019.js";

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
        "308. Billed Adjustments Monthly Summary Report_G_01.xlsx",
      ),
    ).toBe("308. Billed Adjustments Monthly Summary Report_G_01.XLSX");
    expect(
      canonicalizeProcessingPipelineExpectedFileName(
        "308. billed adjustments monthly summary report_G_01.xlsx",
      ),
    ).toBe("308. billed adjustments monthly summary report_G_01.XLSX");
  });
  it("matches bill-cycle uploads by report identity and normalizes source entity and cycle suffixes", () => {
    const requirements = processingPipelineSeedRequirements.filter((item) => item.pipelineCode === "bss_billcycle_bayn");
    const adjustment = requirements.find((item) => item.fileName.startsWith("308."))!;
    const php = requirements.find((item) => item.fileName.includes("Control_PHP_B_01"))!;
    const usd = requirements.find((item) => item.fileName.includes("Control_USD_B_01"))!;
    const sap = requirements.find((item) => item.fileName.startsWith("sap_glbilled_B_01"))!;
    expect(matchesBillCycleUploadFile(adjustment, "308. revised title_b_01.xlsx")).toBe(true);
    expect(matchesBillCycleUploadFile(adjustment, "308. revised title_b.xlsx")).toBe(true);
    expect(matchesBillCycleUploadFile(adjustment, "308.xlsx")).toBe(true);
    expect(matchesBillCycleUploadFile(adjustment, "308. revised title_01.xlsx")).toBe(true);
    expect(matchesBillCycleUploadFile(adjustment, "308. revised title_g_01.xlsx")).toBe(true);
    expect(matchesBillCycleUploadFile(adjustment, "308. revised title_b_02.xlsx")).toBe(true);
    expect(matchesBillCycleUploadFile(php, "411. any title_php_b_01.xlsx")).toBe(true);
    expect(matchesBillCycleUploadFile(usd, "411. any title_php_b_01.xlsx")).toBe(false);
    expect(matchesBillCycleUploadFile(sap, "SAP alternate GLBILLED_b_01.xlsx")).toBe(true);
  });
  it("keeps the production pipeline and filename mappings", () => {
    expect(processingPipelineSeedRequirements).toContainEqual(
      expect.objectContaining({
        pipelineCode: "bss_billcycle_bayn",
        fileName: "308. Billed Adjustments Monthly Summary Report_B_01.XLSX",
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
    ).toHaveLength(33);
    expect(
      processingPipelineSeedRequirements.filter(
        (item) => item.pipelineCode === "bss_billcycle_inov",
      ),
    ).toHaveLength(55);
    expect(
      processingPipelineSeedRequirements.filter(
        (item) => item.pipelineCode === "memo_sst",
      ),
    ).toHaveLength(24);
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
  it("uses only the supplied file mappings", () => {
    const globeRequirements = processingPipelineSeedRequirements.filter(
      (item) => item.pipelineCode === "bss_billcycle_glob",
    );
    expect(
      globeRequirements.some((item) => item.fileName.startsWith("308.")),
    ).toBe(false);
    expect(
      processingPipelineSeedRequirements
        .filter((item) => item.pipelineCode === "memo_sst")
        .every((item) => item.fileName.endsWith("_01.XLSX")),
    ).toBe(true);

    const accrualOutputs = processingPipelineSeedRequirements.filter(
      (item) =>
        item.pipelineCode === "aprm_voice_accrual" &&
        item.fileName.includes("_output"),
    );
    expect(accrualOutputs).toHaveLength(3);
    expect(accrualOutputs.every((item) => item.match === "exact")).toBe(true);

    const deltaOutputs = processingPipelineSeedRequirements.filter(
      (item) =>
        item.pipelineCode === "aprm_voice_delta" &&
        item.fileName.includes("_OUTPUT"),
    );
    expect(deltaOutputs).toHaveLength(6);
    expect(deltaOutputs.every((item) => item.match === "exact")).toBe(true);
  });
  it("keeps the migration snapshot aligned with the live catalogue", () => {
    const mappingKey = (item: {
      pipelineCode: string;
      fileName: string;
      match: string;
      legacyPackageName: string | null;
    }) =>
      [
        item.pipelineCode,
        item.fileName,
        item.match,
        item.legacyPackageName ?? "",
      ].join("|");
    expect(migration019Requirements.map(mappingKey).sort()).toEqual(
      processingPipelineSeedRequirements.map(mappingKey).sort(),
    );
  });
});
