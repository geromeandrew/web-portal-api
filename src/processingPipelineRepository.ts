import type { Pool } from "pg";
import type { ProcessingPipelineFileRequirement } from "./processingPipelineCatalog.js";

type RequirementRow = {
  id: number;
  file_name: string;
  match_type: "exact" | "glob";
  legacy_package_name: string | null;
  job_name: string | null;
  acquisition_method: "web_upload" | "sftp_pull";
  source_connection_name: string | null;
  remote_sftp_host: string | null;
  remote_sftp_source_directory: string | null;
  sftp_username: string | null;
  sftp_authentication: string | null;
  schedule_description: string | null;
  source_file_pull_rename_rules: string | null;
  s3_key_prefix: string;
  database_schema_destination: string | null;
  table_destinations: unknown;
  job_mappings: unknown;
  step_function_mapping_id: number | null;
  state_machine_name: string | null;
  batch_cycle: string | null;
  execution_input: unknown;
};

const jsonArray = <T>(value: unknown): T[] =>
  Array.isArray(value)
    ? (value as T[])
    : typeof value === "string"
      ? (JSON.parse(value) as T[])
      : [];
const jsonObject = (value: unknown): Record<string, unknown> => {
  const parsed =
    typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
};

export type PipelineRequirementDto = ProcessingPipelineFileRequirement & {
  acquisitionMethod: "webUpload" | "sftpPull";
  sourceConnectionName: string | null;
  remoteSftpHost: string | null;
  remoteSftpSourceDirectory: string | null;
  sftpUsername: string | null;
  sftpAuthentication: string | null;
  scheduleDescription: string | null;
  sourceFilePullRenameRules: string | null;
  s3KeyPrefix: string;
  databaseSchemaDestination: string | null;
  tableDestinations: string[];
  jobMappings: { billCycle: string; legacyFileName: string; jobName: string }[];
  stepFunction: {
    mappingId: number;
    stateMachineName: string;
    batchCycle: string | null;
    executionInput: Record<string, unknown>;
  } | null;
};

function requirementDto(
  pipelineCode: string,
  row: RequirementRow,
): PipelineRequirementDto {
  return {
    id: row.id,
    pipelineCode,
    fileName: row.file_name,
    match: row.match_type,
    legacyPackageName: row.legacy_package_name,
    jobName: row.job_name,
    acquisitionMethod:
      row.acquisition_method === "web_upload" ? "webUpload" : "sftpPull",
    sourceConnectionName: row.source_connection_name,
    remoteSftpHost: row.remote_sftp_host,
    remoteSftpSourceDirectory: row.remote_sftp_source_directory,
    sftpUsername: row.sftp_username,
    sftpAuthentication: row.sftp_authentication,
    scheduleDescription: row.schedule_description,
    sourceFilePullRenameRules: row.source_file_pull_rename_rules,
    s3KeyPrefix: row.s3_key_prefix,
    databaseSchemaDestination: row.database_schema_destination,
    tableDestinations: jsonArray<{ tableName: string }>(
      row.table_destinations,
    ).map((item) => item.tableName),
    jobMappings: jsonArray<{
      billCycle: string;
      legacyFileName: string;
      jobName: string;
    }>(row.job_mappings),
    stepFunction:
      row.step_function_mapping_id && row.state_machine_name
        ? {
            mappingId: row.step_function_mapping_id,
            stateMachineName: row.state_machine_name,
            batchCycle: row.batch_cycle,
            executionInput: jsonObject(row.execution_input),
          }
        : null,
  };
}

const requirementSelect = `
  SELECT requirement.id, requirement.file_name, requirement.match_type, requirement.legacy_package_name, requirement.job_name,
    requirement.acquisition_method, requirement.source_connection_name, requirement.remote_sftp_host, requirement.remote_sftp_source_directory,
    requirement.sftp_username, requirement.sftp_authentication, requirement.schedule_description, requirement.source_file_pull_rename_rules, requirement.s3_key_prefix, requirement.database_schema_destination,
    COALESCE((SELECT json_agg(json_build_object('tableName', destination.table_name) ORDER BY destination.display_order) FROM processing_pipeline_file_destinations destination WHERE destination.file_requirement_id = requirement.id), '[]'::json) AS table_destinations,
    COALESCE((SELECT json_agg(json_build_object('billCycle', mapping.bill_cycle, 'legacyFileName', mapping.legacy_file_name, 'jobName', mapping.job_name) ORDER BY mapping.display_order) FROM processing_pipeline_file_job_mappings mapping WHERE mapping.file_requirement_id = requirement.id AND mapping.is_active = true), '[]'::json) AS job_mappings,
    step_mapping.id AS step_function_mapping_id, state_machine.state_machine_name, step_mapping.batch_cycle, step_mapping.execution_input
  FROM processing_pipeline_file_requirements requirement
  JOIN processing_pipelines pipeline ON pipeline.id = requirement.pipeline_id
  LEFT JOIN processing_pipeline_file_step_function_mappings step_mapping ON step_mapping.file_requirement_id = requirement.id AND step_mapping.is_active = true
  LEFT JOIN processing_pipeline_step_function_state_machines state_machine ON state_machine.id = step_mapping.state_machine_id AND state_machine.is_active = true`;

export type StepFunctionExecution = {
  id: string;
  executionArn: string;
  targetMode: "adhoc" | "batch";
  stateMachineName: string;
  executionInput: Record<string, unknown>;
  sourceFiles: Record<string, unknown>[];
  status: string;
  errorCode: string | null;
  errorMessage: string | null;
  output: string | null;
  outputIncluded: boolean | null;
  startedAt: string;
  completedAt: string | null;
};

export async function createStepFunctionExecution(
  pool: Pool,
  execution: {
    id: string;
    fileMappingId?: number;
    batchMappingId?: number;
    executionArn: string;
    executionInput: Record<string, unknown>;
    sourceFiles: Record<string, unknown>[];
    workspaceId: string;
    startedByUserId: string;
    status: string;
    startedAt: string;
  },
) {
  await pool.query(
    "INSERT INTO processing_pipeline_step_function_executions (id, file_step_function_mapping_id, batch_step_function_mapping_id, execution_arn, object_key, execution_input, source_files, workspace_id, started_by_user_id, status, started_at, last_observed_at) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11, $11)",
    [
      execution.id,
      execution.fileMappingId ?? null,
      execution.batchMappingId ?? null,
      execution.executionArn,
      typeof execution.sourceFiles[0]?.key === "string"
        ? execution.sourceFiles[0].key
        : null,
      JSON.stringify(execution.executionInput),
      JSON.stringify(execution.sourceFiles),
      execution.workspaceId,
      execution.startedByUserId,
      execution.status,
      execution.startedAt,
    ],
  );
}

export async function getStepFunctionExecution(
  pool: Pool,
  id: string,
  pipelineCode: string,
): Promise<StepFunctionExecution | null> {
  const result = await pool.query<{
    id: string;
    execution_arn: string;
    target_mode: "adhoc" | "batch";
    state_machine_name: string;
    execution_input: unknown;
    source_files: unknown;
    status: string;
    error_code: string | null;
    error_message: string | null;
    execution_output: string | null;
    output_included: boolean | null;
    started_at: Date;
    completed_at: Date | null;
  }>(
    `SELECT execution.id, execution.execution_arn, CASE WHEN execution.file_step_function_mapping_id IS NULL THEN 'batch' ELSE 'adhoc' END AS target_mode, COALESCE(file_state_machine.state_machine_name, batch_state_machine.state_machine_name) AS state_machine_name, execution.execution_input, execution.source_files, execution.status, execution.error_code, execution.error_message, execution.execution_output, execution.output_included, execution.started_at, execution.completed_at
      FROM processing_pipeline_step_function_executions execution
      LEFT JOIN processing_pipeline_file_step_function_mappings file_mapping ON file_mapping.id = execution.file_step_function_mapping_id
      LEFT JOIN processing_pipeline_file_requirements file_requirement ON file_requirement.id = file_mapping.file_requirement_id
      LEFT JOIN processing_pipelines file_pipeline ON file_pipeline.id = file_requirement.pipeline_id
      LEFT JOIN processing_pipeline_step_function_state_machines file_state_machine ON file_state_machine.id = file_mapping.state_machine_id
      LEFT JOIN processing_pipeline_batch_step_function_mappings batch_mapping ON batch_mapping.id = execution.batch_step_function_mapping_id
      LEFT JOIN processing_pipelines batch_pipeline ON batch_pipeline.id = batch_mapping.pipeline_id
      LEFT JOIN processing_pipeline_step_function_state_machines batch_state_machine ON batch_state_machine.id = batch_mapping.state_machine_id
      WHERE execution.id = $1 AND COALESCE(file_pipeline.code, batch_pipeline.code) = $2`,
    [id, pipelineCode],
  );
  const row = result.rows[0];
  return row
    ? {
        id: row.id,
        executionArn: row.execution_arn,
        targetMode: row.target_mode,
        stateMachineName: row.state_machine_name,
        executionInput: jsonObject(row.execution_input),
        sourceFiles: jsonArray<Record<string, unknown>>(row.source_files),
        status: row.status,
        errorCode: row.error_code,
        errorMessage: row.error_message,
        output: row.execution_output,
        outputIncluded: row.output_included,
        startedAt: row.started_at.toISOString(),
        completedAt: row.completed_at?.toISOString() ?? null,
      }
    : null;
}

export async function updateStepFunctionExecution(
  pool: Pool,
  id: string,
  observed: {
    status: string;
    errorCode: string | null;
    errorMessage: string | null;
    output: string | null;
    outputIncluded: boolean | null;
    completedAt: string | null;
  },
) {
  await pool.query(
    "UPDATE processing_pipeline_step_function_executions SET status = $2, error_code = $3, error_message = $4, execution_output = $5, output_included = $6, completed_at = $7, last_observed_at = now(), updated_at = now() WHERE id = $1",
    [
      id,
      observed.status,
      observed.errorCode,
      observed.errorMessage,
      observed.output,
      observed.outputIncluded,
      observed.completedAt,
    ],
  );
}

export type PipelineBatchStepFunctionMapping = {
  mappingId: number;
  stateMachineName: string;
  batchCycle: string;
  executionInput: Record<string, unknown>;
  files: {
    expectedFileName: string;
    displayOrder: number;
    stepFunction: {
      mappingId: number;
      stateMachineName: string;
      executionInput: Record<string, unknown>;
    } | null;
  }[];
};

export async function getProcessingPipelineBatchStepFunctionMapping(
  pool: Pool,
  pipelineCode: string,
  batchCycle: string,
): Promise<PipelineBatchStepFunctionMapping | null> {
  const result = await pool.query<{
    id: number;
    state_machine_name: string;
    batch_cycle: string;
    execution_input: unknown;
    files: unknown;
  }>(
    `SELECT mapping.id, state_machine.state_machine_name, mapping.batch_cycle, mapping.execution_input, COALESCE(json_agg(json_build_object('expectedFileName', requirement.file_name, 'displayOrder', member.display_order, 'stepFunction', CASE WHEN file_mapping.id IS NULL OR file_state_machine.state_machine_name IS NULL THEN NULL ELSE json_build_object('mappingId', file_mapping.id, 'stateMachineName', file_state_machine.state_machine_name, 'executionInput', file_mapping.execution_input) END) ORDER BY member.display_order) FILTER (WHERE member.file_requirement_id IS NOT NULL), '[]'::json) AS files
      FROM processing_pipeline_batch_step_function_mappings mapping
      JOIN processing_pipelines pipeline ON pipeline.id = mapping.pipeline_id
      JOIN processing_pipeline_step_function_state_machines state_machine ON state_machine.id = mapping.state_machine_id AND state_machine.is_active = true
      LEFT JOIN processing_pipeline_batch_step_function_mapping_files member ON member.batch_mapping_id = mapping.id
      LEFT JOIN processing_pipeline_file_requirements requirement ON requirement.id = member.file_requirement_id AND requirement.is_active = true
      LEFT JOIN processing_pipeline_file_step_function_mappings file_mapping ON file_mapping.file_requirement_id = requirement.id AND file_mapping.batch_cycle = mapping.batch_cycle AND file_mapping.is_active = true
      LEFT JOIN processing_pipeline_step_function_state_machines file_state_machine ON file_state_machine.id = file_mapping.state_machine_id AND file_state_machine.is_active = true
      WHERE pipeline.code = $1 AND pipeline.is_active = true AND mapping.batch_cycle = $2 AND mapping.is_active = true
      GROUP BY mapping.id, state_machine.state_machine_name, mapping.batch_cycle, mapping.execution_input`,
    [pipelineCode, batchCycle],
  );
  const row = result.rows[0];
  return row
    ? {
        mappingId: row.id,
        stateMachineName: row.state_machine_name,
        batchCycle: row.batch_cycle,
        executionInput: jsonObject(row.execution_input),
        files: jsonArray<{
          expectedFileName: string;
          displayOrder: number;
          stepFunction: {
            mappingId: number;
            stateMachineName: string;
            executionInput: unknown;
          } | null;
        }>(row.files).map((file) => ({
          expectedFileName: file.expectedFileName,
          displayOrder: file.displayOrder,
          stepFunction: file.stepFunction
            ? {
                mappingId: file.stepFunction.mappingId,
                stateMachineName: file.stepFunction.stateMachineName,
                executionInput: jsonObject(file.stepFunction.executionInput),
              }
            : null,
        })),
      }
    : null;
}

export async function getProcessingPipelineRequirements(
  pool: Pool,
  pipelineCode: string,
): Promise<PipelineRequirementDto[]> {
  const result = await pool.query<RequirementRow>(
    `${requirementSelect} WHERE pipeline.code = $1 AND pipeline.is_active = true AND requirement.is_active = true ORDER BY requirement.display_order, requirement.id`,
    [pipelineCode],
  );
  return result.rows.map((row) => requirementDto(pipelineCode, row));
}

export async function getProcessingPipelineCatalog(pool: Pool) {
  const pipelines = await pool.query<{ label: string; code: string }>(
    "SELECT label, code FROM processing_pipelines WHERE is_active = true ORDER BY display_order, label",
  );
  return { pipelines: pipelines.rows };
}

export async function getPipelineDetail(pool: Pool, pipelineCode: string) {
  const pipeline = await pool.query<{ code: string; label: string }>(
    "SELECT code, label FROM processing_pipelines WHERE code = $1 AND is_active = true",
    [pipelineCode],
  );
  if (!pipeline.rowCount) return null;
  const counts = await pool.query<{
    configured_file_count: string;
    mapped_job_count: string;
  }>(
    `SELECT COUNT(requirement.id) AS configured_file_count, COUNT(requirement.id) FILTER (WHERE requirement.job_name IS NOT NULL OR EXISTS (SELECT 1 FROM processing_pipeline_file_step_function_mappings mapping WHERE mapping.file_requirement_id = requirement.id AND mapping.is_active = true)) AS mapped_job_count FROM processing_pipeline_file_requirements requirement WHERE requirement.pipeline_id = (SELECT id FROM processing_pipelines WHERE code = $1) AND requirement.is_active = true`,
    [pipelineCode],
  );
  return {
    pipeline: pipeline.rows[0],
    configuredFileCount: Number(counts.rows[0].configured_file_count),
    mappedJobCount: Number(counts.rows[0].mapped_job_count),
  };
}
