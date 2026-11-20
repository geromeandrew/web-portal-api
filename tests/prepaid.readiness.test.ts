import { describe, expect, it } from "vitest";
import { prepaidConfigurationReadiness } from "../src/modules/prepaid/domain/integrationReadiness.js";

const configured = {
  ingestStateMachine: "approved-deployed-adapter",
  expectedCycles: ["01", "02"],
  format: {
    profile: "test-only",
    approved: true,
    delimiter: "\t",
    lineEnding: "\r\n",
    encoding: "utf8",
  },
};

describe("Prepaid configuration evidence and readiness", () => {
  it("does not infer or approve settings from legacy names", () => {
    const result = prepaidConfigurationReadiness(undefined);
    expect(result.integrationConfigured).toBe(false);
    expect(result.checks.every((check) => check.status === "missing")).toBe(
      true,
    );
    expect(result.legacyBasis.ingestion.sqlAgentJob).toBe(
      "Prepaid_Reclass_Preload_P02_Extract_04Mnt",
    );
    expect(result.legacyBasis.ingestion.awsStateMachineDefined).toBe(false);
    expect(result.legacyBasis.billingCycles.cycleRowsAvailable).toBe(false);
    expect(result.legacyBasis.journal.transportFormatDefined).toBe(false);
  });
  it("accepts manual staging without an automatic SAP delivery configuration", () => {
    const result = prepaidConfigurationReadiness(configured);
    expect(result.integrationConfigured).toBe(true);
    expect(result.checks.every((check) => check.status === "configured")).toBe(
      true,
    );
    expect(result.legacyBasis.freeze.currentMode).toBe("manual_staging");
    expect(result.legacyBasis.journal.columnCount).toBe(40);
    expect(result.legacyBasis.journal.contentRulesImplemented).toBe(true);
  });
  it("identifies invalid mandatory settings individually", () => {
    const result = prepaidConfigurationReadiness({
      ...configured,
      expectedCycles: ["01", "01"],
    });
    expect(result.integrationConfigured).toBe(false);
    expect(
      result.checks.find((check) => check.code === "expectedCycles")?.status,
    ).toBe("invalid");
    expect(result.checks.find((check) => check.code === "format")?.status).toBe(
      "configured",
    );
  });
  it("identifies invalid optional settings rather than returning only green checks", () => {
    const result = prepaidConfigurationReadiness({
      ...configured,
      sourceSplitPolicy: "guess",
    });
    expect(result.integrationConfigured).toBe(false);
    expect(result.checks).toContainEqual(
      expect.objectContaining({ code: "sourceSplitPolicy", status: "invalid" }),
    );
  });
  it("requires format approval and does not supply inferred transport defaults", () => {
    for (const format of [
      { ...configured.format, approved: false },
      { profile: "legacy-content", approved: true },
    ]) {
      const result = prepaidConfigurationReadiness({ ...configured, format });
      expect(result.integrationConfigured).toBe(false);
      expect(
        result.checks.find((check) => check.code === "format")?.status,
      ).toBe("invalid");
    }
  });
  it("does not allow a partial child extractor to masquerade as the complete adapter", () => {
    const result = prepaidConfigurationReadiness({
      ...configured,
      ingestStateMachine: "isg-esatp-dv-prcl_la_eg-sf",
    });
    expect(result.integrationConfigured).toBe(false);
    expect(
      result.checks.find((check) => check.code === "ingestStateMachine")
        ?.status,
    ).toBe("invalid");
  });
});
