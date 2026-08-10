import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import express, { type RequestHandler } from "express";
import { z } from "zod";
import type { AppDependencies } from "../../../app/dependencies.js";
import { createAuthMiddleware, requireBootstrapAdmin } from "../../../auth.js";
import { processingPipelineStages } from "../../../processingPipelineStorage.js";
import { matchesProcessingPipelineRequirement } from "../../../processingPipelineCatalog.js";
import { createStepFunctionExecution, getPipelineDetail, getProcessingPipelineBatchStepFunctionMapping, getProcessingPipelineCatalog, getProcessingPipelineRequirements, getStepFunctionExecution, updateStepFunctionExecution } from "../../../processingPipelineRepository.js";
import { AppError } from "../../../errors.js";
import { audit, ensureWorkspace } from "../../../workspace.js";

const pipelineCodeSchema = z.string().min(1).max(512).refine((value) => !value.includes("/") && !value.includes("\0") && value !== "." && value !== "..", "must be a single S3 folder name");
const stageSchema = z.enum(processingPipelineStages);
const fileQuerySchema = z.object({ stage: stageSchema });
const contentQuerySchema = fileQuerySchema.extend({ key: z.string().min(1).max(1024) });
const expectedFileSchema = z.object({ stage: stageSchema, expectedFileName: z.string().min(1).max(512) });
const uploadSchema = expectedFileSchema.extend({ replace: z.enum(["true", "false"]).default("false") });
const runQuerySchema = expectedFileSchema;
const executionDetailsQuerySchema = expectedFileSchema;
const batchRunSchema = z.object({ stage: stageSchema, batchCycle: z.string().regex(/^\d{2}$/, "must be a two-digit bill cycle") });
const allowedExtensions = new Set([".xlsx", ".xls", ".csv", ".txt"]);

function storageError(error: unknown) {
  if (error instanceof Error && error.message === "Requested key is outside the selected processing pipeline folder.") return new AppError(404, "PIPELINE_FILE_NOT_FOUND", "The requested file is not available in the selected pipeline stage.");
  const name = error && typeof error === "object" && "name" in error ? String(error.name) : "";
  if (name === "NoSuchKey" || name === "NotFound") return new AppError(404, "PIPELINE_FILE_NOT_FOUND", "The requested file was not found in storage.");
  if (name === "AccessDenied") return new AppError(502, "PIPELINE_STORAGE_DENIED", "The pipeline storage service denied access to this file.");
  return error;
}
function stepFunctionError(error: unknown) {
  if (error instanceof AppError) return error;
  const name = error && typeof error === "object" && "name" in error ? String(error.name) : "";
  if (name === "StateMachineDoesNotExist" || name === "StateMachineDoesNotExistException" || name === "ExecutionDoesNotExist" || name === "ExecutionDoesNotExistException") return new AppError(404, "PIPELINE_STEP_FUNCTION_NOT_FOUND", "The mapped Step Functions execution target no longer exists.");
  if (name === "InvalidExecutionInput") return new AppError(400, "PIPELINE_STEP_FUNCTION_INPUT_INVALID", "AWS Step Functions rejected the execution input.");
  if (name === "ExecutionLimitExceeded" || name === "ExecutionAlreadyExists") return new AppError(409, "PIPELINE_STEP_FUNCTION_RUN_LIMIT", "This Step Functions execution cannot be started at this time.");
  if (name === "AccessDeniedException" || name === "UnauthorizedException") return new AppError(502, "PIPELINE_STEP_FUNCTION_ACCESS_DENIED", "The portal is not permitted to run the mapped Step Functions state machine.");
  return new AppError(502, "PIPELINE_STEP_FUNCTION_UNAVAILABLE", "The Step Functions service could not process this request. Please try again.");
}
function attachConfiguration(files: Awaited<ReturnType<AppDependencies["processingPipelineStorage"]["listExpectedFiles"]>>, requirements: Awaited<ReturnType<typeof getProcessingPipelineRequirements>>, bucket: string) {
  return files.map((file) => {
    const requirement = requirements.find((candidate) => candidate.fileName === file.expectedFileName);
    if (!requirement) return file;
    return { ...file, stepFunction: requirement.stepFunction ? { stateMachineName: requirement.stepFunction.stateMachineName, batchCycle: requirement.stepFunction.batchCycle, executionInput: requirement.stepFunction.executionInput } : null, configuration: { acquisitionMethod: requirement.acquisitionMethod, sourceConnectionName: requirement.sourceConnectionName, remoteSftpHost: requirement.remoteSftpHost, remoteSftpSourceDirectory: requirement.remoteSftpSourceDirectory, scheduleDescription: requirement.scheduleDescription, sourceFilePullRenameRules: requirement.sourceFilePullRenameRules, s3Destination: `s3://${bucket}/${requirement.s3KeyPrefix}`, legacyPackageName: requirement.legacyPackageName, databaseSchemaDestination: requirement.databaseSchemaDestination, tableDestinations: requirement.tableDestinations, jobMappings: requirement.jobMappings } };
  });
}

export function createProcessingPipelinesRouter({ pool, config, processingPipelineStorage, stepFunctionsRunner, logger }: AppDependencies, singleFile: RequestHandler) {
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
  router.get("/:pipelineCode/execution-details", requireBootstrapAdmin, async (request, response) => {
    const pipelineCode = pipelineCodeSchema.parse(request.params.pipelineCode); const { stage, expectedFileName } = executionDetailsQuerySchema.parse(request.query); const requirement = (await getProcessingPipelineRequirements(pool, pipelineCode, stage)).find((candidate) => candidate.fileName === expectedFileName); if (!requirement) throw new AppError(404, "PIPELINE_FILE_NOT_FOUND", "The selected file mapping is not available for this pipeline stage."); if (!requirement.stepFunction) throw new AppError(404, "PIPELINE_STEP_FUNCTION_NOT_MAPPED", "No Step Functions state machine is mapped to the selected file."); const key = `${pipelineCode}/${stage}/${requirement.fileName}`;
    let sourceFileExists: boolean;
    try { sourceFileExists = await processingPipelineStorage.fileExists(pipelineCode, stage, key); } catch (error) { throw storageError(error); }
    try { const stateMachine = await stepFunctionsRunner.describeStateMachine(requirement.stepFunction.stateMachineName); const blockingReasons = [
      ...(sourceFileExists ? [] : ["SOURCE_FILE_MISSING"]),
      ...(stateMachine.status === "ACTIVE" ? [] : ["STATE_MACHINE_INACTIVE"]),
      ...(stateMachine.type === "STANDARD" ? [] : ["STATE_MACHINE_NOT_STANDARD"]),
    ]; response.json({ pipelineCode, stage, expectedFileName: requirement.fileName, sourceFile: { key, s3Uri: `s3://${config.S3_BUCKET}/${key}`, exists: sourceFileExists }, execution: { input: requirement.stepFunction.executionInput, stateMachine }, canExecute: blockingReasons.length === 0, blockingReasons }); } catch (error) { throw stepFunctionError(error); }
  });
  router.get("/:pipelineCode/batch-execution-details", requireBootstrapAdmin, async (request, response) => {
    const pipelineCode = pipelineCodeSchema.parse(request.params.pipelineCode); const { stage, batchCycle } = batchRunSchema.parse(request.query); const mapping = await getProcessingPipelineBatchStepFunctionMapping(pool, pipelineCode, stage, batchCycle); if (!mapping) throw new AppError(404, "PIPELINE_BATCH_STEP_FUNCTION_NOT_MAPPED", "No batch Step Functions state machine is mapped to the selected bill cycle.");
    let sourceFiles: { expectedFileName: string; displayOrder: number; key: string; s3Uri: string; exists: boolean }[];
    try { sourceFiles = await Promise.all(mapping.files.map(async (file) => { const key = `${pipelineCode}/${stage}/${file.expectedFileName}`; return { ...file, key, s3Uri: `s3://${config.S3_BUCKET}/${key}`, exists: await processingPipelineStorage.fileExists(pipelineCode, stage, key) }; })); } catch (error) { throw storageError(error); }
    try { const stateMachine = await stepFunctionsRunner.describeStateMachine(mapping.stateMachineName); const blockingReasons = [
      ...(sourceFiles.some((file) => !file.exists) ? ["BATCH_SOURCE_FILES_MISSING"] : []),
      ...(stateMachine.status === "ACTIVE" ? [] : ["STATE_MACHINE_INACTIVE"]),
      ...(stateMachine.type === "STANDARD" ? [] : ["STATE_MACHINE_NOT_STANDARD"]),
    ]; response.json({ pipelineCode, stage, batchCycle: mapping.batchCycle, sourceFiles, execution: { input: mapping.executionInput, stateMachine }, canExecute: blockingReasons.length === 0, blockingReasons }); } catch (error) { throw stepFunctionError(error); }
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
    const pipelineCode = pipelineCodeSchema.parse(request.params.pipelineCode); const { stage, expectedFileName } = expectedFileSchema.parse(request.body); const requirement = (await getProcessingPipelineRequirements(pool, pipelineCode, stage)).find((candidate) => candidate.fileName === expectedFileName); if (!requirement) throw new AppError(404, "PIPELINE_FILE_NOT_FOUND", "The selected file mapping is not available for this pipeline stage."); if (!requirement.stepFunction) throw new AppError(404, "PIPELINE_STEP_FUNCTION_NOT_MAPPED", "No Step Functions state machine is mapped to the selected file."); if (requirement.match !== "exact") throw new AppError(400, "PIPELINE_FILE_PATTERN_UNSUPPORTED", "A specific file must be selected before starting its processing run."); const key = `${pipelineCode}/${stage}/${requirement.fileName}`;
    try { if (!(await processingPipelineStorage.fileExists(pipelineCode, stage, key))) throw new AppError(404, "PIPELINE_FILE_NOT_FOUND", "Upload the selected file before starting its processing run."); } catch (error) { throw storageError(error); }
    const runId = randomUUID(); const workspaceId = await ensureWorkspace(pool, request.auth!.userId);
    try { const stateMachine = await stepFunctionsRunner.describeStateMachine(requirement.stepFunction.stateMachineName); if (stateMachine.status !== "ACTIVE" || stateMachine.type !== "STANDARD") throw new AppError(409, "PIPELINE_STEP_FUNCTION_NOT_RUNNABLE", "The mapped Step Functions state machine must be active and Standard before it can be run."); const started = await stepFunctionsRunner.startExecution(requirement.stepFunction.stateMachineName, requirement.stepFunction.executionInput); const sourceFiles = [{ expectedFileName: requirement.fileName, key, s3Uri: `s3://${config.S3_BUCKET}/${key}` }]; await createStepFunctionExecution(pool, { id: runId, fileMappingId: requirement.stepFunction.mappingId, executionArn: started.executionArn, executionInput: requirement.stepFunction.executionInput, sourceFiles, workspaceId, startedByUserId: request.auth!.userId, status: "RUNNING", startedAt: started.startedAt }); try { await audit(pool, workspaceId, "processing-pipeline.step-function-started", { pipelineCode, stage, expectedFileName: requirement.fileName, objectKey: key, stateMachineName: requirement.stepFunction.stateMachineName, executionInput: requirement.stepFunction.executionInput, runId, executionArn: started.executionArn }); } catch (error) { logger.error("processing_pipeline.step_function_audit_failed", { error: String(error) }); } response.status(201).json({ runId, targetMode: "adhoc", stateMachineName: requirement.stepFunction.stateMachineName, executionInput: requirement.stepFunction.executionInput, startedAt: started.startedAt }); } catch (error) { throw stepFunctionError(error); }
  });
  router.post("/:pipelineCode/batch-runs", requireBootstrapAdmin, async (request, response) => {
    const pipelineCode = pipelineCodeSchema.parse(request.params.pipelineCode); const { stage, batchCycle } = batchRunSchema.parse(request.body); const mapping = await getProcessingPipelineBatchStepFunctionMapping(pool, pipelineCode, stage, batchCycle); if (!mapping) throw new AppError(404, "PIPELINE_BATCH_STEP_FUNCTION_NOT_MAPPED", "No batch Step Functions state machine is mapped to the selected bill cycle.");
    let sourceFiles: { expectedFileName: string; displayOrder: number; key: string; s3Uri: string }[];
    try { const resolved = await Promise.all(mapping.files.map(async (file) => { const key = `${pipelineCode}/${stage}/${file.expectedFileName}`; return { ...file, key, s3Uri: `s3://${config.S3_BUCKET}/${key}`, exists: await processingPipelineStorage.fileExists(pipelineCode, stage, key) }; })); if (resolved.some((file) => !file.exists)) throw new AppError(409, "PIPELINE_BATCH_SOURCE_FILES_MISSING", "Upload all five mapped batch source files before starting the batch execution."); sourceFiles = resolved.map(({ exists: _exists, ...file }) => file); } catch (error) { throw storageError(error); }
    const runId = randomUUID(); const workspaceId = await ensureWorkspace(pool, request.auth!.userId);
    try { const stateMachine = await stepFunctionsRunner.describeStateMachine(mapping.stateMachineName); if (stateMachine.status !== "ACTIVE" || stateMachine.type !== "STANDARD") throw new AppError(409, "PIPELINE_STEP_FUNCTION_NOT_RUNNABLE", "The mapped Step Functions state machine must be active and Standard before it can be run."); const started = await stepFunctionsRunner.startExecution(mapping.stateMachineName, mapping.executionInput); await createStepFunctionExecution(pool, { id: runId, batchMappingId: mapping.mappingId, executionArn: started.executionArn, executionInput: mapping.executionInput, sourceFiles, workspaceId, startedByUserId: request.auth!.userId, status: "RUNNING", startedAt: started.startedAt }); try { await audit(pool, workspaceId, "processing-pipeline.batch-step-function-started", { pipelineCode, stage, batchCycle, sourceFiles, stateMachineName: mapping.stateMachineName, executionInput: mapping.executionInput, runId, executionArn: started.executionArn }); } catch (error) { logger.error("processing_pipeline.batch_step_function_audit_failed", { error: String(error) }); } response.status(201).json({ runId, targetMode: "batch", stateMachineName: mapping.stateMachineName, executionInput: mapping.executionInput, sourceFiles, startedAt: started.startedAt }); } catch (error) { throw stepFunctionError(error); }
  });
  router.get("/:pipelineCode/runs/:runId", requireBootstrapAdmin, async (request, response) => {
    const pipelineCode = pipelineCodeSchema.parse(request.params.pipelineCode); const runId = z.string().uuid().parse(request.params.runId); const execution = await getStepFunctionExecution(pool, runId, pipelineCode); if (!execution) throw new AppError(404, "PIPELINE_RUN_NOT_FOUND", "The requested processing run was not found for this pipeline.");
    try { const [observed, stateMachine] = await Promise.all([stepFunctionsRunner.describeExecution(execution.executionArn), stepFunctionsRunner.describeStateMachine(execution.stateMachineName)]); await updateStepFunctionExecution(pool, runId, observed); const durationMs = observed.completedAt ? new Date(observed.completedAt).getTime() - new Date(observed.startedAt ?? execution.startedAt).getTime() : null; const region = encodeURIComponent(config.AWS_REGION); response.json({ runId, targetMode: execution.targetMode, executionArn: execution.executionArn, stateMachineName: execution.stateMachineName, stateMachine, executionInput: execution.executionInput, sourceFiles: execution.sourceFiles, status: observed.status, errorCode: observed.errorCode, errorMessage: observed.errorMessage, input: observed.input, inputIncluded: observed.inputIncluded, output: observed.output, outputIncluded: observed.outputIncluded, mapRunArn: observed.mapRunArn, traceHeader: observed.traceHeader, startedAt: observed.startedAt ?? execution.startedAt, completedAt: observed.completedAt, durationMs, lastObservedAt: new Date().toISOString(), stepFunctionsConsoleUrl: `https://${config.AWS_REGION}.console.aws.amazon.com/states/home?region=${region}#/statemachines` }); } catch (error) { throw stepFunctionError(error); }
  });
  return router;
}
