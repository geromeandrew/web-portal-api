import {
  prepaidAllSourceMigrationSql,
  prepaidAdditionalRawValidationSql,
} from "./allSourceMigration.js";
import { prepaidFullBatchMigrationSql } from "./fullBatchMigration.js";
import { prepaidMigrationSql } from "./migrations.js";
import { prepaidWorkspaceMigrationSql } from "./workspaceMigration.js";
import { prepaidConsistencyMigrationSql } from "./consistencyMigration.js";
import { prepaidLegacyRulesMigrationSql } from "./legacyRulesMigration.js";
import { prepaidSourceExtractionMigrationSql } from "./sourceExtractionMigration.js";
import { prepaidSourceBackendMigrationSql } from "./sourceBackendMigration.js";
import { prepaidReferenceRefreshMigrationSql } from "./referenceRefreshMigration.js";
import { prepaidAccountingParityMigrationSql } from "./accountingParityMigration.js";
import { prepaidReferenceLookupMigrationSql } from "./referenceLookupMigration.js";
import { prepaidReferencePolicyMigrationSql } from "./referencePolicyMigration.js";
import { prepaidReferenceCatalogMigrationSql } from "./referenceCatalogMigration.js";
import { prepaidValidationReviewMigrationSql } from "./validationReviewMigration.js";
import {
  prepaidRawSchema,
  prepaidRawSourceMigrationSql,
  prepaidRawSourceValidationSql,
} from "./rawSourceMigration.js";

export interface MigrationConnection {
  query(
    sql: string,
    values?: string[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}
export function prepaidMigrations(rawSchema = prepaidRawSchema) {
  return [
    ["001_prepaid_backend", prepaidMigrationSql],
    ["002_prepaid_workspace", prepaidWorkspaceMigrationSql],
    ["003_prepaid_consistency", prepaidConsistencyMigrationSql],
    ["004_prepaid_legacy_rules", prepaidLegacyRulesMigrationSql],
    [
      "005_prepaid_raw_sources",
      (schema: string) => prepaidRawSourceMigrationSql(schema, rawSchema),
    ],
    ["006_prepaid_source_extractions", prepaidSourceExtractionMigrationSql],
    ["007_prepaid_backend_source_context", prepaidSourceBackendMigrationSql],
    [
      "008_prepaid_all_source_workflows",
      (schema: string) => prepaidAllSourceMigrationSql(schema, rawSchema),
    ],
    ["009_prepaid_reference_refresh", prepaidReferenceRefreshMigrationSql],
    ["010_prepaid_accounting_parity", prepaidAccountingParityMigrationSql],
    ["011_prepaid_reference_lookup", prepaidReferenceLookupMigrationSql],
    ["012_prepaid_reference_policy", prepaidReferencePolicyMigrationSql],
    ["013_prepaid_reference_catalog", prepaidReferenceCatalogMigrationSql],
    ["014_prepaid_validation_review", prepaidValidationReviewMigrationSql],
    ["015_prepaid_full_batch", prepaidFullBatchMigrationSql],
    [
      "016_prepaid_layout_tax_rate_guard",
      (schema: string) => `
      ALTER TABLE "${schema}".prepaid_region_revisions
      ADD CONSTRAINT prepaid_layout_tax_rate_nonzero_multiplier CHECK (tax_rate <> -1);
    `,
    ],
  ] as const;
}

/** Caller owns BEGIN/COMMIT/ROLLBACK. Never runs general Portal migrations. */
export async function migratePrepaid(
  connection: MigrationConnection,
  schema: string,
  rawSchema = prepaidRawSchema,
) {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema))
    throw new Error("Invalid Prepaid database schema");
  const s = `"${schema}"`;
  await connection.query("SET LOCAL lock_timeout='10s'");
  await connection.query("SET LOCAL statement_timeout='60s'");
  await connection.query("SELECT pg_advisory_xact_lock(hashtext($1))::text", [
    `${schema}.prepaid.migrations`,
  ]);
  const prerequisites = await connection.query(
    "SELECT to_regclass($1)::text workspace,to_regclass($2)::text account",
    [`${s}.workspaces`, `${s}.app_user`],
  );
  if (!prerequisites.rows[0]?.workspace || !prerequisites.rows[0]?.account)
    throw new Error(
      "Existing Portal workspace/auth migrations must already be installed. They are not run by this command.",
    );
  await connection.query(
    "SELECT pg_catalog.set_config('search_path', $1, true)",
    [`${s}, pg_temp`],
  );
  await connection.query(
    `CREATE TABLE IF NOT EXISTS ${s}.prepaid_schema_migrations(id text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())`,
  );
  const applied: string[] = [];
  for (const [id, sql] of prepaidMigrations(rawSchema)) {
    const found = await connection.query(
      "SELECT 1 FROM prepaid_schema_migrations WHERE id=$1",
      [id],
    );
    if (found.rows.length) continue;
    await connection.query(sql(schema));
    await connection.query(
      "INSERT INTO prepaid_schema_migrations(id) VALUES($1)",
      [id],
    );
    applied.push(id);
  }
  // A recorded migration must not conceal a subsequently removed table.
  for (const [id, sql] of prepaidMigrations(rawSchema)) {
    for (const match of sql(schema).matchAll(
      /CREATE TABLE(?: IF NOT EXISTS)?\s+("[^"]+"\.(?:"[^"]+"|[a-z_][a-z0-9_]*))/g,
    )) {
      const target = match[1];
      const result = await connection.query(
        "SELECT to_regclass($1)::text relation",
        [target],
      );
      if (!result.rows[0]?.relation)
        throw new Error(
          `Missing table from ${id}: ${target}. Restore/review schema drift; the migration ledger will not be overwritten.`,
        );
    }
  }
  await connection.query(prepaidRawSourceValidationSql(rawSchema));
  await connection.query(prepaidAdditionalRawValidationSql(rawSchema));
  const context = await connection.query(
    "SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass($1) AND attname='context' AND atttypid='jsonb'::regtype AND NOT attisdropped",
    [`${s}.prepaid_source_extractions`],
  );
  if (!context.rows.length)
    throw Error(
      "Missing/incompatible backend source context from migration 007. Restore/review schema drift; existing data is preserved.",
    );
  const workflows = await connection.query(
    "WITH workflow_constraint AS MATERIALIZED (SELECT oid FROM pg_constraint WHERE conrelid=to_regclass($1) AND conname='prepaid_source_extractions_workflow_check' AND contype='c' AND convalidated) SELECT pg_get_constraintdef(oid) definition FROM workflow_constraint",
    [`${s}.prepaid_source_extractions`],
  );
  const definition = String(workflows.rows[0]?.definition ?? "");
  const required = [
    "ke24",
    "callcard_eg",
    "callcard_sg",
    "load_up_eg",
    "load_up_sg",
    "load_api_eg",
    "load_api_sg",
    "monthly_recharge",
    "adjustments_308",
    "charges_318",
  ];
  if (required.some((workflow) => !definition.includes("'" + workflow + "'")))
    throw Error(
      "Missing/incompatible workflow constraint from migration 008. Restore/review schema drift; existing data is preserved.",
    );
  return applied;
}
