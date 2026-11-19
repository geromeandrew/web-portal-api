import { describe, it, expect, vi } from "vitest";
import {
  sourceExtractionSchema,
  sourceWorkflows,
  validateLegacySourceDefinition,
} from "../src/modules/prepaid/domain/sourceExtraction.js";
import { sourceMachineName } from "../src/modules/prepaid/domain/sourceResources.js";
import { AwsSourceJobInspector } from "../src/modules/prepaid/infrastructure/sourceJobInspector.js";
import {
  nativeJobFixture,
  legacyDefinition,
} from "./fixtures/prepaidSource.js";
import { builtinPrepaidConfiguration } from "../src/modules/prepaid/domain/builtinConfiguration.js";

const resources = {
  scriptsBucket: "portal-st-scripts",
  scriptsPrefix: "glue/st/core/commons/",
  stateMachines: { ke24: "portal-st-ke24" },
  jobNamePrefix: "portal-st-extract_",
  connectionName: "portal-st-postgres",
};
describe("Portable native extraction resources", () => {
  it("resolves the new environment explicitly and leaves reviewed historical settings unchanged", () => {
    const settings = sourceExtractionSchema.parse({
      envPrefix: "portal-st",
      resources,
      sharedWritesApproved: true,
      coverage: "all_sources",
    });
    expect(
      sourceMachineName("ke24", settings, sourceWorkflows.ke24.machine),
    ).toBe("portal-st-ke24");
    expect(
      sourceMachineName(
        "callcard_eg",
        settings,
        sourceWorkflows.callcard_eg.machine,
      ),
    ).toBe("portal-st-prcl_cc_eg-sf");
    expect(
      sourceMachineName(
        "ke24",
        { envPrefix: "isg-esatp-dv" },
        sourceWorkflows.ke24.machine,
      ),
    ).toBe(sourceWorkflows.ke24.machine);
    expect(
      sourceExtractionSchema.safeParse({
        envPrefix: "portal-st",
        sharedWritesApproved: true,
      }).success,
    ).toBe(false);
    expect(
      sourceExtractionSchema.safeParse({
        ...settings,
        resources: {
          ...resources,
          stateMachines: { ke24: "same", callcard_eg: "same" },
        },
      }).success,
    ).toBe(false);
  });
  it("verifies relocated scripts, input folders and connections without relaxing parsing contracts", async () => {
    const fixture = nativeJobFixture(10);
    fixture.command.ScriptLocation =
      "s3://portal-st-scripts/glue/st/core/commons/scripts/GlueSpreadsheetWildcard.py";
    fixture.arguments["--connection_name"] = "portal-st-postgres";
    fixture.arguments["--folder_location"] =
      "portal-st-storage/prepaid_reclass/";
    fixture.arguments["--input_file_name"] = "KE24.xlsx";
    fixture.arguments["--target_table"] = "sdbtdir1_prepaid_dbo.dcKE24";
    const send = vi.fn(async () => ({
      Job: { Command: fixture.command, DefaultArguments: fixture.arguments },
    }));
    const inspector = new AwsSourceJobInspector(
      { send } as any,
      { send: vi.fn() } as any,
    );
    await inspector.verify(
      "ke24",
      "portal-st",
      "portal-st-storage",
      false,
      resources,
    );
    expect(send.mock.calls[0][0].input.JobName).toBe("portal-st-extract_10");
    fixture.arguments["--target_headers"] = "different columns";
    await expect(
      inspector.verify(
        "ke24",
        "portal-st",
        "portal-st-storage",
        false,
        resources,
      ),
    ).rejects.toThrow("--target_headers");
  });
  it("continues rejecting changed isolation bytes in a relocated scripts bucket", async () => {
    const read = vi.fn(async () => Buffer.from("changed code"));
    const inspector = new AwsSourceJobInspector(
      { send: vi.fn() } as any,
      { send: vi.fn() } as any,
      read,
    );
    await expect(inspector.verifyIsolation(resources)).rejects.toThrow(
      "Shared Glue implementation changed",
    );
    expect(read.mock.calls[0]).toEqual([
      "glue/st/core/commons/imports/SpreadsheetIngesterWildcard.py",
      "portal-st-scripts",
    ]);
  });
  it("accepts matching static relocated jobs, rejecting foreign tasks and preserving dynamic job contracts", () => {
    const definition = legacyDefinition("ke24");
    definition.States.Extract_10.Parameters = {
      JobName: "portal-st-extract_10",
      Arguments: {},
    } as any;
    expect(
      validateLegacySourceDefinition(
        "ke24",
        JSON.stringify(definition),
        "portal-st",
        resources,
      ).jobs,
    ).toEqual(["portal-st-extract_10"]);
    expect(() =>
      validateLegacySourceDefinition(
        "ke24",
        JSON.stringify(definition),
        "other",
        undefined,
      ),
    ).toThrow("unexpected Glue jobs");
    expect(
      validateLegacySourceDefinition(
        "ke24",
        JSON.stringify(legacyDefinition("ke24")),
        "portal-st",
      ).jobs,
    ).toEqual(["portal-st-prep_reclass-gljo-extract_10"]);
  });
  it("loads explicit deployment configuration without depending on an old database host, bucket or region", () => {
    const approved = {
      preparationMode: "native_sources",
      sourceExtraction: {
        envPrefix: "portal-st",
        resources,
        sharedWritesApproved: true,
        coverage: "all_sources",
      },
      expectedCycles: ["21"],
      referenceVersion: { sha256: "a".repeat(64), rowCount: 1, approved: true },
      format: {
        fileType: "xlsx",
        profile: "accepted-by-target-owner",
        approved: true,
      },
    };
    const target = {
      DATABASE_HOST: "new-db.example",
      DATABASE_PORT: 5432,
      DATABASE_NAME: "new_portal",
      DATABASE_SCHEMA: "web_portal",
      DATABASE_SSL: true,
      S3_BUCKET: "portal-st-storage",
      AWS_REGION: "ap-southeast-1",
    };
    expect(builtinPrepaidConfiguration(target)).toBeUndefined();
    const config = builtinPrepaidConfiguration({
      ...target,
      PREPAID_CONFIGURATION_JSON: JSON.stringify(approved),
    })!;
    expect(config.referenceVersion).toEqual(approved.referenceVersion);
    expect(config.sourceExtraction?.resources?.scriptsBucket).toBe(
      "portal-st-scripts",
    );
    expect(() =>
      builtinPrepaidConfiguration({
        ...target,
        PREPAID_CONFIGURATION_JSON: "{}",
      }),
    ).toThrow();
  });
});
