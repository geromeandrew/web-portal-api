import {
  prepaidAllSourceMigrationSql,
  prepaidAdditionalRawValidationSql,
} from "./allSourceMigration.js";
import { prepaidMigrationSql } from "./migrations.js";
import { prepaidWorkspaceMigrationSql } from "./workspaceMigration.js";
import { prepaidConsistencyMigrationSql } from "./consistencyMigration.js";
import { prepaidLegacyRulesMigrationSql } from "./legacyRulesMigration.js";
import { prepaidSourceExtractionMigrationSql } from "./sourceExtractionMigration.js";
import { prepaidSourceBackendMigrationSql } from "./sourceBackendMigration.js";
import { prepaidReferenceRefreshMigrationSql } from "./referenceRefreshMigration.js";
import {
  prepaidRawSchema,
  prepaidRawSourceMigrationSql,
  prepaidRawSourceValidationSql,
} from "./rawSourceMigration.js";

export interface MigrationConnection {
  query(sql: string): Promise<{ rows: Record<string, unknown>[] }>;
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
  await connection.query(
    `SELECT pg_advisory_xact_lock(hashtext('${schema}.prepaid.migrations'))::text`,
  );
  const prerequisites = await connection.query(
    `SELECT to_regclass('${s}.workspaces')::text workspace,to_regclass('${s}.app_user')::text account`,
  );
  if (!prerequisites.rows[0]?.workspace || !prerequisites.rows[0]?.account)
    throw new Error(
      "Existing Portal workspace/auth migrations must already be installed. They are not run by this command.",
    );
  await connection.query(
    `CREATE TABLE IF NOT EXISTS ${s}.prepaid_schema_migrations(id text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())`,
  );
  const applied: string[] = [];
  for (const [id, sql] of prepaidMigrations(rawSchema)) {
    const found = await connection.query(
      `SELECT 1 FROM ${s}.prepaid_schema_migrations WHERE id='${id}'`,
    );
    if (found.rows.length) continue;
    await connection.query(sql(schema));
    await connection.query(
      `INSERT INTO ${s}.prepaid_schema_migrations(id) VALUES('${id}')`,
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
        `SELECT to_regclass('${target}')::text relation`,
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
    `SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('${s}.prepaid_source_extractions') AND attname='context' AND atttypid='jsonb'::regtype AND NOT attisdropped`,
  );
  if (!context.rows.length)
    throw Error(
      "Missing/incompatible backend source context from migration 007. Restore/review schema drift; existing data is preserved.",
    );
  const workflows = await connection.query(
    `SELECT pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conrelid=to_regclass('${s}.prepaid_source_extractions') AND conname='prepaid_source_extractions_workflow_check' AND contype='c' AND convalidated`,
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
