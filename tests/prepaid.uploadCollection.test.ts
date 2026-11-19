import { describe, expect, it } from "vitest";
import {
  isUploadCollection,
  uploadCollectionConfiguration,
  uploadCollectionSources,
  uploadCollectionGuidelines,
} from "../src/modules/prepaid/domain/uploadCollection.js";
import {
  manualIntegrationSchema,
  sourceCodeSchema,
  matchesSourceName,
} from "../src/modules/prepaid/domain/contracts.js";

describe("Collection is not financial processing approval", () => {
  it("uses an explicit marker that cannot pass the processing configuration schema", () => {
    expect(isUploadCollection(uploadCollectionConfiguration)).toBe(true);
    expect(
      isUploadCollection({ ...uploadCollectionConfiguration, approved: true }),
    ).toBe(false);
    expect(isUploadCollection({})).toBe(false);
    expect(
      manualIntegrationSchema.safeParse(uploadCollectionConfiguration).success,
    ).toBe(false);
  });
  it("accepts exact source/billing filenames without declaring all possible cycles required", () => {
    const accepted = uploadCollectionSources();
    expect(accepted).toHaveLength(208);
    expect(new Set(accepted.map((s) => s.code)).size).toBe(208);
    for (const source of accepted) {
      expect(sourceCodeSchema.safeParse(source.code).success).toBe(true);
      expect(matchesSourceName(source.code, source.fileName)).toBe(true);
    }
    expect(uploadCollectionGuidelines()).toHaveLength(10);
    expect(uploadCollectionGuidelines()).toContain(
      "308. Billed Adjustments Monthly Summary Report_G_BC{cycle}.XLSX",
    );
    expect(Object.keys(uploadCollectionConfiguration)).not.toContain(
      "expectedCycles",
    );
    expect(Object.keys(uploadCollectionConfiguration)).not.toContain(
      "referenceExport",
    );
  });
});
