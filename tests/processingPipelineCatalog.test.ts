import { describe, expect, it } from "vitest";
import { matchesProcessingPipelineRequirement, processingPipelineSeedRequirements } from "../src/processingPipelineCatalog.js";

describe("Processing Pipeline catalogue", () => {
  it("contains generic pipeline requirements", () => {
    expect(processingPipelineSeedRequirements.some((item) => item.pipelineCode === "prepaid_reclass")).toBe(true);
  });
  it("matches exact and wildcard file requirements", () => {
    const exact = processingPipelineSeedRequirements.find((item) => item.match === "exact")!;
    expect(matchesProcessingPipelineRequirement(exact, exact.fileName)).toBe(true);
    const glob = processingPipelineSeedRequirements.find((item) => item.match === "glob")!;
    expect(matchesProcessingPipelineRequirement(glob, glob.fileName.replace("*", "20260731"))).toBe(true);
  });
  it("keeps the production pipeline and filename mappings", () => {
    expect(processingPipelineSeedRequirements).toContainEqual(expect.objectContaining({ pipelineCode: "bss_billcycle_glob", fileName: "308. Billed Adjustments Monthly Summary Report_G_01.XLSX" }));
    expect(processingPipelineSeedRequirements).toContainEqual(expect.objectContaining({ pipelineCode: "prepaid_reclass", fileName: "318. Billed Charges Summary Report_G_BC27.xlsx" }));
  });
});
