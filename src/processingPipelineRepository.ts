import type { Pool } from "pg";
import type { ProcessingPipelineStage } from "./processingPipelineStorage.js";
import type { ProcessingPipelineFileRequirement } from "./processingPipelineCatalog.js";

type RequirementRow = {
  id: number; stage: ProcessingPipelineStage; file_name: string; match_type: "exact" | "glob"; legacy_package_name: string | null; job_name: string | null;
  acquisition_method: "web_upload" | "sftp_pull"; source_connection_name: string | null; remote_sftp_host: string | null; remote_sftp_source_directory: string | null;
  sftp_username: string | null; sftp_authentication: string | null; schedule_description: string | null; source_file_pull_rename_rules: string | null; s3_key_prefix: string; database_schema_destination: string | null;
  table_destinations: unknown; job_mappings: unknown;
};

const jsonArray = <T>(value: unknown): T[] => Array.isArray(value) ? value as T[] : typeof value === "string" ? JSON.parse(value) as T[] : [];

export type PipelineRequirementDto = ProcessingPipelineFileRequirement & {
  acquisitionMethod: "webUpload" | "sftpPull";
  sourceConnectionName: string | null; remoteSftpHost: string | null; remoteSftpSourceDirectory: string | null; sftpUsername: string | null; sftpAuthentication: string | null;
  scheduleDescription: string | null; sourceFilePullRenameRules: string | null; s3KeyPrefix: string; databaseSchemaDestination: string | null;
  tableDestinations: string[]; jobMappings: { billCycle: string; legacyFileName: string; jobName: string }[];
};

function requirementDto(pipelineCode: string, row: RequirementRow): PipelineRequirementDto {
  return {
    id: row.id, pipelineCode, stage: row.stage, fileName: row.file_name, match: row.match_type, legacyPackageName: row.legacy_package_name, jobName: row.job_name,
    acquisitionMethod: row.acquisition_method === "web_upload" ? "webUpload" : "sftpPull", sourceConnectionName: row.source_connection_name, remoteSftpHost: row.remote_sftp_host,
    remoteSftpSourceDirectory: row.remote_sftp_source_directory, sftpUsername: row.sftp_username, sftpAuthentication: row.sftp_authentication, scheduleDescription: row.schedule_description,
    sourceFilePullRenameRules: row.source_file_pull_rename_rules, s3KeyPrefix: row.s3_key_prefix, databaseSchemaDestination: row.database_schema_destination,
    tableDestinations: jsonArray<{ tableName: string }>(row.table_destinations).map((item) => item.tableName),
    jobMappings: jsonArray<{ billCycle: string; legacyFileName: string; jobName: string }>(row.job_mappings),
  };
}

const requirementSelect = `
  SELECT requirement.id, requirement.stage_code AS stage, requirement.file_name, requirement.match_type, requirement.legacy_package_name, requirement.job_name,
    requirement.acquisition_method, requirement.source_connection_name, requirement.remote_sftp_host, requirement.remote_sftp_source_directory,
    requirement.sftp_username, requirement.sftp_authentication, requirement.schedule_description, requirement.source_file_pull_rename_rules, requirement.s3_key_prefix, requirement.database_schema_destination,
    COALESCE((SELECT json_agg(json_build_object('tableName', destination.table_name) ORDER BY destination.display_order) FROM processing_pipeline_file_destinations destination WHERE destination.file_requirement_id = requirement.id), '[]'::json) AS table_destinations,
    COALESCE((SELECT json_agg(json_build_object('billCycle', mapping.bill_cycle, 'legacyFileName', mapping.legacy_file_name, 'jobName', mapping.job_name) ORDER BY mapping.display_order) FROM processing_pipeline_file_job_mappings mapping WHERE mapping.file_requirement_id = requirement.id AND mapping.is_active = true), '[]'::json) AS job_mappings
  FROM processing_pipeline_file_requirements requirement JOIN processing_pipelines pipeline ON pipeline.id = requirement.pipeline_id`;

export async function getProcessingPipelineRequirements(pool: Pool, pipelineCode: string, stage: ProcessingPipelineStage): Promise<PipelineRequirementDto[]> {
  const result = await pool.query<RequirementRow>(`${requirementSelect} WHERE pipeline.code = $1 AND pipeline.is_active = true AND requirement.stage_code = $2 AND requirement.is_active = true ORDER BY requirement.display_order, requirement.id`, [pipelineCode, stage]);
  return result.rows.map((row) => requirementDto(pipelineCode, row));
}

export async function getProcessingPipelineCatalog(pool: Pool) {
  const [pipelines, stages] = await Promise.all([
    pool.query<{ label: string; code: string }>("SELECT label, code FROM processing_pipelines WHERE is_active = true ORDER BY display_order, label"),
    pool.query<{ code: ProcessingPipelineStage; label: string }>("SELECT code, label FROM processing_pipeline_stages WHERE is_active = true ORDER BY display_order"),
  ]);
  return { pipelines: pipelines.rows, stages: stages.rows };
}

export async function getPipelineDetail(pool: Pool, pipelineCode: string) {
  const pipeline = await pool.query<{ code: string; label: string }>("SELECT code, label FROM processing_pipelines WHERE code = $1 AND is_active = true", [pipelineCode]);
  if (!pipeline.rowCount) return null;
  const stages = await pool.query<{ code: string; label: string; configured_file_count: string; mapped_job_count: string }>(`SELECT stage.code, stage.label, COUNT(requirement.id) AS configured_file_count, COUNT(requirement.id) FILTER (WHERE requirement.job_name IS NOT NULL) AS mapped_job_count FROM processing_pipeline_stages stage LEFT JOIN processing_pipeline_file_requirements requirement ON requirement.stage_code = stage.code AND requirement.pipeline_id = (SELECT id FROM processing_pipelines WHERE code = $1) AND requirement.is_active = true WHERE stage.is_active = true GROUP BY stage.code ORDER BY stage.display_order`, [pipelineCode]);
  return { pipeline: pipeline.rows[0], stages: stages.rows.map((stage) => ({ code: stage.code, label: stage.label, configuredFileCount: Number(stage.configured_file_count), mappedJobCount: Number(stage.mapped_job_count) })) };
}
