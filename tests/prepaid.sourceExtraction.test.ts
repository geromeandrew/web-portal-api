import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  sourceExtractionSchema,
  sourceWorkflows,
  validateLegacySourceDefinition,
  type SourceWorkflow,
} from "../src/modules/prepaid/domain/sourceExtraction.js";
import { legacyDefinition } from "./fixtures/prepaidSource.js";

describe("Unchanged source workflow compatibility (read-only)", () => {
  it("disables the former deployment command before configuration/AWS access", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(
          new URL("../src/deployPrepaidSources.ts", import.meta.url),
        ),
        "--apply",
      ],
      { encoding: "utf8", windowsHide: true },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Deployment is disabled");
    expect(result.stdout).toBe("");
  });
  it.each(Object.keys(sourceWorkflows) as SourceWorkflow[])(
    "accepts native Glue tasks without portal branches: %s",
    (workflow) => {
      const definition = legacyDefinition(workflow),
        original = structuredClone(definition);
      const result = validateLegacySourceDefinition(
        workflow,
        JSON.stringify(definition),
        "isg-esatp-dv",
      );
      expect(result.input).toEqual({ env_prefix: "isg-esatp-dv" });
      expect(result.jobs).toHaveLength(sourceWorkflows[workflow].jobs.length);
      expect(definition).toEqual(original);
      expect(JSON.stringify(definition)).not.toContain("Portal");
    },
  );
  it("reports the observed 308 JobRunId bug without correcting the definition", () => {
    const definition = legacyDefinition("adjustments_308");
    (definition.States.Extract_5 as any).Parameters.Arguments[
      "--previous_job_run_id.$"
    ] = "$.extract_4_output.JobRunId";
    const before = structuredClone(definition);
    expect(() =>
      validateLegacySourceDefinition(
        "adjustments_308",
        JSON.stringify(definition),
        "isg-esatp-dv",
      ),
    ).toThrow("owner must correct");
    expect(definition).toEqual(before);
  });
  it("follows the native fallback when an old optional portal Choice is present", () => {
    const definition = legacyDefinition("load_api_eg") as any;
    definition.StartAt = "OldChoice";
    definition.States.OldChoice = {
      Type: "Choice",
      Choices: [
        { Variable: "$.portalExtraction", IsPresent: true, Next: "NotNeeded" },
      ],
      Default: "Extract_2",
    };
    definition.States.NotNeeded = { Type: "Fail" };
    expect(
      validateLegacySourceDefinition(
        "load_api_eg",
        JSON.stringify(definition),
        "isg-esatp-dv",
      ).input,
    ).toEqual({ env_prefix: "isg-esatp-dv" });
  });
  it("rejects a script override or unexpected job before starting AWS", () => {
    const definition = legacyDefinition("load_api_eg");
    (definition.States.Extract_2 as any).Parameters.Arguments[
      "--scriptLocation"
    ] = "s3://other/script.py";
    expect(() =>
      validateLegacySourceDefinition(
        "load_api_eg",
        JSON.stringify(definition),
        "isg-esatp-dv",
      ),
    ).toThrow("override");
  });
  it("requires approval for unchanged shared raw-table writes, not a script location", () => {
    expect(
      sourceExtractionSchema.parse({
        envPrefix: "isg-esatp-dv",
        sharedWritesApproved: true,
      }),
    ).toEqual({ envPrefix: "isg-esatp-dv", sharedWritesApproved: true });
    expect(() =>
      sourceExtractionSchema.parse({ envPrefix: "isg-esatp-dv" }),
    ).toThrow();
    expect(() =>
      sourceExtractionSchema.parse({
        scriptSha256: "a".repeat(64),
        scriptLocation: "s3://old/script.py",
      }),
    ).toThrow();
  });
});
