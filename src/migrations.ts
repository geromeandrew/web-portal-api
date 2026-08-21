import {
  bayanBillCycleBatchStateMachine,
  bayanBillCycleStateMachines,
  bayanBillCycleStepFunctionMapping,
  bayanBillCycleSuffixes,
  processingPipelineSeedRequirements,
} from "./migrationSnapshots/processingPipelineCatalog010.js";
import { bayanBillCycleBatchStateMachine as refreshedBayanBillCycleBatchStateMachine } from "./processingPipelineCatalog.js";
import {
  bayanBillCycleStateMachines as refreshedBayanBillCycleStateMachines,
  globeBillCycleStateMachines,
  processingPipelineSeedRequirements as refreshedProcessingPipelineSeedRequirements,
} from "./migrationSnapshots/processingPipelineCatalogue011.js";
import {
  processingPipelineDomains,
  processingPipelineFilePurposes,
  processingPipelineFilePurpose,
  processingPipelineMetadata,
  processingPipelineSourceSystems,
} from "./migrationSnapshots/processingPipelineCatalogue006.js";

// Historical migrations 002–004 retain their original database identifiers.
const billingCycleSeedRequirements = processingPipelineSeedRequirements.map(
  (requirement) => ({
    pipelineLabel: requirement.pipelineCode,
    pipelineCode: requirement.pipelineCode,
    status: requirement.stage,
    fileName: requirement.fileName,
    match: requirement.match,
    legacySsisPackage: requirement.legacyPackageName,
    etlJobName: requirement.jobName,
  }),
);

function quote(value: string | null) {
  return value === null ? "NULL" : `'${value.replace(/'/g, "''")}'`;
}

function spreadsheetConfig(pipelineCode: string, fileName: string) {
  const s3KeyPrefix = `${pipelineCode}/inbound/`;
  const schemas: Record<string, string> = {
    bss_billcycle_glob: "sdbTDIR2_Globe",
    bss_billcycle_inov: "sdbTDIR2_Innove",
    bss_billcycle_bayn: "sdbTDIR2_Bayan",
    bss_eom_glob: "sdbTDIR2_Globe",
    bss_eom_inov: "sdbTDIR2_Innove",
    bss_eom_bayn: "sdbTDIR2_Bayan",
    memo_sst: "sdbTDIR1_MemoApp",
    iccbs_inov: "sdbTDIR1_ICCBS",
    iccbs_bayn: "sdbTDIR1_ICCBS",
    aprm_voice_accrual: "sdbTDIR3_APRM",
    aprm_voice_delta: "sdbTDIR3_APRM",
    isms_ibob_actzn: "sdbTDIP2_Actualization",
    prepaid_reclass: "sdbTDIR1_Prepaid",
  };
  const sftp =
    pipelineCode === "iccbs_inov" ||
    pipelineCode === "iccbs_bayn" ||
    pipelineCode.startsWith("aprm_voice_") ||
    pipelineCode === "north";
  const sap = pipelineCode === "north" || fileName.includes("_OUTPUT");
  return {
    acquisition: sftp ? "sftp_pull" : "web_upload",
    connection: sftp
      ? sap
        ? "SAP / AL11"
        : pipelineCode.startsWith("aprm")
          ? "REPAPD01"
          : "REPAPD"
      : null,
    host: sftp ? (sap ? "10.64.15.134" : "10.66.5.41") : null,
    directory:
      pipelineCode === "iccbs_inov"
        ? "/REP02/ICCBS"
        : pipelineCode === "iccbs_bayn"
          ? "/REP02/ICCBS/REVASSURANCE/BILLRUN/I_B_FAL_ACCTG"
          : pipelineCode.startsWith("aprm") && sap
            ? "/gt/interface/FI/TDI/APRM/Outbound/Voice"
            : pipelineCode.startsWith("aprm")
              ? "/DEV01_SWNRPD01/MYBSS/RASI/MONTHLY/INTERCONNECT"
              : pipelineCode === "north"
                ? "TBD"
                : null,
    user: sftp ? (sap ? "T1_TDI_TOSAP_SFTP" : "tdi_toiccbs_sftp") : null,
    auth: sftp ? "RSA key / passwordless" : null,
    schedule:
      pipelineCode === "iccbs_bayn"
        ? "1st and 2nd day of the month"
        : pipelineCode === "iccbs_inov" || pipelineCode === "aprm_voice_accrual"
          ? "2nd day of the month"
          : pipelineCode === "aprm_voice_delta"
            ? "26th day of the month"
            : pipelineCode === "north"
              ? "Daily"
              : null,
    rules: pipelineCode.startsWith("bss_billcycle_")
      ? "For bill cycles, remove the date suffix and rename as <Entity>_<BillCycle>.xlsx."
      : pipelineCode === "memo_sst"
        ? "Rename as <FileType>_<SequentialSuffix>.xlsx."
        : null,
    s3KeyPrefix,
    schema: schemas[pipelineCode] ?? null,
  };
}

function destinationTables(pipelineCode: string, fileName: string) {
  const exact: Record<string, string[]> = {
    "bss_billcycle_glob|308. Billed Adjustments Monthly Summary Report_G_01.XLSX":
      ["308_Billed_Adjustments_ssis"],
    "bss_billcycle_glob|318. Billed Charges Summary Report_G_01.XLSX": [
      "318_Billed_Charges_ssis",
    ],
    "bss_billcycle_glob|411. Bill Control_PHP_G_01.XLSX": [
      "411_Bill_Control_ssis",
    ],
    "bss_billcycle_glob|sap_glbilled_G_01.txt": ["sapglbilled_ssis"],
    "bss_eom_glob|Unconfirmed Advanced MSF Charges Summary Report - Monthly.xlsx":
      [
        "Unconfirmed_Advanced_MSF_Charges",
        "DP5_Unconfirmed_Advance_MSF_header",
      ],
    "isms_ibob_actzn|ACT_ISMS_IB_OB_01.xlsx": [
      "APMI_RAW",
      "SUMMARY_OF_INVOICE_INBOUND",
      "SUMMARY_OF_INVOICE_OUTBOUND",
    ],
    "isms_ibob_actzn|ACT_ISMS_IB_OB_02.xlsx": ["SUMMARY_ACCRUAL_OB"],
    "prepaid_reclass|308. Billed Adjustments Monthly Summary Report_G_BC21.XLSX":
      [
        "Billed_Adjustments_Header_Cycles",
        "Billed_Adjustments_LineItem_Cycles",
      ],
    "prepaid_reclass|318. Billed Charges Summary Report_G_BC27.xlsx": [
      "Billed_Charges_Header_Cycles",
      "Billed_Charges_LineItem_Cycles",
    ],
    "prepaid_reclass|CALLCARD_SG.xlsx": ["dcCallCard_SG"],
    "prepaid_reclass|CALLCARD_EG.xlsx": ["dcManualCallCard"],
    "prepaid_reclass|LOAD API_EG.xlsx": ["dcLoad_API"],
    "prepaid_reclass|Load API_SG.xlsx": ["dcLoad_API_SG"],
    "prepaid_reclass|LOAD UP_EG.xlsx": ["dcLoad_UP"],
    "prepaid_reclass|Load UP_SG.xlsx": ["dcLoad_UP_SG"],
    "prepaid_reclass|DL_Monthly_Recharge_summary_report.csv": [
      "dcMonthlyRechargeSummary",
    ],
    "prepaid_reclass|KE24.xlsx": ["dcKE24"],
  };
  const key = `${pipelineCode}|${fileName}`;
  if (exact[key]) return exact[key];
  if (pipelineCode === "memo_sst") return ["PaymentRequests_38Cols_ssis"];
  if (pipelineCode === "isms_iot_da")
    return fileName === "Non_Group_1.xlsx"
      ? ["DetailsTapIn_ssis", "DetailsTapOut_ssis"]
      : ["DetailsTapIn_ssis"];
  if (pipelineCode.startsWith("aprm_voice_accrual"))
    return [fileName.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9]+/g, "_")];
  if (pipelineCode.startsWith("aprm_voice_delta"))
    return [fileName.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9]+/g, "_")];
  if (pipelineCode === "iccbs_inov" || pipelineCode === "iccbs_bayn")
    return [
      fileName.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9]+/g, "_") + "_ssis",
    ];
  if (
    pipelineCode.startsWith("bss_billcycle_") ||
    pipelineCode.startsWith("bss_eom_")
  )
    return [fileName.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9]+/g, "_")];
  return [];
}

function billingCycleSeedSql() {
  const pipelines = [
    ...new Map(
      billingCycleSeedRequirements.map((row) => [row.pipelineCode, row]),
    ).values(),
  ];
  return `
    INSERT INTO billing_cycle_statuses (code, label, display_order) VALUES
      ('inbound', 'Inbound', 1), ('outbound', 'Outbound', 2), ('processed', 'Processed', 3), ('error', 'Error', 4)
    ON CONFLICT (code) DO UPDATE SET label = EXCLUDED.label, display_order = EXCLUDED.display_order;
    ${pipelines.map((row, index) => `INSERT INTO billing_cycle_pipelines (code, label, display_order) VALUES (${quote(row.pipelineCode)}, ${quote(row.pipelineLabel)}, ${index + 1}) ON CONFLICT (code) DO UPDATE SET label = EXCLUDED.label, display_order = EXCLUDED.display_order;`).join("\n")}
    ${billingCycleExpectedFileUpsertSql(billingCycleSeedRequirements)}
  `;
}

function billingCycleExpectedFileUpsertSql(
  requirements: readonly (typeof billingCycleSeedRequirements)[number][],
) {
  return requirements
    .map(
      (row, index) =>
        `INSERT INTO billing_cycle_expected_files (pipeline_id, status_code, file_name, match_type, legacy_ssis_package, etl_job_name, display_order) SELECT id, ${quote(row.status)}, ${quote(row.fileName)}, ${quote(row.match)}, ${quote(row.legacySsisPackage)}, ${quote(row.etlJobName)}, ${index + 1} FROM billing_cycle_pipelines WHERE code = ${quote(row.pipelineCode)} ON CONFLICT (pipeline_id, status_code, file_name) DO UPDATE SET match_type = EXCLUDED.match_type, legacy_ssis_package = EXCLUDED.legacy_ssis_package, etl_job_name = EXCLUDED.etl_job_name, display_order = EXCLUDED.display_order;`,
    )
    .join("\n");
}

const bayanStepFunctionSeedMappings = processingPipelineSeedRequirements
  .filter(
    (requirement) =>
      requirement.pipelineCode === "bss_billcycle_bayn" &&
      requirement.stage === "inbound",
  )
  .flatMap((requirement) => {
    const mapping = bayanBillCycleStepFunctionMapping(requirement.fileName);
    return mapping ? [{ requirement, mapping }] : [];
  });
const bayanBatchFileDisplayOrder = Object.fromEntries(
  Object.values(bayanBillCycleStateMachines).map((stateMachine, index) => [
    stateMachine.code,
    index + 1,
  ]),
);

const refreshedPipelineCodes = [
  "bss_billcycle_bayn",
  "bss_billcycle_glob",
  "bss_billcycle_inov",
  "bss_eom_glob",
  "bss_eom_inov",
  "bss_eom_bayn",
  "memo_sst",
  "iccbs_bayn",
  "prepaid_reclass",
] as const;
const refreshedRequirements =
  refreshedProcessingPipelineSeedRequirements.filter((requirement) =>
    refreshedPipelineCodes.includes(
      requirement.pipelineCode as (typeof refreshedPipelineCodes)[number],
    ),
  );

function refreshedRequirementUpsertSql(
  requirement: (typeof refreshedRequirements)[number],
  index: number,
) {
  const config = spreadsheetConfig(
    requirement.pipelineCode,
    requirement.fileName,
  );
  return `INSERT INTO processing_pipeline_file_requirements (pipeline_id, stage_code, file_name, match_type, legacy_package_name, job_name, display_order, is_active, acquisition_method, source_connection_name, remote_sftp_host, remote_sftp_source_directory, sftp_username, sftp_authentication, schedule_description, source_file_pull_rename_rules, s3_key_prefix, database_schema_destination)
    SELECT id, ${quote(requirement.stage)}, ${quote(requirement.fileName)}, ${quote(requirement.match)}, ${quote(requirement.legacyPackageName)}, NULL, ${index + 1}, true, ${quote(config.acquisition)}, ${quote(config.connection)}, ${quote(config.host)}, ${quote(config.directory)}, ${quote(config.user)}, ${quote(config.auth)}, ${quote(config.schedule)}, ${quote(config.rules)}, ${quote(config.s3KeyPrefix)}, ${quote(config.schema)} FROM processing_pipelines WHERE code = ${quote(requirement.pipelineCode)}
    ON CONFLICT (pipeline_id, stage_code, file_name) DO UPDATE SET match_type = EXCLUDED.match_type, legacy_package_name = EXCLUDED.legacy_package_name, job_name = NULL, display_order = EXCLUDED.display_order, is_active = true, acquisition_method = EXCLUDED.acquisition_method, source_connection_name = EXCLUDED.source_connection_name, remote_sftp_host = EXCLUDED.remote_sftp_host, remote_sftp_source_directory = EXCLUDED.remote_sftp_source_directory, sftp_username = EXCLUDED.sftp_username, sftp_authentication = EXCLUDED.sftp_authentication, schedule_description = EXCLUDED.schedule_description, source_file_pull_rename_rules = EXCLUDED.source_file_pull_rename_rules, s3_key_prefix = EXCLUDED.s3_key_prefix, database_schema_destination = EXCLUDED.database_schema_destination, updated_at = now();`;
}

function deactivateSupersededRequirementsSql(
  pipelineCode: (typeof refreshedPipelineCodes)[number],
) {
  const names = refreshedRequirements
    .filter((requirement) => requirement.pipelineCode === pipelineCode)
    .map((requirement) => quote(requirement.fileName))
    .join(", ");
  return `UPDATE processing_pipeline_file_requirements SET is_active = false, updated_at = now() WHERE pipeline_id = (SELECT id FROM processing_pipelines WHERE code = ${quote(pipelineCode)}) AND stage_code = 'inbound' AND file_name NOT IN (${names});`;
}

function refreshedStepFunctionMapping(
  fileName: string,
  pipelineCode: "bss_billcycle_bayn" | "bss_billcycle_glob",
) {
  const cycle = fileName.match(/_(\d{2})(?=\.[^.]+$)/)?.[1];
  if (!cycle) return null;
  const machines =
    pipelineCode === "bss_billcycle_bayn"
      ? refreshedBayanBillCycleStateMachines
      : globeBillCycleStateMachines;
  const code = fileName.startsWith("308.")
    ? machines.billedAdjustments.code
    : fileName.startsWith("318.")
      ? machines.billedCharges.code
      : fileName.startsWith("411. Bill Control_PHP")
        ? machines.billControlPhp.code
        : fileName.startsWith("411. Bill Control_USD") &&
            pipelineCode === "bss_billcycle_bayn"
          ? refreshedBayanBillCycleStateMachines.billControlUsd.code
          : fileName.startsWith("sap_glbilled")
            ? machines.sapGlbilled.code
            : null;
  return code ? { code, cycle } : null;
}

const refreshedAdhocMappings = refreshedRequirements.flatMap((requirement) =>
  requirement.pipelineCode === "bss_billcycle_bayn" ||
  requirement.pipelineCode === "bss_billcycle_glob"
    ? (() => {
        const mapping = refreshedStepFunctionMapping(
          requirement.fileName,
          requirement.pipelineCode,
        );
        return mapping ? [{ requirement, mapping }] : [];
      })()
    : [],
);

export const migrations = [
  {
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
  },
  {
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
  },
  {
    id: "003_bayan_billing_cycle_glue_jobs",
    sql: `
    ALTER TABLE billing_cycle_expected_files ADD COLUMN IF NOT EXISTS etl_job_name text;
    ${billingCycleExpectedFileUpsertSql(billingCycleSeedRequirements.filter((row) => row.pipelineCode === "bss_billcycle_bayn"))}
  `,
  },
  {
    id: "004_group_bayan_billing_cycle_files",
    sql: billingCycleExpectedFileUpsertSql(
      billingCycleSeedRequirements.filter(
        (row) => row.pipelineCode === "bss_billcycle_bayn",
      ),
    ),
  },
  {
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
  },
  {
    id: "006_processing_pipeline_catalogue_and_runs",
    sql: `
    CREATE TABLE IF NOT EXISTS processing_pipeline_domains (
      id bigserial PRIMARY KEY, code text NOT NULL UNIQUE, label text NOT NULL, description text NOT NULL,
      display_order integer NOT NULL, is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS processing_pipeline_source_systems (
      id bigserial PRIMARY KEY, code text NOT NULL UNIQUE, label text NOT NULL, description text NOT NULL,
      display_order integer NOT NULL, is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS processing_pipeline_file_purposes (
      id bigserial PRIMARY KEY, code text NOT NULL UNIQUE, label text NOT NULL, description text NOT NULL,
      display_order integer NOT NULL, is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE processing_pipelines ADD COLUMN IF NOT EXISTS description text;
    ALTER TABLE processing_pipelines ADD COLUMN IF NOT EXISTS domain_id bigint REFERENCES processing_pipeline_domains(id);
    ALTER TABLE processing_pipelines ADD COLUMN IF NOT EXISTS source_system_id bigint REFERENCES processing_pipeline_source_systems(id);
    ALTER TABLE processing_pipeline_file_requirements ADD COLUMN IF NOT EXISTS file_purpose_id bigint REFERENCES processing_pipeline_file_purposes(id);
    ${processingPipelineDomains.map(([code, label, description], index) => `INSERT INTO processing_pipeline_domains (code, label, description, display_order) VALUES (${quote(code)}, ${quote(label)}, ${quote(description)}, ${index + 1}) ON CONFLICT (code) DO UPDATE SET label = EXCLUDED.label, description = EXCLUDED.description, display_order = EXCLUDED.display_order, updated_at = now();`).join("\n")}
    ${processingPipelineSourceSystems.map(([code, label, description], index) => `INSERT INTO processing_pipeline_source_systems (code, label, description, display_order) VALUES (${quote(code)}, ${quote(label)}, ${quote(description)}, ${index + 1}) ON CONFLICT (code) DO UPDATE SET label = EXCLUDED.label, description = EXCLUDED.description, display_order = EXCLUDED.display_order, updated_at = now();`).join("\n")}
    ${processingPipelineFilePurposes.map(([code, label, description], index) => `INSERT INTO processing_pipeline_file_purposes (code, label, description, display_order) VALUES (${quote(code)}, ${quote(label)}, ${quote(description)}, ${index + 1}) ON CONFLICT (code) DO UPDATE SET label = EXCLUDED.label, description = EXCLUDED.description, display_order = EXCLUDED.display_order, updated_at = now();`).join("\n")}
    ${Object.values(processingPipelineMetadata)
      .map(
        (pipeline) =>
          `UPDATE processing_pipelines SET label = ${quote(pipeline.label)}, description = ${quote(pipeline.description)}, domain_id = (SELECT id FROM processing_pipeline_domains WHERE code = ${quote(pipeline.domainCode)}), source_system_id = (SELECT id FROM processing_pipeline_source_systems WHERE code = ${quote(pipeline.sourceSystemCode)}), updated_at = now() WHERE code = ${quote(pipeline.code)};`,
      )
      .join("\n")}
    ${processingPipelineSeedRequirements.map((requirement) => `UPDATE processing_pipeline_file_requirements SET file_purpose_id = (SELECT id FROM processing_pipeline_file_purposes WHERE code = ${quote(processingPipelineFilePurpose(requirement.pipelineCode, requirement.fileName))}), updated_at = now() WHERE pipeline_id = (SELECT id FROM processing_pipelines WHERE code = ${quote(requirement.pipelineCode)}) AND stage_code = ${quote(requirement.stage)} AND file_name = ${quote(requirement.fileName)};`).join("\n")}
    ALTER TABLE processing_pipelines ALTER COLUMN description SET NOT NULL;
    ALTER TABLE processing_pipelines ALTER COLUMN domain_id SET NOT NULL;
    ALTER TABLE processing_pipelines ALTER COLUMN source_system_id SET NOT NULL;
    ALTER TABLE processing_pipeline_file_requirements ALTER COLUMN file_purpose_id SET NOT NULL;
    CREATE INDEX IF NOT EXISTS processing_pipelines_catalogue_lookup ON processing_pipelines (domain_id, source_system_id, display_order, code) WHERE is_active = true;
    CREATE INDEX IF NOT EXISTS processing_pipeline_requirements_purpose_lookup ON processing_pipeline_file_requirements (file_purpose_id, stage_code, display_order) WHERE is_active = true;
    CREATE TABLE IF NOT EXISTS processing_pipeline_runs (
      id uuid PRIMARY KEY, processing_pipeline_file_requirement_id bigint NOT NULL REFERENCES processing_pipeline_file_requirements(id) ON DELETE RESTRICT,
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, started_by_user_id uuid NOT NULL REFERENCES users(id),
      glue_job_run_id text NOT NULL UNIQUE, job_name text NOT NULL, object_key text NOT NULL, status text NOT NULL,
      error_message text, started_at timestamptz NOT NULL, completed_at timestamptz, last_observed_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS processing_pipeline_runs_requirement_started ON processing_pipeline_runs (processing_pipeline_file_requirement_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS processing_pipeline_runs_status_started ON processing_pipeline_runs (status, started_at DESC);
  `,
  },
  {
    id: "007_align_processing_pipeline_configuration",
    sql: `
    DROP TABLE IF EXISTS processing_pipeline_runs;
    DROP INDEX IF EXISTS processing_pipelines_catalogue_lookup;
    DROP INDEX IF EXISTS processing_pipeline_requirements_purpose_lookup;
    ALTER TABLE processing_pipeline_file_requirements DROP COLUMN IF EXISTS file_purpose_id CASCADE;
    ALTER TABLE processing_pipelines DROP COLUMN IF EXISTS domain_id CASCADE;
    ALTER TABLE processing_pipelines DROP COLUMN IF EXISTS source_system_id CASCADE;
    ALTER TABLE processing_pipelines DROP COLUMN IF EXISTS description CASCADE;
    DROP TABLE IF EXISTS processing_pipeline_file_purposes;
    DROP TABLE IF EXISTS processing_pipeline_source_systems;
    DROP TABLE IF EXISTS processing_pipeline_domains;
    ALTER TABLE processing_pipeline_file_requirements ADD COLUMN IF NOT EXISTS acquisition_method text NOT NULL DEFAULT 'web_upload' CHECK (acquisition_method IN ('web_upload', 'sftp_pull'));
    ALTER TABLE processing_pipeline_file_requirements ADD COLUMN IF NOT EXISTS source_connection_name text;
    ALTER TABLE processing_pipeline_file_requirements ADD COLUMN IF NOT EXISTS remote_sftp_host text;
    ALTER TABLE processing_pipeline_file_requirements ADD COLUMN IF NOT EXISTS remote_sftp_source_directory text;
    ALTER TABLE processing_pipeline_file_requirements ADD COLUMN IF NOT EXISTS sftp_username text;
    ALTER TABLE processing_pipeline_file_requirements ADD COLUMN IF NOT EXISTS sftp_authentication text;
    ALTER TABLE processing_pipeline_file_requirements ADD COLUMN IF NOT EXISTS schedule_description text;
    ALTER TABLE processing_pipeline_file_requirements ADD COLUMN IF NOT EXISTS source_file_pull_rename_rules text;
    ALTER TABLE processing_pipeline_file_requirements ADD COLUMN IF NOT EXISTS s3_key_prefix text NOT NULL DEFAULT '';
    ALTER TABLE processing_pipeline_file_requirements ADD COLUMN IF NOT EXISTS database_schema_destination text;
    CREATE TABLE IF NOT EXISTS processing_pipeline_file_destinations (
      id bigserial PRIMARY KEY, file_requirement_id bigint NOT NULL REFERENCES processing_pipeline_file_requirements(id) ON DELETE CASCADE,
      table_name text NOT NULL, display_order integer NOT NULL, UNIQUE (file_requirement_id, table_name)
    );
    CREATE TABLE IF NOT EXISTS processing_pipeline_file_job_mappings (
      id bigserial PRIMARY KEY, file_requirement_id bigint NOT NULL REFERENCES processing_pipeline_file_requirements(id) ON DELETE CASCADE,
      bill_cycle text NOT NULL, legacy_file_name text NOT NULL, job_name text NOT NULL, display_order integer NOT NULL, is_active boolean NOT NULL DEFAULT true,
      UNIQUE (file_requirement_id, bill_cycle), UNIQUE (legacy_file_name)
    );
    UPDATE processing_pipeline_file_requirements SET file_name = 'INV?????.txt' WHERE pipeline_id = (SELECT id FROM processing_pipelines WHERE code = 'north') AND file_name = 'NV?????.txt';
    ${processingPipelineSeedRequirements
      .map((requirement) => {
        const config = spreadsheetConfig(
          requirement.pipelineCode,
          requirement.fileName,
        );
        return `UPDATE processing_pipeline_file_requirements SET acquisition_method = ${quote(config.acquisition)}, source_connection_name = ${quote(config.connection)}, remote_sftp_host = ${quote(config.host)}, remote_sftp_source_directory = ${quote(config.directory)}, sftp_username = ${quote(config.user)}, sftp_authentication = ${quote(config.auth)}, schedule_description = ${quote(config.schedule)}, source_file_pull_rename_rules = ${quote(config.rules)}, s3_key_prefix = ${quote(config.s3KeyPrefix)}, database_schema_destination = ${quote(config.schema)}, updated_at = now() WHERE pipeline_id = (SELECT id FROM processing_pipelines WHERE code = ${quote(requirement.pipelineCode)}) AND stage_code = ${quote(requirement.stage)} AND file_name = ${quote(requirement.fileName)};`;
      })
      .join("\n")}
    UPDATE processing_pipeline_file_requirements SET acquisition_method = 'sftp_pull', source_connection_name = 'SAP / AL11', remote_sftp_host = '10.64.15.134', remote_sftp_source_directory = 'TBD', sftp_username = 'T1_TDI_TOSAP_SFTP', sftp_authentication = 'RSA key / passwordless', schedule_description = 'Daily', s3_key_prefix = 'north/inbound/' WHERE pipeline_id = (SELECT id FROM processing_pipelines WHERE code = 'north') AND file_name = 'INV?????.txt';
    ${processingPipelineSeedRequirements.flatMap((requirement) => destinationTables(requirement.pipelineCode, requirement.fileName).map((tableName, index) => `INSERT INTO processing_pipeline_file_destinations (file_requirement_id, table_name, display_order) SELECT id, ${quote(tableName)}, ${index + 1} FROM processing_pipeline_file_requirements WHERE pipeline_id = (SELECT id FROM processing_pipelines WHERE code = ${quote(requirement.pipelineCode)}) AND stage_code = ${quote(requirement.stage)} AND file_name = ${quote(requirement.fileName)} ON CONFLICT (file_requirement_id, table_name) DO UPDATE SET display_order = EXCLUDED.display_order;`)).join("\n")}
    ${processingPipelineSeedRequirements
      .filter((requirement) => requirement.jobName)
      .map(
        (requirement, index) =>
          `INSERT INTO processing_pipeline_file_job_mappings (file_requirement_id, bill_cycle, legacy_file_name, job_name, display_order) SELECT id, ${quote(requirement.fileName.match(/_(\d{2})(?=\.[^.]+$)/)?.[1] ?? "default")}, ${quote(requirement.fileName)}, ${quote(requirement.jobName)}, ${index + 1} FROM processing_pipeline_file_requirements WHERE pipeline_id = (SELECT id FROM processing_pipelines WHERE code = ${quote(requirement.pipelineCode)}) AND stage_code = ${quote(requirement.stage)} AND file_name = ${quote(requirement.fileName)} ON CONFLICT (file_requirement_id, bill_cycle) DO UPDATE SET legacy_file_name = EXCLUDED.legacy_file_name, job_name = EXCLUDED.job_name, display_order = EXCLUDED.display_order;`,
      )
      .join("\n")}
    CREATE INDEX IF NOT EXISTS processing_pipeline_file_destinations_lookup ON processing_pipeline_file_destinations (file_requirement_id, display_order);
    CREATE INDEX IF NOT EXISTS processing_pipeline_file_job_mappings_lookup ON processing_pipeline_file_job_mappings (file_requirement_id, display_order) WHERE is_active = true;
  `,
  },
  {
    id: "008_bayan_bill_cycle_step_functions",
    sql: `
    CREATE TABLE IF NOT EXISTS processing_pipeline_step_function_state_machines (
      id bigserial PRIMARY KEY,
      code text NOT NULL UNIQUE,
      state_machine_name text NOT NULL UNIQUE,
      display_order integer NOT NULL,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS processing_pipeline_file_step_function_mappings (
      id bigserial PRIMARY KEY,
      file_requirement_id bigint NOT NULL UNIQUE REFERENCES processing_pipeline_file_requirements(id) ON DELETE CASCADE,
      state_machine_id bigint NOT NULL REFERENCES processing_pipeline_step_function_state_machines(id) ON DELETE RESTRICT,
      batch_cycle text NOT NULL CHECK (batch_cycle IN (${bayanBillCycleSuffixes.map(quote).join(", ")})),
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS processing_pipeline_step_function_executions (
      id uuid PRIMARY KEY,
      file_step_function_mapping_id bigint NOT NULL REFERENCES processing_pipeline_file_step_function_mappings(id) ON DELETE RESTRICT,
      execution_arn text NOT NULL UNIQUE,
      object_key text NOT NULL,
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      started_by_user_id uuid NOT NULL REFERENCES users(id),
      status text NOT NULL,
      error_message text,
      started_at timestamptz NOT NULL,
      completed_at timestamptz,
      last_observed_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    ${Object.values(bayanBillCycleStateMachines)
      .map(
        (stateMachine, index) =>
          `INSERT INTO processing_pipeline_step_function_state_machines (code, state_machine_name, display_order) VALUES (${quote(stateMachine.code)}, ${quote(stateMachine.name)}, ${index + 1}) ON CONFLICT (code) DO UPDATE SET state_machine_name = EXCLUDED.state_machine_name, display_order = EXCLUDED.display_order, is_active = true, updated_at = now();`,
      )
      .join("\n")}
    UPDATE processing_pipeline_file_requirements SET job_name = NULL, updated_at = now() WHERE pipeline_id = (SELECT id FROM processing_pipelines WHERE code = 'bss_billcycle_bayn');
    DELETE FROM processing_pipeline_file_job_mappings WHERE file_requirement_id IN (SELECT requirement.id FROM processing_pipeline_file_requirements requirement JOIN processing_pipelines pipeline ON pipeline.id = requirement.pipeline_id WHERE pipeline.code = 'bss_billcycle_bayn');
    ${bayanStepFunctionSeedMappings.map(({ requirement, mapping }) => `INSERT INTO processing_pipeline_file_step_function_mappings (file_requirement_id, state_machine_id, batch_cycle) SELECT requirement.id, state_machine.id, ${quote(mapping.batchCycle)} FROM processing_pipeline_file_requirements requirement JOIN processing_pipelines pipeline ON pipeline.id = requirement.pipeline_id JOIN processing_pipeline_step_function_state_machines state_machine ON state_machine.code = ${quote(mapping.stateMachineCode)} WHERE pipeline.code = ${quote(requirement.pipelineCode)} AND requirement.stage_code = ${quote(requirement.stage)} AND requirement.file_name = ${quote(requirement.fileName)} ON CONFLICT (file_requirement_id) DO UPDATE SET state_machine_id = EXCLUDED.state_machine_id, batch_cycle = EXCLUDED.batch_cycle, is_active = true, updated_at = now();`).join("\n")}
    CREATE INDEX IF NOT EXISTS processing_pipeline_file_step_function_mappings_lookup ON processing_pipeline_file_step_function_mappings (file_requirement_id) WHERE is_active = true;
    CREATE INDEX IF NOT EXISTS processing_pipeline_step_function_executions_mapping_started ON processing_pipeline_step_function_executions (file_step_function_mapping_id, started_at DESC);
  `,
  },
  {
    id: "009_generic_step_function_execution_inputs",
    sql: `
    ALTER TABLE processing_pipeline_file_step_function_mappings ALTER COLUMN batch_cycle DROP NOT NULL;
    ALTER TABLE processing_pipeline_file_step_function_mappings DROP CONSTRAINT IF EXISTS processing_pipeline_file_step_function_mappings_batch_cycle_check;
    ALTER TABLE processing_pipeline_file_step_function_mappings ADD COLUMN execution_input jsonb NOT NULL DEFAULT '{}'::jsonb;
    UPDATE processing_pipeline_file_step_function_mappings SET execution_input = jsonb_build_object('batch_cycle', batch_cycle) WHERE batch_cycle IS NOT NULL AND execution_input = '{}'::jsonb;
    ALTER TABLE processing_pipeline_file_step_function_mappings ADD CONSTRAINT processing_pipeline_file_step_function_mappings_execution_input_object CHECK (jsonb_typeof(execution_input) = 'object');
  `,
  },
  {
    id: "010_bayan_adhoc_and_batch_step_functions",
    sql: `
    UPDATE processing_pipeline_file_step_function_mappings mapping SET execution_input = jsonb_build_object('cycle', mapping.batch_cycle), updated_at = now() FROM processing_pipeline_file_requirements requirement JOIN processing_pipelines pipeline ON pipeline.id = requirement.pipeline_id WHERE requirement.id = mapping.file_requirement_id AND pipeline.code = 'bss_billcycle_bayn' AND mapping.batch_cycle IS NOT NULL;
    INSERT INTO processing_pipeline_step_function_state_machines (code, state_machine_name, display_order) VALUES (${quote(bayanBillCycleBatchStateMachine.code)}, ${quote(bayanBillCycleBatchStateMachine.name)}, 6) ON CONFLICT (code) DO UPDATE SET state_machine_name = EXCLUDED.state_machine_name, display_order = EXCLUDED.display_order, is_active = true, updated_at = now();
    CREATE TABLE processing_pipeline_batch_step_function_mappings (
      id bigserial PRIMARY KEY,
      pipeline_id bigint NOT NULL REFERENCES processing_pipelines(id) ON DELETE CASCADE,
      stage_code text NOT NULL REFERENCES processing_pipeline_stages(code),
      batch_cycle text NOT NULL CHECK (batch_cycle IN (${bayanBillCycleSuffixes.map(quote).join(", ")})),
      state_machine_id bigint NOT NULL REFERENCES processing_pipeline_step_function_state_machines(id) ON DELETE RESTRICT,
      execution_input jsonb NOT NULL CHECK (jsonb_typeof(execution_input) = 'object'),
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (pipeline_id, stage_code, batch_cycle)
    );
    CREATE TABLE processing_pipeline_batch_step_function_mapping_files (
      batch_mapping_id bigint NOT NULL REFERENCES processing_pipeline_batch_step_function_mappings(id) ON DELETE CASCADE,
      file_requirement_id bigint NOT NULL UNIQUE REFERENCES processing_pipeline_file_requirements(id) ON DELETE RESTRICT,
      display_order integer NOT NULL,
      PRIMARY KEY (batch_mapping_id, file_requirement_id)
    );
    ${bayanBillCycleSuffixes.map((cycle, index) => `INSERT INTO processing_pipeline_batch_step_function_mappings (pipeline_id, stage_code, batch_cycle, state_machine_id, execution_input) SELECT pipeline.id, 'inbound', ${quote(cycle)}, state_machine.id, ${quote(`{"batch_cycle":"${cycle}"}`)}::jsonb FROM processing_pipelines pipeline JOIN processing_pipeline_step_function_state_machines state_machine ON state_machine.code = ${quote(bayanBillCycleBatchStateMachine.code)} WHERE pipeline.code = 'bss_billcycle_bayn' ON CONFLICT (pipeline_id, stage_code, batch_cycle) DO UPDATE SET state_machine_id = EXCLUDED.state_machine_id, execution_input = EXCLUDED.execution_input, is_active = true, updated_at = now();`).join("\n")}
    ${bayanStepFunctionSeedMappings.map(({ requirement, mapping }) => `INSERT INTO processing_pipeline_batch_step_function_mapping_files (batch_mapping_id, file_requirement_id, display_order) SELECT batch_mapping.id, requirement.id, ${bayanBatchFileDisplayOrder[mapping.stateMachineCode]} FROM processing_pipeline_batch_step_function_mappings batch_mapping JOIN processing_pipelines pipeline ON pipeline.id = batch_mapping.pipeline_id JOIN processing_pipeline_file_requirements requirement ON requirement.pipeline_id = pipeline.id AND requirement.stage_code = batch_mapping.stage_code AND requirement.file_name = ${quote(requirement.fileName)} WHERE pipeline.code = ${quote(requirement.pipelineCode)} AND batch_mapping.batch_cycle = ${quote(mapping.batchCycle)} ON CONFLICT (batch_mapping_id, file_requirement_id) DO UPDATE SET display_order = EXCLUDED.display_order;`).join("\n")}
    ALTER TABLE processing_pipeline_step_function_executions ADD COLUMN batch_step_function_mapping_id bigint REFERENCES processing_pipeline_batch_step_function_mappings(id) ON DELETE RESTRICT;
    ALTER TABLE processing_pipeline_step_function_executions ALTER COLUMN file_step_function_mapping_id DROP NOT NULL;
    ALTER TABLE processing_pipeline_step_function_executions ADD COLUMN execution_input jsonb;
    ALTER TABLE processing_pipeline_step_function_executions ADD COLUMN source_files jsonb NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE processing_pipeline_step_function_executions ADD COLUMN error_code text;
    ALTER TABLE processing_pipeline_step_function_executions ADD COLUMN execution_output text;
    ALTER TABLE processing_pipeline_step_function_executions ADD COLUMN output_included boolean;
    UPDATE processing_pipeline_step_function_executions execution SET execution_input = mapping.execution_input, source_files = jsonb_build_array(jsonb_build_object('key', execution.object_key)) FROM processing_pipeline_file_step_function_mappings mapping WHERE execution.file_step_function_mapping_id = mapping.id;
    ALTER TABLE processing_pipeline_step_function_executions ALTER COLUMN execution_input SET NOT NULL;
    ALTER TABLE processing_pipeline_step_function_executions ALTER COLUMN object_key DROP NOT NULL;
    ALTER TABLE processing_pipeline_step_function_executions ADD CONSTRAINT processing_pipeline_step_function_executions_one_target CHECK ((file_step_function_mapping_id IS NOT NULL AND batch_step_function_mapping_id IS NULL) OR (file_step_function_mapping_id IS NULL AND batch_step_function_mapping_id IS NOT NULL));
    CREATE INDEX processing_pipeline_batch_step_function_mappings_lookup ON processing_pipeline_batch_step_function_mappings (pipeline_id, stage_code, batch_cycle) WHERE is_active = true;
    CREATE INDEX processing_pipeline_step_function_executions_batch_mapping_started ON processing_pipeline_step_function_executions (batch_step_function_mapping_id, started_at DESC);
  `,
  },
  {
    id: "011_processing_pipeline_catalogue_refresh",
    sql: `
    ${refreshedPipelineCodes.map(deactivateSupersededRequirementsSql).join("\n")}
    ${refreshedRequirements.map(refreshedRequirementUpsertSql).join("\n")}
    ${[...Object.values(refreshedBayanBillCycleStateMachines), ...Object.values(globeBillCycleStateMachines)].map((stateMachine, index) => `INSERT INTO processing_pipeline_step_function_state_machines (code, state_machine_name, display_order) VALUES (${quote(stateMachine.code)}, ${quote(stateMachine.name)}, ${index + 1}) ON CONFLICT (code) DO UPDATE SET state_machine_name = EXCLUDED.state_machine_name, display_order = EXCLUDED.display_order, is_active = true, updated_at = now();`).join("\n")}
    UPDATE processing_pipeline_file_step_function_mappings mapping SET is_active = false, updated_at = now() FROM processing_pipeline_file_requirements requirement JOIN processing_pipelines pipeline ON pipeline.id = requirement.pipeline_id WHERE requirement.id = mapping.file_requirement_id AND pipeline.code IN ('bss_billcycle_bayn', 'bss_billcycle_glob') AND requirement.is_active = false;
    ${refreshedAdhocMappings.map(({ requirement, mapping }) => `INSERT INTO processing_pipeline_file_step_function_mappings (file_requirement_id, state_machine_id, batch_cycle, execution_input, is_active) SELECT requirement.id, state_machine.id, ${quote(mapping.cycle)}, ${quote(`{"cycle":"${mapping.cycle}"}`)}::jsonb, true FROM processing_pipeline_file_requirements requirement JOIN processing_pipelines pipeline ON pipeline.id = requirement.pipeline_id JOIN processing_pipeline_step_function_state_machines state_machine ON state_machine.code = ${quote(mapping.code)} WHERE pipeline.code = ${quote(requirement.pipelineCode)} AND requirement.stage_code = ${quote(requirement.stage)} AND requirement.file_name = ${quote(requirement.fileName)} ON CONFLICT (file_requirement_id) DO UPDATE SET state_machine_id = EXCLUDED.state_machine_id, batch_cycle = EXCLUDED.batch_cycle, execution_input = EXCLUDED.execution_input, is_active = true, updated_at = now();`).join("\n")}
    UPDATE processing_pipeline_batch_step_function_mappings mapping SET state_machine_id = state_machine.id, execution_input = jsonb_build_object('batch_cycle', mapping.batch_cycle), is_active = true, updated_at = now() FROM processing_pipelines pipeline JOIN processing_pipeline_step_function_state_machines state_machine ON state_machine.code = ${quote(refreshedBayanBillCycleBatchStateMachine.code)} WHERE mapping.pipeline_id = pipeline.id AND pipeline.code = 'bss_billcycle_bayn';
    DELETE FROM processing_pipeline_batch_step_function_mapping_files member USING processing_pipeline_batch_step_function_mappings mapping, processing_pipelines pipeline WHERE member.batch_mapping_id = mapping.id AND mapping.pipeline_id = pipeline.id AND pipeline.code = 'bss_billcycle_bayn';
    ${refreshedAdhocMappings
      .filter(
        ({ requirement }) => requirement.pipelineCode === "bss_billcycle_bayn",
      )
      .map(
        ({ requirement, mapping }) =>
          `INSERT INTO processing_pipeline_batch_step_function_mapping_files (batch_mapping_id, file_requirement_id, display_order) SELECT batch_mapping.id, requirement.id, ${({ billedAdjustments: 1, billedCharges: 2, billControlPhp: 3, billControlUsd: 4, sapGlbilled: 5 } as Record<string, number>)[mapping.code.includes("308") ? "billedAdjustments" : mapping.code.includes("318") ? "billedCharges" : mapping.code.includes("411_php") ? "billControlPhp" : mapping.code.includes("411_usd") ? "billControlUsd" : "sapGlbilled"]} FROM processing_pipeline_batch_step_function_mappings batch_mapping JOIN processing_pipelines pipeline ON pipeline.id = batch_mapping.pipeline_id JOIN processing_pipeline_file_requirements requirement ON requirement.pipeline_id = pipeline.id AND requirement.stage_code = batch_mapping.stage_code AND requirement.file_name = ${quote(requirement.fileName)} WHERE pipeline.code = 'bss_billcycle_bayn' AND batch_mapping.batch_cycle = ${quote(mapping.cycle)} ON CONFLICT (batch_mapping_id, file_requirement_id) DO UPDATE SET display_order = EXCLUDED.display_order;`,
      )
      .join("\n")}
  `,
  },
  {
    id: "012_pipeline_file_scope_and_bayan_b_mapping",
    sql: `
    UPDATE processing_pipeline_file_requirements requirement
      SET is_active = true, s3_key_prefix = pipeline.code || '/', updated_at = now()
      FROM processing_pipelines pipeline
      WHERE requirement.pipeline_id = pipeline.id
        AND pipeline.code = 'bss_billcycle_bayn'
        AND (requirement.file_name LIKE '%_B_%' OR requirement.file_name LIKE 'sap_glbilled_b_%');
    UPDATE processing_pipeline_file_step_function_mappings mapping
      SET is_active = true, updated_at = now()
      FROM processing_pipeline_file_requirements requirement
      JOIN processing_pipelines pipeline ON pipeline.id = requirement.pipeline_id
      WHERE mapping.file_requirement_id = requirement.id
        AND pipeline.code = 'bss_billcycle_bayn'
        AND requirement.is_active
        AND (requirement.file_name LIKE '%_B_%' OR requirement.file_name LIKE 'sap_glbilled_b_%');
    UPDATE processing_pipeline_file_requirements requirement
      SET is_active = false, updated_at = now()
      FROM processing_pipelines pipeline
      WHERE requirement.pipeline_id = pipeline.id
        AND pipeline.code = 'bss_billcycle_bayn'
        AND (requirement.file_name LIKE '%_G_%' OR requirement.file_name LIKE 'sap_glbilled_G_%');
    UPDATE processing_pipeline_file_step_function_mappings mapping
      SET is_active = false, updated_at = now()
      FROM processing_pipeline_file_requirements requirement
      JOIN processing_pipelines pipeline ON pipeline.id = requirement.pipeline_id
      WHERE mapping.file_requirement_id = requirement.id
        AND pipeline.code = 'bss_billcycle_bayn'
        AND NOT requirement.is_active;
    UPDATE processing_pipeline_file_requirements requirement
      SET s3_key_prefix = pipeline.code || '/', updated_at = now()
      FROM processing_pipelines pipeline
      WHERE requirement.pipeline_id = pipeline.id AND requirement.is_active;

    DELETE FROM processing_pipeline_batch_step_function_mapping_files member
      USING processing_pipeline_batch_step_function_mappings batch, processing_pipelines pipeline
      WHERE member.batch_mapping_id = batch.id AND batch.pipeline_id = pipeline.id AND pipeline.code = 'bss_billcycle_bayn';
    INSERT INTO processing_pipeline_batch_step_function_mapping_files (batch_mapping_id, file_requirement_id, display_order)
      SELECT batch.id, requirement.id,
        CASE state_machine.code
          WHEN 'bayan_billcycle_308_preload' THEN 1
          WHEN 'bayan_billcycle_318_preload' THEN 2
          WHEN 'bayan_billcycle_411_php_preload' THEN 3
          WHEN 'bayan_billcycle_411_usd_preload' THEN 4
          ELSE 5
        END
      FROM processing_pipeline_batch_step_function_mappings batch
      JOIN processing_pipelines pipeline ON pipeline.id = batch.pipeline_id
      JOIN processing_pipeline_file_requirements requirement ON requirement.pipeline_id = pipeline.id AND requirement.is_active
      JOIN processing_pipeline_file_step_function_mappings mapping ON mapping.file_requirement_id = requirement.id AND mapping.is_active AND mapping.batch_cycle = batch.batch_cycle
      JOIN processing_pipeline_step_function_state_machines state_machine ON state_machine.id = mapping.state_machine_id
      WHERE pipeline.code = 'bss_billcycle_bayn';

    DROP INDEX IF EXISTS processing_pipeline_file_requirements_lookup;
    DROP INDEX IF EXISTS processing_pipeline_requirements_purpose_lookup;
    ALTER TABLE processing_pipeline_file_requirements DROP CONSTRAINT IF EXISTS billing_cycle_expected_files_status_code_fkey;
    ALTER TABLE processing_pipeline_file_requirements DROP CONSTRAINT IF EXISTS billing_cycle_expected_files_pipeline_id_status_code_file_n_key;
    ALTER TABLE processing_pipeline_file_requirements DROP COLUMN stage_code;
    ALTER TABLE processing_pipeline_file_requirements ADD CONSTRAINT processing_pipeline_file_requirements_pipeline_file_name_key UNIQUE (pipeline_id, file_name);
    CREATE INDEX processing_pipeline_file_requirements_lookup ON processing_pipeline_file_requirements (pipeline_id, display_order) WHERE is_active = true;

    DROP INDEX IF EXISTS processing_pipeline_batch_step_function_mappings_lookup;
    ALTER TABLE processing_pipeline_batch_step_function_mappings DROP CONSTRAINT IF EXISTS processing_pipeline_batch_step_function_mapping_stage_code_fkey;
    ALTER TABLE processing_pipeline_batch_step_function_mappings DROP CONSTRAINT IF EXISTS processing_pipeline_batch_ste_pipeline_id_stage_code_batch__key;
    ALTER TABLE processing_pipeline_batch_step_function_mappings DROP COLUMN stage_code;
    ALTER TABLE processing_pipeline_batch_step_function_mappings ADD CONSTRAINT processing_pipeline_batch_step_function_mappings_pipeline_cycle_key UNIQUE (pipeline_id, batch_cycle);
    CREATE INDEX processing_pipeline_batch_step_function_mappings_lookup ON processing_pipeline_batch_step_function_mappings (pipeline_id, batch_cycle) WHERE is_active = true;
    DROP TABLE processing_pipeline_stages;
  `,
  },
  {
    id: "013_uppercase_excel_file_extensions",
    sql: `
    UPDATE processing_pipeline_file_requirements inactive
      SET file_name = inactive.file_name || '.superseded', updated_at = now()
      WHERE NOT inactive.is_active
        AND inactive.file_name ~* '\\.xlsx$'
        AND EXISTS (
          SELECT 1 FROM processing_pipeline_file_requirements active
          WHERE active.pipeline_id = inactive.pipeline_id
            AND active.is_active
            AND lower(active.file_name) = lower(inactive.file_name)
        );
    UPDATE processing_pipeline_file_requirements
      SET file_name = regexp_replace(file_name, '\\.xlsx$', '.XLSX', 'i'), updated_at = now()
      WHERE is_active AND file_name ~* '\\.xlsx$';
  `,
  },
];
