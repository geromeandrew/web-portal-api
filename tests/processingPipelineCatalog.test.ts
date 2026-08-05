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
});
