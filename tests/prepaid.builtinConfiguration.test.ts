import { describe, expect, it } from "vitest";
import {
  builtinPrepaidConfiguration,
  effectivePrepaidConfiguration,
} from "../src/modules/prepaid/domain/builtinConfiguration.js";
import { requiredBillingSources } from "../src/modules/prepaid/domain/contracts.js";
import { manualIntegrationSchema } from "../src/modules/prepaid/domain/contracts.js";
import { readFile } from "node:fs/promises";
const dev = {
  DATABASE_HOST:
    "isg-esatp-dv-app-db-hscl.cluster-cz662ugouo8h.ap-southeast-1.rds.amazonaws.com",
  DATABASE_PORT: 1769,
  DATABASE_NAME: "isgesatpdv",
  DATABASE_SCHEMA: "web_portal",
  DATABASE_SSL: true,
  AWS_REGION: "us-east-1",
  S3_BUCKET: "isg-esatp-rcc-storage-os",
};
describe("Built-in approved dev/sandbox Prepaid defaults", () => {
  it("provides complete approved settings without a configuration database write", () => {
    const defaults = builtinPrepaidConfiguration(dev)!;
    expect(defaults.preparationMode).toBe("native_sources");
    expect(requiredBillingSources(defaults)).toEqual(["308_21", "318_27"]);
    expect(defaults.referenceVersion).toMatchObject({
      rowCount: 34503,
      approved: true,
    });
    expect(defaults.format).toMatchObject({ fileType: "xlsx", approved: true });
    expect(defaults.referenceValidationPolicy).toBe("legacy_all_matches");
    expect(defaults.sourceExtraction?.egReportMapping).toEqual({
      profile: "provided-eg-reports-v1",
      approved: true,
      callcardScope: "eg_report",
      loadupAmount: "net_top_up",
    });
    expect(defaults.deliveryStateMachine).toBeUndefined();
    expect(effectivePrepaidConfiguration(undefined, defaults)).toEqual({
      configuration: defaults,
      source: "built_in",
    });
  });
  it("keeps the operator validation mapping identical to the reviewed built-in mapping", async () => {
    const mapping = JSON.parse(
      await readFile(
        new URL(
          "../config/prepaid.eg-report-mapping.approved.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect(mapping).toEqual(
      builtinPrepaidConfiguration(dev)!.sourceExtraction!.egReportMapping,
    );
  });
  it("requires the legacy accounting profile and approved reference for all-match handling", () => {
    const defaults = builtinPrepaidConfiguration(dev)!;
    expect(
      manualIntegrationSchema.safeParse({
        ...defaults,
        accountingProfile: undefined,
      }).success,
    ).toBe(false);
    expect(
      manualIntegrationSchema.safeParse({
        ...defaults,
        referenceVersion: undefined,
      }).success,
    ).toBe(false);
    expect(
      manualIntegrationSchema.safeParse({
        ...defaults,
        referenceValidationPolicy: undefined,
      }).success,
    ).toBe(true);
  });
  it.each([
    "database-1-instance-1.c0x8ko8cis42.us-east-1.rds.amazonaws.com",
    "database-1.cluster-c0x8ko8cis42.us-east-1.rds.amazonaws.com",
  ])("allows the reviewed sandbox endpoint %s", (host) => {
    expect(
      builtinPrepaidConfiguration({
        ...dev,
        DATABASE_HOST: host,
        DATABASE_PORT: 5432,
        DATABASE_NAME: "postgres",
      }),
    ).toBeDefined();
  });
  it.each([
    { DATABASE_HOST: "production.example" },
    { DATABASE_NAME: "isgesatpst" },
    { DATABASE_PORT: 5432 },
    { DATABASE_SCHEMA: "another_portal" },
    { S3_BUCKET: "another-bucket" },
    { AWS_REGION: "ap-southeast-1" },
    { DATABASE_SSL: false },
    { DATABASE_HOST: "127.0.0.1" },
  ])("does not activate a different/unapproved environment: %o", (change) => {
    expect(builtinPrepaidConfiguration({ ...dev, ...change })).toBeUndefined();
  });
  it.each([{}, null, { format: { approved: false } }])(
    "never hides invalid explicit database configuration: %o",
    (stored) => {
      expect(
        effectivePrepaidConfiguration(stored, builtinPrepaidConfiguration(dev)),
      ).toEqual({ configuration: stored, source: "database" });
    },
  );
  it("keeps valid database overrides and returns isolated default objects", () => {
    const first = builtinPrepaidConfiguration(dev)!;
    first.expectedCycles.push("99");
    expect(builtinPrepaidConfiguration(dev)!.expectedCycles).toEqual([
      "21",
      "27",
    ]);
    const override = { custom: "database configuration" };
    expect(effectivePrepaidConfiguration(override, first)).toEqual({
      configuration: override,
      source: "database",
    });
    expect(effectivePrepaidConfiguration(undefined, undefined)).toEqual({
      configuration: undefined,
      source: "missing",
    });
  });
});
