import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import express, { type RequestHandler } from "express";
import { z } from "zod";
import type { AppDependencies } from "../../../app/dependencies.js";
import { createAuthMiddleware, requireBootstrapAdmin } from "../../../auth.js";
import { processingPipelineStages } from "../../../processingPipelineStorage.js";
import { matchesProcessingPipelineRequirement } from "../../../processingPipelineCatalog.js";
import { getPipelineDetail, getProcessingPipelineCatalog, getProcessingPipelineRequirements } from "../../../processingPipelineRepository.js";
import { AppError } from "../../../errors.js";
import { audit, ensureWorkspace } from "../../../workspace.js";

const pipelineCodeSchema = z.string().min(1).max(512).refine((value) => !value.includes("/") && !value.includes("\0") && value !== "." && value !== "..", "must be a single S3 folder name");
const stageSchema = z.enum(processingPipelineStages);
const fileQuerySchema = z.object({ stage: stageSchema });
const contentQuerySchema = fileQuerySchema.extend({ key: z.string().min(1).max(1024) });
const expectedFileSchema = z.object({ stage: stageSchema, expectedFileName: z.string().min(1).max(512) });
const uploadSchema = expectedFileSchema.extend({ replace: z.enum(["true", "false"]).default("false") });
const runQuerySchema = expectedFileSchema;
const allowedExtensions = new Set([".xlsx", ".xls", ".csv", ".txt"]);

function storageError(error: unknown) {
  if (error instanceof Error && error.message === "Requested key is outside the selected processing pipeline folder.") return new AppError(404, "PIPELINE_FILE_NOT_FOUND", "The requested file is not available in the selected pipeline stage.");
  const name = error && typeof error === "object" && "name" in error ? String(error.name) : "";
  if (name === "NoSuchKey" || name === "NotFound") return new AppError(404, "PIPELINE_FILE_NOT_FOUND", "The requested file was not found in storage.");
  if (name === "AccessDenied") return new AppError(502, "PIPELINE_STORAGE_DENIED", "The pipeline storage service denied access to this file.");
  return error;
}
function jobError(error: unknown) {
  if (error instanceof AppError) return error;
  const name = error && typeof error === "object" && "name" in error ? String(error.name) : "";
  if (name === "ConcurrentRunsExceededException") return new AppError(409, "PIPELINE_JOB_RUN_LIMIT", "This processing job is already at its concurrent-run limit.");
  if (name === "EntityNotFoundException") return new AppError(404, "PIPELINE_JOB_NOT_FOUND", "The mapped processing job no longer exists.");
  if (name === "InvalidInputException") return new AppError(400, "PIPELINE_JOB_INVALID", "AWS Glue rejected this job request.");
  if (name === "AccessDeniedException" || name === "UnauthorizedException") return new AppError(502, "PIPELINE_JOB_ACCESS_DENIED", "The portal is not permitted to access the mapped processing job.");
  return new AppError(502, "PIPELINE_JOB_UNAVAILABLE", "The processing job service could not process the request. Please try again.");
}
function attachConfiguration(files: Awaited<ReturnType<AppDependencies["processingPipelineStorage"]["listExpectedFiles"]>>, requirements: Awaited<ReturnType<typeof getProcessingPipelineRequirements>>, bucket: string) {
  return files.map((file) => {
    const requirement = requirements.find((candidate) => candidate.fileName === file.expectedFileName);
    if (!requirement) return file;
    return { ...file, configuration: { acquisitionMethod: requirement.acquisitionMethod, sourceConnectionName: requirement.sourceConnectionName, remoteSftpHost: requirement.remoteSftpHost, remoteSftpSourceDirectory: requirement.remoteSftpSourceDirectory, scheduleDescription: requirement.scheduleDescription, sourceFilePullRenameRules: requirement.sourceFilePullRenameRules, s3Destination: `s3://${bucket}/${requirement.s3KeyPrefix}`, legacyPackageName: requirement.legacyPackageName, databaseSchemaDestination: requirement.databaseSchemaDestination, tableDestinations: requirement.tableDestinations, jobMappings: requirement.jobMappings } };
  });
}

export function createProcessingPipelinesRouter({ pool, config, processingPipelineStorage, glueJobRunner, logger }: AppDependencies, singleFile: RequestHandler) {
  const router = express.Router();
  router.use(createAuthMiddleware(pool, config));
  // Keep the UI's primary catalogue request intentionally small and stable.
  router.get("/", async (_request, response) => response.json(await getProcessingPipelineCatalog(pool)));
  router.get("/:pipelineCode", async (request, response) => {
    const pipelineCode = pipelineCodeSchema.parse(request.params.pipelineCode); const detail = await getPipelineDetail(pool, pipelineCode);
    if (!detail) throw new AppError(404, "PIPELINE_NOT_FOUND", "The requested processing pipeline was not found."); response.json(detail);
  });
  router.get("/:pipelineCode/requirements", async (request, response) => {
    const pipelineCode = pipelineCodeSchema.parse(request.params.pipelineCode); const { stage } = fileQuerySchema.parse(request.query); response.json({ requirements: await getProcessingPipelineRequirements(pool, pipelineCode, stage) });
  });
  router.get("/:pipelineCode/files", async (request, response) => {
    const pipelineCode = pipelineCodeSchema.parse(request.params.pipelineCode); const { stage } = fileQuerySchema.parse(request.query);
    try { const requirements = await getProcessingPipelineRequirements(pool, pipelineCode, stage); const files = requirements.length ? await processingPipelineStorage.listExpectedFiles(pipelineCode, stage, requirements) : []; response.json(requirements.length ? { configured: true, files: attachConfiguration(files, requirements, config.S3_BUCKET) } : { configured: false, files: [] }); } catch (error) { throw storageError(error); }
  });
  router.get("/:pipelineCode/files/content", async (request, response) => {
    const pipelineCode = pipelineCodeSchema.parse(request.params.pipelineCode); const { stage, key } = contentQuerySchema.parse(request.query);
    try { const requirements = await getProcessingPipelineRequirements(pool, pipelineCode, stage); const prefix = `${pipelineCode}/${stage}/`; const fileName = key.startsWith(prefix) ? key.slice(prefix.length) : ""; if (!requirements.some((requirement) => matchesProcessingPipelineRequirement(requirement, fileName))) throw new AppError(404, "PIPELINE_FILE_NOT_FOUND", "The requested file is not configured for this pipeline stage."); const file = await processingPipelineStorage.getFile(pipelineCode, stage, key); if (!file.Body || typeof (file.Body as Readable).pipe !== "function") throw new AppError(502, "PIPELINE_STORAGE_INVALID", "The pipeline storage service returned an invalid file response."); const filename = key.split("/").at(-1) ?? "file"; response.status(200).set({ "Cache-Control": "private, no-store", "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(filename)}`, "Content-Type": file.ContentType ?? "application/octet-stream" }); if (file.ContentLength !== undefined) response.set("Content-Length", String(file.ContentLength)); await pipeline(file.Body as Readable, response); } catch (error) { throw storageError(error); }
  });
  router.post("/:pipelineCode/files", singleFile, async (request, response) => {
    if (!request.file) throw new AppError(400, "FILE_REQUIRED", "Choose a file to upload."); const pipelineCode = pipelineCodeSchema.parse(request.params.pipelineCode); const { stage, expectedFileName, replace } = uploadSchema.parse(request.body); const extension = request.file.originalname.slice(request.file.originalname.lastIndexOf(".")).toLowerCase();
    if (!allowedExtensions.has(extension)) throw new AppError(415, "PIPELINE_FILE_TYPE", "Pipeline uploads must be .xlsx, .xls, .csv, or .txt files."); const requirement = (await getProcessingPipelineRequirements(pool, pipelineCode, stage)).find((candidate) => candidate.fileName === expectedFileName); if (!requirement) throw new AppError(404, "PIPELINE_FILE_NOT_FOUND", "The selected file mapping is not available for this pipeline stage."); const localName = request.file.originalname.split(/[\\/]/).at(-1) ?? "upload.bin"; const savedName = requirement.match === "exact" ? requirement.fileName : localName; if (requirement.match === "glob" && !matchesProcessingPipelineRequirement(requirement, savedName)) throw new AppError(400, "PIPELINE_FILENAME_MISMATCH", `The selected filename must match ${requirement.fileName}.`);
    const key = `${pipelineCode}/${stage}/${savedName}`;
    try { const exists = await processingPipelineStorage.fileExists(pipelineCode, stage, key); if (exists && replace !== "true") throw new AppError(409, "PIPELINE_FILE_EXISTS", "A file already exists at this location. Confirm replacement and try again."); const stored = await processingPipelineStorage.uploadFile(pipelineCode, stage, savedName, new Uint8Array(request.file.buffer), request.file.mimetype || "application/octet-stream"); const workspaceId = await ensureWorkspace(pool, request.auth!.userId); await audit(pool, workspaceId, "processing-pipeline.file-uploaded", { pipelineCode, stage, expectedFileName: requirement.fileName, originalName: localName, objectKey: stored.key, replaced: exists }); response.status(201).json({ file: stored, renamed: requirement.match === "exact" && localName !== savedName, replaced: exists }); } catch (error) { throw storageError(error); }
  });
  router.post("/:pipelineCode/runs", requireBootstrapAdmin, async (request, response) => {
    const pipelineCode = pipelineCodeSchema.parse(request.params.pipelineCode); const { stage, expectedFileName } = expectedFileSchema.parse(request.body); const requirement = (await getProcessingPipelineRequirements(pool, pipelineCode, stage)).find((candidate) => candidate.fileName === expectedFileName); if (!requirement) throw new AppError(404, "PIPELINE_FILE_NOT_FOUND", "The selected file mapping is not available for this pipeline stage."); if (!requirement.jobName) throw new AppError(404, "PIPELINE_JOB_NOT_MAPPED", "No processing job is mapped to the selected file."); if (requirement.match !== "exact") throw new AppError(400, "PIPELINE_FILE_PATTERN_UNSUPPORTED", "A specific file must be selected before starting its processing job."); const key = `${pipelineCode}/${stage}/${requirement.fileName}`;
    try { if (!(await processingPipelineStorage.fileExists(pipelineCode, stage, key))) throw new AppError(404, "PIPELINE_FILE_NOT_FOUND", "Upload the selected file before starting its processing job."); } catch (error) { throw storageError(error); }
    try { const started = await glueJobRunner.startJob(requirement.jobName, { "--input_file_name": requirement.fileName, "--input_file_path": `s3://${config.S3_BUCKET}/${pipelineCode}/${stage}/`, "--processed_file_path": `s3://${config.S3_BUCKET}/${pipelineCode}/processed/`, "--error_file_path": `s3://${config.S3_BUCKET}/${pipelineCode}/error/` }); const startedAt = new Date().toISOString(); try { const workspaceId = await ensureWorkspace(pool, request.auth!.userId); await audit(pool, workspaceId, "processing-pipeline.job-started", { pipelineCode, stage, expectedFileName: requirement.fileName, objectKey: key, jobName: requirement.jobName, jobRunId: started.jobRunId }); } catch (error) { logger.error("processing_pipeline.job_audit_failed", { error: String(error) }); } response.status(201).json({ jobRunId: started.jobRunId, jobName: requirement.jobName, startedAt }); } catch (error) { throw jobError(error); }
  });
  router.get("/:pipelineCode/runs/:jobRunId", requireBootstrapAdmin, async (request, response) => {
    const pipelineCode = pipelineCodeSchema.parse(request.params.pipelineCode); const jobRunId = z.string().min(1).max(512).parse(request.params.jobRunId); const { stage, expectedFileName } = runQuerySchema.parse(request.query); const requirement = (await getProcessingPipelineRequirements(pool, pipelineCode, stage)).find((candidate) => candidate.fileName === expectedFileName); if (!requirement) throw new AppError(404, "PIPELINE_FILE_NOT_FOUND", "The selected file mapping is not available for this pipeline stage."); if (!requirement.jobName) throw new AppError(404, "PIPELINE_JOB_NOT_MAPPED", "No processing job is mapped to the selected file.");
    try { const run = await glueJobRunner.getJobRun(requirement.jobName, jobRunId); const region = encodeURIComponent(config.AWS_REGION); response.json({ ...run, glueConsoleUrl: `https://${config.AWS_REGION}.console.aws.amazon.com/glue/home?region=${region}#/jobs`, cloudWatchLogsUrl: `https://${config.AWS_REGION}.console.aws.amazon.com/cloudwatch/home?region=${region}#logsV2:log-groups` }); } catch (error) { throw jobError(error); }
  });
  return router;
}
