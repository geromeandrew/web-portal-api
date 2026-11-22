import { readFile, stat } from "node:fs/promises";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { createPool } from "./db.js";
import { PrepaidConfigurationService } from "./modules/prepaid/application/configurationService.js";
import {
  manualIntegrationSchema,
  unsupportedLegacyPrepaidCycles,
} from "./modules/prepaid/domain/contracts.js";
import { convertLegacyReference } from "./modules/prepaid/domain/referenceConverter.js";
import { referenceImportSchema } from "./modules/prepaid/domain/referenceVersion.js";
import { PrepaidReferenceCatalog } from "./modules/prepaid/infrastructure/referenceCatalog.js";
import { sha256 } from "./modules/prepaid/infrastructure/prepaidStorage.js";
import { PrepaidRepository } from "./modules/prepaid/infrastructure/repository.js";

const { values } = parseArgs({
  options: {
    database: { type: "string" },
    profile: { type: "string" },
    "actor-email": { type: "string" },
    "reference-file": { type: "string" },
    "reference-metadata": { type: "string" },
    apply: { type: "boolean" },
  },
});
if (!values.database || !values.profile || !values["actor-email"])
  throw Error(
    "Specify --database, --profile and --actor-email. Use --apply to save.",
  );

const config = loadConfig();
if (config.DATABASE_NAME !== values.database)
  throw Error("The configured database does not match --database.");

const profile = JSON.parse(await readFile(values.profile, "utf8"));
const referenceFile = values["reference-file"];
const referenceMetadata = values["reference-metadata"];
if (Boolean(referenceFile) !== Boolean(referenceMetadata))
  throw Error(
    "Supply both --reference-file and --reference-metadata for a reference import.",
  );
if (referenceFile && (profile.referenceExport || profile.referenceVersion))
  throw Error("Supply a reference source in the profile or by file, not both.");

const approval = referenceMetadata
  ? referenceImportSchema.parse(
      JSON.parse(await readFile(referenceMetadata, "utf8")),
    )
  : undefined;
if (referenceFile && (await stat(referenceFile)).size > 20 * 1024 * 1024)
  throw Error("Reference file exceeds 20 MiB.");
const bytes = referenceFile ? await readFile(referenceFile) : undefined;
if (bytes && (!approval || sha256(bytes) !== approval.sha256))
  throw Error("The reference file does not match its approved checksum.");
if (
  approval?.approvalScope === "development-testing" &&
  profile.sourceExtraction?.envPrefix === "isg-esatp-pd"
)
  throw Error(
    "The production profile requires an accounting-accepted reference.",
  );

const integration = manualIntegrationSchema.parse({
  ...profile,
  ...(approval && {
    referenceVersion: {
      sha256: approval.sha256,
      rowCount: approval.rowCount,
      approved: true,
    },
  }),
});
const unsupportedCycles = unsupportedLegacyPrepaidCycles(integration);
if (unsupportedCycles.length)
  throw Error(`Unsupported Prepaid billing cycles: ${unsupportedCycles.join(", ")}.`);
if (
  integration.sourceExtraction &&
  integration.sourceExtraction.envPrefix !== config.SFN_PREFIX
)
  throw Error(
    "The profile's source workflows must use the configured SFN_PREFIX.",
  );

const pool = createPool(config);
try {
  const repo = new PrepaidRepository(pool, config.DATABASE_SCHEMA);
  const identity = await pool.query("SELECT current_database() AS name");
  if (identity.rows[0]?.name !== values.database)
    throw Error("Connected database does not match --database.");

  const actor = await pool.query(
    `SELECT id FROM ${repo.schema}.app_user WHERE lower(email) = lower($1) AND is_active AND is_admin`,
    [values["actor-email"]],
  );
  if (actor.rowCount !== 1)
    throw Error(
      "Use an existing active portal administrator from the target database.",
    );

  const catalog = new PrepaidReferenceCatalog(repo);
  const service = new PrepaidConfigurationService(repo);
  if (integration.referenceVersion && !approval) {
    await catalog.assertAvailable(integration.referenceVersion);
    if (integration.sourceExtraction?.envPrefix === "isg-esatp-pd") {
      const metadata = await catalog.approvalMetadata(
        actor.rows[0].id,
        integration.referenceVersion.sha256,
      );
      if (metadata.approvalScope !== "accounting-accepted")
        throw Error(
          "The production profile requires an accounting-accepted reference.",
        );
    }
  }
  if (!values.apply && bytes && approval) {
    const { report } = convertLegacyReference(bytes, approval.period);
    if (
      report.inputRows !== approval.rowCount ||
      report.rowCount !== approval.rowCount
    )
      throw Error("The reference file does not match its approved row count.");
  }

  if (values.apply) {
    if (bytes && approval)
      await catalog.import(actor.rows[0].id, bytes, approval);
    const current = await service.availableIntegration();
    if (JSON.stringify(current) !== JSON.stringify(integration))
      await service.configure(actor.rows[0].id, integration);
  }

  console.log(
    JSON.stringify({
      database: values.database,
      apply: Boolean(values.apply),
      reportCycles: integration.reportCycles,
      referenceRows: integration.referenceVersion?.rowCount,
    }),
  );
} finally {
  await pool.end();
}
