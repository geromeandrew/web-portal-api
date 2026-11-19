import type { Config } from "../../../config.js";
import { manualIntegrationSchema } from "./contracts.js";
import { egReportMappingSchema } from "./sourceExtraction.js";

// 28 October 2026: user confirmed that the EG Call Card report contains EG
// transactions only. All 375 supplied EG Load Up rows establish GROSS=I/1.12
// and VAT=GROSS*0.12, where I is NET TOP UP. Legacy imports a VAT-inclusive
// source amount and subsequently divides by 1.12; do not remove VAT twice.
// This approval belongs to the reviewed dev/sandbox profile, not every caller
// of the generic parser or an unreviewed staging/production environment.
export const approvedProvidedEgReportMapping = Object.freeze(
  egReportMappingSchema.parse({
    profile: "provided-eg-reports-v1",
    approved: true,
    callcardScope: "eg_report",
    loadupAmount: "net_top_up",
  }),
);

// User-approved defaults for these two development/testing databases only.
// No credentials, database writes, automatic SAP refresh or delivery configuration.
const profile = {
  accountingProfile: "legacy_sql_v1",
  referenceValidationPolicy: "legacy_all_matches",
  sourceSplitPolicy: "legacy_eg_total",
  preparationMode: "native_sources",
  sourceExtraction: {
    envPrefix: "isg-esatp-dv",
    coverage: "all_sources",
    sharedWritesApproved: true,
    parallelism: 3,
    egReportMapping: approvedProvidedEgReportMapping,
  },
  expectedCycles: ["21", "27"],
  reportCycles: { adjustments: ["21"], charges: ["27"] },
  format: {
    fileType: "xlsx",
    profile: "prepaid-manual-xlsx-v1",
    approved: true,
  },
  referenceVersion: {
    sha256: "720d4ba24a8ec3140110e668af29ba74e2bf6bcfe60df53c46b4a56ba92ccd71",
    rowCount: 34503,
    approved: true,
  },
};

/** Exact reviewed environment scope. NODE_ENV is not an environment identity:
 * dev deployments commonly run with NODE_ENV=production too. */
export function builtinPrepaidConfiguration(
  config: Pick<
    Config,
    | "DATABASE_HOST"
    | "DATABASE_PORT"
    | "DATABASE_NAME"
    | "DATABASE_SCHEMA"
    | "DATABASE_SSL"
    | "S3_BUCKET"
    | "AWS_REGION"
  > &
    Pick<Config, "PREPAID_CONFIGURATION_JSON">,
) {
  if (config.PREPAID_CONFIGURATION_JSON)
    return manualIntegrationSchema.parse(
      JSON.parse(config.PREPAID_CONFIGURATION_JSON),
    );
  const dev =
    config.DATABASE_HOST ===
      "isg-esatp-dv-app-db-hscl.cluster-cz662ugouo8h.ap-southeast-1.rds.amazonaws.com" &&
    config.DATABASE_PORT === 1769 &&
    config.DATABASE_NAME === "isgesatpdv";
  const sandbox =
    [
      "database-1-instance-1.c0x8ko8cis42.us-east-1.rds.amazonaws.com",
      "database-1.cluster-c0x8ko8cis42.us-east-1.rds.amazonaws.com",
    ].includes(config.DATABASE_HOST) &&
    config.DATABASE_PORT === 5432 &&
    config.DATABASE_NAME === "postgres";
  if (
    (!dev && !sandbox) ||
    config.DATABASE_SCHEMA !== "web_portal" ||
    !config.DATABASE_SSL ||
    config.S3_BUCKET !== "isg-esatp-rcc-storage-os" ||
    config.AWS_REGION !== "us-east-1"
  )
    return undefined;
  // Parsing returns a fresh object; callers cannot mutate subsequent defaults.
  return manualIntegrationSchema.parse(profile);
}

/** An invalid explicit database row must NOT silently activate approved defaults. */
export function effectivePrepaidConfiguration(
  stored: unknown,
  builtin: unknown,
) {
  return {
    configuration: stored === undefined ? builtin : stored,
    source:
      stored !== undefined
        ? "database"
        : builtin !== undefined
          ? "built_in"
          : "missing",
  } as const;
}
