import { processingPipelineSeedRequirements } from "./processingPipelineCatalog.js";

// Historical migrations 002–004 retain their original database identifiers.
const billingCycleSeedRequirements = processingPipelineSeedRequirements.map((requirement) => ({
  pipelineLabel: requirement.pipelineCode,
  pipelineCode: requirement.pipelineCode,
  status: requirement.stage,
  fileName: requirement.fileName,
  match: requirement.match,
  legacySsisPackage: requirement.legacyPackageName,
  etlJobName: requirement.jobName,
}));

function quote(value: string | null) { return value === null ? "NULL" : `'${value.replace(/'/g, "''")}'`; }

function billingCycleSeedSql() {
  const pipelines = [...new Map(billingCycleSeedRequirements.map((row) => [row.pipelineCode, row])).values()];
  return `
    INSERT INTO billing_cycle_statuses (code, label, display_order) VALUES
      ('inbound', 'Inbound', 1), ('outbound', 'Outbound', 2), ('processed', 'Processed', 3), ('error', 'Error', 4)
    ON CONFLICT (code) DO UPDATE SET label = EXCLUDED.label, display_order = EXCLUDED.display_order;
    ${pipelines.map((row, index) => `INSERT INTO billing_cycle_pipelines (code, label, display_order) VALUES (${quote(row.pipelineCode)}, ${quote(row.pipelineLabel)}, ${index + 1}) ON CONFLICT (code) DO UPDATE SET label = EXCLUDED.label, display_order = EXCLUDED.display_order;`).join("\n")}
    ${billingCycleExpectedFileUpsertSql(billingCycleSeedRequirements)}
  `;
}

function billingCycleExpectedFileUpsertSql(requirements: readonly typeof billingCycleSeedRequirements[number][]) {
  return requirements.map((row, index) => `INSERT INTO billing_cycle_expected_files (pipeline_id, status_code, file_name, match_type, legacy_ssis_package, etl_job_name, display_order) SELECT id, ${quote(row.status)}, ${quote(row.fileName)}, ${quote(row.match)}, ${quote(row.legacySsisPackage)}, ${quote(row.etlJobName)}, ${index + 1} FROM billing_cycle_pipelines WHERE code = ${quote(row.pipelineCode)} ON CONFLICT (pipeline_id, status_code, file_name) DO UPDATE SET match_type = EXCLUDED.match_type, legacy_ssis_package = EXCLUDED.legacy_ssis_package, etl_job_name = EXCLUDED.etl_job_name, display_order = EXCLUDED.display_order;`).join("\n");
}

export const migrations = [{
  id: "001_initial",
  sql: `
    CREATE TABLE IF NOT EXISTS users (
      id uuid PRIMARY KEY,
      email text NOT NULL UNIQUE,
      password_hash text NOT NULL,
      is_bootstrap_admin boolean NOT NULL DEFAULT false,
      is_active boolean NOT NULL DEFAULT true,
      must_change_password boolean NOT NULL DEFAULT false,
      token_version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS workspaces (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS workflow_states (
      id uuid PRIMARY KEY,
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      module text NOT NULL,
      state_key text NOT NULL,
      data jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (workspace_id, module, state_key)
    );
    CREATE TABLE IF NOT EXISTS uploads (
      id uuid PRIMARY KEY,
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      workflow text NOT NULL,
      slot text,
      original_name text NOT NULL,
      object_key text NOT NULL UNIQUE,
      size integer NOT NULL,
      content_type text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uploads_unique_slot ON uploads (workspace_id, workflow, slot) WHERE slot IS NOT NULL;
    CREATE TABLE IF NOT EXISTS workflow_runs (
      id uuid PRIMARY KEY,
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      workflow text NOT NULL,
      status text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS audit_actions (
      id uuid PRIMARY KEY,
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      action text NOT NULL,
      detail jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `,
}, {
  id: "002_billing_cycle_catalogue",
  sql: `
    CREATE TABLE IF NOT EXISTS billing_cycle_pipelines (
      id bigserial PRIMARY KEY,
      code text NOT NULL UNIQUE,
      label text NOT NULL,
      display_order integer NOT NULL,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS billing_cycle_statuses (
      code text PRIMARY KEY,
      label text NOT NULL,
      display_order integer NOT NULL,
      is_active boolean NOT NULL DEFAULT true
    );
    CREATE TABLE IF NOT EXISTS billing_cycle_expected_files (
      id bigserial PRIMARY KEY,
      pipeline_id bigint NOT NULL REFERENCES billing_cycle_pipelines(id) ON DELETE CASCADE,
      status_code text NOT NULL REFERENCES billing_cycle_statuses(code),
      file_name text NOT NULL,
      match_type text NOT NULL CHECK (match_type IN ('exact', 'glob')),
      legacy_ssis_package text,
      etl_job_name text,
      display_order integer NOT NULL,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (pipeline_id, status_code, file_name)
    );
    CREATE INDEX IF NOT EXISTS billing_cycle_expected_files_lookup ON billing_cycle_expected_files (pipeline_id, status_code, display_order) WHERE is_active = true;
    ${billingCycleSeedSql()}
  `,
}, {
  id: "003_bayan_billing_cycle_glue_jobs",
  sql: `
    ALTER TABLE billing_cycle_expected_files ADD COLUMN IF NOT EXISTS etl_job_name text;
    ${billingCycleExpectedFileUpsertSql(billingCycleSeedRequirements.filter((row) => row.pipelineCode === "bss_billcycle_bayn"))}
  `,
}, {
  id: "004_group_bayan_billing_cycle_files",
  sql: billingCycleExpectedFileUpsertSql(billingCycleSeedRequirements.filter((row) => row.pipelineCode === "bss_billcycle_bayn")),
}, {
  id: "005_rename_billing_cycle_to_processing_pipelines",
  sql: `
    ALTER TABLE billing_cycle_pipelines RENAME TO processing_pipelines;
    ALTER TABLE billing_cycle_statuses RENAME TO processing_pipeline_stages;
    ALTER TABLE billing_cycle_expected_files RENAME TO processing_pipeline_file_requirements;
    ALTER TABLE processing_pipeline_file_requirements RENAME COLUMN status_code TO stage_code;
    ALTER TABLE processing_pipeline_file_requirements RENAME COLUMN legacy_ssis_package TO legacy_package_name;
    ALTER TABLE processing_pipeline_file_requirements RENAME COLUMN etl_job_name TO job_name;
    ALTER INDEX billing_cycle_expected_files_lookup RENAME TO processing_pipeline_file_requirements_lookup;
  `,
}];
