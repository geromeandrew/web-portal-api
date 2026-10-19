import { describe, expect, it } from "vitest";
import { manualIntegrationSchema } from "../src/modules/prepaid/domain/contracts.js";
import { prepaidConfigurationReadiness } from "../src/modules/prepaid/domain/integrationReadiness.js";
const native = {
  preparationMode: "native_sources",
  sourceExtraction: {
    envPrefix: "isg-esatp-dv",
    coverage: "all_sources",
    sharedWritesApproved: true,
  },
  referenceExport: {
    key: "approved/reference.jsonl",
    prefix: "approved/",
    sha256: "a".repeat(64),
    rowCount: 1,
    approved: true,
  },
  expectedCycles: ["01", "06"],
  format: {
    profile: "approved-test",
    approved: true,
    delimiter: "\t",
    lineEnding: "\r\n",
    encoding: "utf8",
  },
};
describe("Explicit native preparation configuration", () => {
  it("accepts all ten source workflows without inventing a final adapter or SAP dispatcher", () => {
    const config = manualIntegrationSchema.parse(native);
    expect(config.ingestStateMachine).toBeUndefined();
    expect(config.deliveryStateMachine).toBeUndefined();
    expect(prepaidConfigurationReadiness(native).integrationConfigured).toBe(
      true,
    );
  });
  it.each([
    { ...native, referenceExport: undefined },
    {
      ...native,
      referenceExport: { ...native.referenceExport, approved: false },
    },
    {
      ...native,
      sourceExtraction: { ...native.sourceExtraction, coverage: "legacy_four" },
    },
    {
      ...native,
      sourceExtraction: {
        ...native.sourceExtraction,
        sharedWritesApproved: false,
      },
    },
    { ...native, format: { ...native.format, approved: false } },
    { ...native, expectedCycles: ["01", "01"] },
  ])("does not silently approve incomplete native settings: %j", (value) => {
    expect(manualIntegrationSchema.safeParse(value).success).toBe(false);
    expect(prepaidConfigurationReadiness(value).integrationConfigured).toBe(
      false,
    );
    expect(
      prepaidConfigurationReadiness(value).checks.some(
        (c) => c.status === "invalid",
      ),
    ).toBe(true);
  });
  it("preserves four-source coverage for existing external-adapter integrations", () => {
    const config = manualIntegrationSchema.parse({
      ...native,
      preparationMode: "external_adapter",
      referenceExport: undefined,
      ingestStateMachine: "existing-v2-adapter",
      sourceExtraction: {
        envPrefix: "isg-esatp-dv",
        sharedWritesApproved: true,
      },
    });
    expect(config.sourceExtraction!.coverage).toBe("legacy_four");
  });
});
