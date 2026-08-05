import type { Pool } from "pg";
import type { ProcessingPipelineStage } from "./processingPipelineStorage.js";
import type { ProcessingPipelineFileRequirement } from "./processingPipelineCatalog.js";

type RequirementRow = { stage: ProcessingPipelineStage; file_name: string; match_type: "exact" | "glob"; legacy_package_name: string | null; job_name: string | null };

export async function getProcessingPipelineRequirements(pool: Pool, pipelineCode: string, stage: ProcessingPipelineStage): Promise<ProcessingPipelineFileRequirement[]> {
  const result = await pool.query<RequirementRow>(`SELECT requirement.stage_code AS stage, requirement.file_name, requirement.match_type, requirement.legacy_package_name, requirement.job_name FROM processing_pipeline_file_requirements requirement JOIN processing_pipelines pipeline ON pipeline.id = requirement.pipeline_id WHERE pipeline.code = $1 AND pipeline.is_active = true AND requirement.stage_code = $2 AND requirement.is_active = true ORDER BY requirement.display_order, requirement.id`, [pipelineCode, stage]);
  return result.rows.map((row) => ({ pipelineCode, stage: row.stage, fileName: row.file_name, match: row.match_type, legacyPackageName: row.legacy_package_name, jobName: row.job_name }));
}

export async function getProcessingPipelineCatalog(pool: Pool) {
  const [pipelines, stages] = await Promise.all([
    pool.query<{ label: string; code: string }>("SELECT label, code FROM processing_pipelines WHERE is_active = true ORDER BY display_order, label"),
    pool.query<{ code: ProcessingPipelineStage; label: string }>("SELECT code, label FROM processing_pipeline_stages WHERE is_active = true ORDER BY display_order"),
  ]);
  return { pipelines: pipelines.rows, stages: stages.rows };
}
