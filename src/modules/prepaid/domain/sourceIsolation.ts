import {
  reviewedSourceResources,
  type SourceResources,
} from "./sourceResources.js";

/** Baseline reviewed 29 October; UtilsAWS re-reviewed 3 November 2026.
 * Prepaid wrappers use only its file-scoped move and case-resolution functions,
 * not its export helpers. Copy-only moves retain inputs for multi-job workflows.
 * audit_table/passed_parameter remain forbidden by the existing job contract.
 * Unreviewed content still blocks dispatch. Never deploy these shared files.
 */
export const sourceIsolationPrefix = "glue/dv-v0.0.1/core/commons/";
export const sourceIsolationAssets: Record<string, string> = {
  "scripts/GlueSpreadsheetWildcard.py":
    "a27a81d36f2eb42ceb96d4901968a90110fbca987109005482e1b898a35c574e",
  "scripts/GlueCsv.py":
    "8593847b8caf4fa0097a782166fd57d49b1130e25bd2d50a3239159e7a7c7194",
  "imports/SpreadsheetIngesterWildcard.py":
    "f9fa353b3ca46c3d5392d256df242b05109943d01f3f0fc4d3456b28a51fb04b",
  "imports/CsvIngester.py":
    "8b01bb36e7f51e097964bbb3c735162c7d97931f31b860a5b5e811bfd8fe7e3a",
  "imports/CustomDbConnLibs.py":
    "26d35ad62b26022927c6b503baf53c50153f3bbd20f7ce75e93d84ff2bcf3b06",
  "imports/UtilsAWS.py":
    "68378d294f3a85ab2bf74d20db3b60b6dae3c5f12a4d9e13452169518347820c",
  "imports/Utils.py":
    "78201006373ecb682e84a7248d8bc12ea76586fd416dcd109510a99c4aebb104",
  "imports/CustomErrorLibs.py":
    "f7558376aeb4d52f814803b7a5448a1e67bf7ce34bc12a60151c1c3c57e6a17b",
  "artifacts/et_xmlfile-1.1.0-py3-none-any.whl":
    "a2ba85d1d6a74ef63837eed693bcb89c3f752169b0e3e7ae5b16ca5e1b3deada",
  "artifacts/openpyxl-3.1.2-py2.py3-none-any.whl":
    "f91456ead12ab3c6c2e9491cf33ba6d08357d802192379bb482f1033ade496f5",
  "artifacts/xlrd-2.0.1-py2.py3-none-any.whl":
    "cac16cb350c300c7393fd44b1eb182b60a5139b9bd9d17de2998f2a8fb54d284",
};

// Keep the previously reviewed helper compatible in environments that still use
// it. This is an explicit allowlist of reviewed bytes, not a content-check bypass.
const previousReviewedVersions: Readonly<Record<string, readonly string[]>> = {
  "scripts/GlueCsv.py": [
    // The newer wrapper changes BCNUM to BC only when passed_parameter is set.
    // The Prepaid recharge job still forbids that argument.
    "260b0c293209408c5094d45b433e8375fbe899de546b968265cfba9a6d88e54c",
  ],
  "imports/UtilsAWS.py": [
    // Re-reviewed 3 November: the latest export-only change uses NUL quote and
    // escape characters. Extraction imports, moves and lookups are unchanged.
    "c8d8bd2327d57ec1a725573d7300cf61f675e212ceca261977a6904230b30e91",
    // The later version changes only export_df_to_exact_filename's CSV quoting;
    // extraction imports and file-scoped operations are identical.
    "916dfe0f7929869d5445917e488380cc4df2082aa2b04c11e7d5232dedc74162",
    "e0ddd9523c1a86753c907ce84d19e0b6d16f6892a4d7f45216147b6cb8ea117f",
  ],
};

export function isReviewedSourceAsset(key: string, checksum: string): boolean {
  return (
    Object.hasOwn(sourceIsolationAssets, key) &&
    (sourceIsolationAssets[key] === checksum ||
      previousReviewedVersions[key]?.includes(checksum) === true)
  );
}

export function sourceIsolationLibraries(
  csv: boolean,
  resources: SourceResources = reviewedSourceResources,
) {
  const files = csv
    ? ["imports/CsvIngester.py"]
    : [
        "imports/SpreadsheetIngesterWildcard.py",
        "artifacts/et_xmlfile-1.1.0-py3-none-any.whl",
        "artifacts/openpyxl-3.1.2-py2.py3-none-any.whl",
        "artifacts/xlrd-2.0.1-py2.py3-none-any.whl",
      ];
  return [
    ...files,
    "imports/Utils.py",
    "imports/UtilsAWS.py",
    "imports/CustomDbConnLibs.py",
    "imports/CustomErrorLibs.py",
  ]
    .map(
      (file) =>
        `s3://${resources.scriptsBucket}/${resources.scriptsPrefix}${file}`,
    )
    .sort();
}
