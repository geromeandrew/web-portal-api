import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import express, { type RequestHandler } from "express";
import { z } from "zod";
import type { AppDependencies } from "../../../app/dependencies.js";
import {
  canonicalizeProcessingPipelineExpectedFileName,
  matchesBillCycleUploadFile,
  matchesProcessingPipelineRequirement,
  isProcessingPipelineWebUploadRequirement,
} from "../../../processingPipelineCatalog.js";
import {
  createStepFunctionExecution,
  createPipelineUploadBatch,
  getPipelineUploadBatches,
  getPipelineDetail,
  getPipelineFileUploadActivity,
  getProcessingPipelineBatchStepFunctionMapping,
  getProcessingPipelineCatalog,
  getProcessingPipelineRequirements,
  getStepFunctionExecution,
  recordPipelineUploadBatchFile,
  markPipelineUploadFileRemoved,
  type PipelineBatchStepFunctionMapping,
  updateStepFunctionExecution,
} from "../../../processingPipelineRepository.js";
import { AppError } from "../../../errors.js";
import { assertModuleAccess, getEffectiveModules } from "../../../rbac.js";
import { audit, ensureWorkspace } from "../../../workspace.js";
import {
  mapStepFunctionError,
  mapStorageError,
} from "../application/pipelineErrors.js";

const pipelineCodeSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !value.includes("/") &&
      !value.includes("\0") &&
      value !== "." &&
      value !== "..",
    "must be a single S3 folder name",
  );
const contentQuerySchema = z.object({ key: z.string().min(1).max(1024) });
const expectedFileSchema = z.object({
  expectedFileName: z.string().min(1).max(512),
});
const uploadSchema = expectedFileSchema.extend({
  replace: z.enum(["true", "false"]).default("false"),
  batchId: z.string().uuid().optional(),
});
const executionDetailsQuerySchema = expectedFileSchema;
const batchRunSchema = z.object({
  batchCycle: z.string().regex(/^\d{2}$/, "must be a two-digit bill cycle"),
});
const allowedExtensions = new Set([".xlsx", ".xls", ".csv", ".txt"]);

type ResolvedBatchFile = PipelineBatchStepFunctionMapping["files"][number] & {
  key: string;
  s3Uri: string;
  exists: boolean;
};

function batchSourceFile(file: ResolvedBatchFile) {
  const { exists: _exists, stepFunction: _stepFunction, ...sourceFile } = file;
  return sourceFile;
}

function batchMissingFile(file: ResolvedBatchFile) {
  const { exists: _exists, stepFunction: _stepFunction, ...sourceFile } = file;
  return { ...sourceFile, reason: "SOURCE_FILE_MISSING" };
}

function individualBatchStepFunction(file: ResolvedBatchFile) {
  if (file.stepFunction) return file.stepFunction;
  throw new AppError(
    409,
    "PIPELINE_BATCH_FILE_STEP_FUNCTION_NOT_MAPPED",
    `No individual Step Functions mapping is available for ${file.expectedFileName}.`,
  );
}

function attachConfiguration(
  files: Awaited<
    ReturnType<
      AppDependencies["processingPipelineStorage"]["listExpectedFiles"]
    >
  >,
  requirements: Awaited<ReturnType<typeof getProcessingPipelineRequirements>>,
  bucket: string,
  uploadActivity: Map<
    string,
    { uploadedAt: string; uploadedBy: string | null }
  >,
) {
  const requirementsByName = new Map(
    requirements.map((requirement) => [requirement.fileName, requirement]),
  );
  return files.map((file) => {
    const requirement = requirementsByName.get(file.expectedFileName);
    if (!requirement) return file;
    return {
      ...file,
      uploadedAt: file.key
        ? (uploadActivity.get(file.key)?.uploadedAt ?? file.lastModified)
        : null,
      uploadedBy: file.key
        ? (uploadActivity.get(file.key)?.uploadedBy ?? null)
        : null,
      match: requirement.match,
      stepFunction: requirement.stepFunction
        ? {
            stateMachineName: requirement.stepFunction.stateMachineName,
            batchCycle: requirement.stepFunction.batchCycle,
            executionInput: requirement.stepFunction.executionInput,
          }
        : null,
      configuration: {
        acquisitionMethod: requirement.acquisitionMethod,
        sourceConnectionName: requirement.sourceConnectionName,
        remoteSftpHost: requirement.remoteSftpHost,
        remoteSftpSourceDirectory: requirement.remoteSftpSourceDirectory,
        scheduleDescription: requirement.scheduleDescription,
        sourceFilePullRenameRules: requirement.sourceFilePullRenameRules,
        s3Destination: `s3://${bucket}/${requirement.s3KeyPrefix}`,
        legacyPackageName: requirement.legacyPackageName,
        databaseSchemaDestination: requirement.databaseSchemaDestination,
        tableDestinations: requirement.tableDestinations,
        jobMappings: requirement.jobMappings,
      },
    };
  });
}

export function createProcessingPipelinesRouter(
  {
    pool,
    config,
    processingPipelineStorage,
    stepFunctionsRunner,
    logger,
    authenticate,
  }: AppDependencies,
  singleFile: RequestHandler,
) {
  const router = express.Router();
  router.use(authenticate);
  router.use("/:pipelineCode", async (request, _response, next) => {
    try {
      const pipelineCode = pipelineCodeSchema.parse(request.params.pipelineCode);
      await assertModuleAccess(pool, request.auth!.userId, pipelineCode);
      next();
    } catch (error) {
      next(error);
    }
  });
  const resolveBatchFiles = async (
    pipelineCode: string,
    mapping: PipelineBatchStepFunctionMapping,
  ): Promise<ResolvedBatchFile[]> =>
    Promise.all(
      mapping.files.map(async (file) => {
        const key = processingPipelineStorage.fileKey(
          pipelineCode,
          file.expectedFileName,
        );
        return {
          ...file,
          key,
          s3Uri: `s3://${config.S3_BUCKET}/${key}`,
          exists: await processingPipelineStorage.fileExists(pipelineCode, key),
        };
      }),
    );
  // Keep the UI's primary catalogue request intentionally small and stable.
  router.get("/", async (request, response) => {
    const catalog = await getProcessingPipelineCatalog(pool);
    const allowed = new Set(
      (await getEffectiveModules(pool, request.auth!.userId)).map(
        (module) => module.moduleId,
      ),
    );
    response.json({
      pipelines: catalog.pipelines.filter((pipeline) => allowed.has(pipeline.code)),
    });
  });
  router.get("/:pipelineCode", async (request, response) => {
    const pipelineCode = pipelineCodeSchema.parse(request.params.pipelineCode);
    const detail = await getPipelineDetail(pool, pipelineCode);
    if (!detail)
      throw new AppError(
        404,
        "PIPELINE_NOT_FOUND",
        "The requested processing pipeline was not found.",
      );
    response.json(detail);
  });
  router.get("/:pipelineCode/requirements", async (request, response) => {
    const pipelineCode = pipelineCodeSchema.parse(request.params.pipelineCode);
    const { purpose } = z
      .object({ purpose: z.literal("web-upload").optional() })
      .parse(request.query);
    const requirements = await getProcessingPipelineRequirements(
      pool,
      pipelineCode,
    );
    response.json({
      requirements:
        purpose === "web-upload"
          ? requirements.filter(isProcessingPipelineWebUploadRequirement)
          : requirements,
    });
  });
  router.get(
    "/:pipelineCode/execution-details",
    async (request, response) => {
      const pipelineCode = pipelineCodeSchema.parse(
        request.params.pipelineCode,
      );
      const { expectedFileName } = executionDetailsQuerySchema.parse(
        request.query,
      );
      const canonicalExpectedFileName =
        canonicalizeProcessingPipelineExpectedFileName(expectedFileName);
      const requirement = (
        await getProcessingPipelineRequirements(pool, pipelineCode)
      ).find((candidate) => candidate.fileName === canonicalExpectedFileName);
      if (!requirement)
        throw new AppError(
          404,
          "PIPELINE_FILE_NOT_FOUND",
          "The selected file mapping is not available for this pipeline.",
        );
      if (!requirement.stepFunction)
        throw new AppError(
          404,
          "PIPELINE_STEP_FUNCTION_NOT_MAPPED",
          "No Step Functions state machine is mapped to the selected file.",
        );
      const key = processingPipelineStorage.fileKey(
        pipelineCode,
        requirement.fileName,
      );
      let sourceFileExists: boolean;
      try {
        sourceFileExists = await processingPipelineStorage.fileExists(
          pipelineCode,
          key,
        );
      } catch (error) {
        throw mapStorageError(error);
      }
      try {
        const stateMachine = await stepFunctionsRunner.describeStateMachine(
          requirement.stepFunction.stateMachineName,
        );
        const blockingReasons = [
          ...(sourceFileExists ? [] : ["SOURCE_FILE_MISSING"]),
          ...(stateMachine.status === "ACTIVE"
            ? []
            : ["STATE_MACHINE_INACTIVE"]),
          ...(stateMachine.type === "STANDARD"
            ? []
            : ["STATE_MACHINE_NOT_STANDARD"]),
        ];
        response.json({
          pipelineCode,
          expectedFileName: requirement.fileName,
          sourceFile: {
            key,
            s3Uri: `s3://${config.S3_BUCKET}/${key}`,
            exists: sourceFileExists,
          },
          execution: {
            input: requirement.stepFunction.executionInput,
            stateMachine,
          },
          canExecute: blockingReasons.length === 0,
          blockingReasons,
        });
      } catch (error) {
        throw mapStepFunctionError(error);
      }
    },
  );
  router.get(
    "/:pipelineCode/batch-execution-details",
    async (request, response) => {
      const pipelineCode = pipelineCodeSchema.parse(
        request.params.pipelineCode,
      );
      const { batchCycle } = batchRunSchema.parse(request.query);
      const mapping = await getProcessingPipelineBatchStepFunctionMapping(
        pool,
        pipelineCode,
        batchCycle,
      );
      if (!mapping)
        throw new AppError(
          404,
          "PIPELINE_BATCH_STEP_FUNCTION_NOT_MAPPED",
          "No batch Step Functions state machine is mapped to the selected bill cycle.",
        );
      let resolved: ResolvedBatchFile[];
      try {
        resolved = await resolveBatchFiles(pipelineCode, mapping);
      } catch (error) {
        throw mapStorageError(error);
      }
      const available = resolved.filter((file) => file.exists);
      const missing = resolved.filter((file) => !file.exists);
      const sourceFiles = available.map(batchSourceFile);
      const missingFiles = missing.map(batchMissingFile);
      if (!available.length) {
        response.json({
          pipelineCode,
          batchCycle: mapping.batchCycle,
          targetMode: "partial",
          sourceFiles,
          missingFiles,
          execution: { workflows: [] },
          canExecute: false,
          blockingReasons: ["NO_SOURCE_FILES"],
        });
        return;
      }
      if (missing.length) {
        const workflows = available.map((file) => ({
          file,
          stepFunction: individualBatchStepFunction(file),
        }));
        try {
          const described = await Promise.all(
            workflows.map(async ({ file, stepFunction }) => ({
              expectedFileName: file.expectedFileName,
              input: stepFunction.executionInput,
              stateMachine: await stepFunctionsRunner.describeStateMachine(
                stepFunction.stateMachineName,
              ),
            })),
          );
          const blockingReasons = described.flatMap((workflow) => [
            ...(workflow.stateMachine.status === "ACTIVE"
              ? []
              : ["STATE_MACHINE_INACTIVE"]),
            ...(workflow.stateMachine.type === "STANDARD"
              ? []
              : ["STATE_MACHINE_NOT_STANDARD"]),
          ]);
          response.json({
            pipelineCode,
            batchCycle: mapping.batchCycle,
            targetMode: "partial",
            sourceFiles,
            missingFiles,
            execution: { workflows: described },
            canExecute: blockingReasons.length === 0,
            blockingReasons: [...new Set(blockingReasons)],
          });
          return;
        } catch (error) {
          throw mapStepFunctionError(error);
        }
      }
      try {
        const stateMachine = await stepFunctionsRunner.describeStateMachine(
          mapping.stateMachineName,
        );
        const blockingReasons = [
          ...(stateMachine.status === "ACTIVE"
            ? []
            : ["STATE_MACHINE_INACTIVE"]),
          ...(stateMachine.type === "STANDARD"
            ? []
            : ["STATE_MACHINE_NOT_STANDARD"]),
        ];
        response.json({
          pipelineCode,
          batchCycle: mapping.batchCycle,
          targetMode: "batch",
          sourceFiles,
          missingFiles,
          execution: { input: mapping.executionInput, stateMachine },
          canExecute: blockingReasons.length === 0,
          blockingReasons,
        });
      } catch (error) {
        throw mapStepFunctionError(error);
      }
    },
  );
  router.get("/:pipelineCode/files", async (request, response) => {
    const pipelineCode = pipelineCodeSchema.parse(request.params.pipelineCode);
    try {
      const requirements = (
        await getProcessingPipelineRequirements(pool, pipelineCode)
      ).filter(isProcessingPipelineWebUploadRequirement);
      const files = requirements.length
        ? await processingPipelineStorage.listExpectedFiles(
            pipelineCode,
            requirements,
          )
        : [];
      const uploadActivity = await getPipelineFileUploadActivity(
        pool,
        pipelineCode,
        files.flatMap((file) => (file.key ? [file.key] : [])),
      );
      response.json(
        requirements.length
          ? {
              configured: true,
              files: attachConfiguration(
                files,
                requirements,
                config.S3_BUCKET,
                uploadActivity,
              ),
            }
          : { configured: false, files: [] },
      );
    } catch (error) {
      throw mapStorageError(error);
    }
  });
  router.post("/:pipelineCode/upload-batches", async (request, response) => {
    const pipelineCode = pipelineCodeSchema.parse(request.params.pipelineCode);
    const workspaceId = await ensureWorkspace(pool, request.auth!.userId);
    const batch = await createPipelineUploadBatch(pool, {
      id: randomUUID(), pipelineCode, workspaceId, userId: request.auth!.userId,
    });
    if (!batch) throw new AppError(404, "PIPELINE_NOT_FOUND", "The selected processing pipeline was not found.");
    response.status(201).json({ batch: { id: batch.id, createdAt: batch.created_at.toISOString() } });
  });
  router.get("/:pipelineCode/upload-batches", async (request, response) => {
    const pipelineCode = pipelineCodeSchema.parse(request.params.pipelineCode);
    response.json({ batches: await getPipelineUploadBatches(pool, { pipelineCode }) });
  });
  router.get("/:pipelineCode/files/content", async (request, response) => {
    const pipelineCode = pipelineCodeSchema.parse(request.params.pipelineCode);
    const { key } = contentQuerySchema.parse(request.query);
    try {
      const requirements = await getProcessingPipelineRequirements(
        pool,
        pipelineCode,
      );
      const fileName =
        processingPipelineStorage.inboundFileName(pipelineCode, key) ?? "";
      if (
        !requirements.some((requirement) =>
          matchesProcessingPipelineRequirement(requirement, fileName),
        )
      )
        throw new AppError(
          404,
          "PIPELINE_FILE_NOT_FOUND",
          "The requested file is not configured for this pipeline.",
        );
      const file = await processingPipelineStorage.getFile(pipelineCode, key);
      if (!file.Body || typeof (file.Body as Readable).pipe !== "function")
        throw new AppError(
          502,
          "PIPELINE_STORAGE_INVALID",
          "The pipeline storage service returned an invalid file response.",
        );
      const filename = key.split("/").at(-1) ?? "file";
      response.status(200).set({
        "Cache-Control": "private, no-store",
        "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "Content-Type": file.ContentType ?? "application/octet-stream",
      });
      if (file.ContentLength !== undefined)
        response.set("Content-Length", String(file.ContentLength));
      await pipeline(file.Body as Readable, response);
    } catch (error) {
      throw mapStorageError(error);
    }
  });
  router.post("/:pipelineCode/files", singleFile, async (request, response) => {
    if (!request.file)
      throw new AppError(400, "FILE_REQUIRED", "Choose a file to upload.");
    const pipelineCode = pipelineCodeSchema.parse(request.params.pipelineCode);
    const { expectedFileName, replace, batchId } = uploadSchema.parse(
      request.body,
    );
    const extension = request.file.originalname
      .slice(request.file.originalname.lastIndexOf("."))
      .toLowerCase();
    if (!allowedExtensions.has(extension))
      throw new AppError(
        415,
        "PIPELINE_FILE_TYPE",
        "Pipeline uploads must be .xlsx, .xls, .csv, or .txt files.",
      );
    const canonicalExpectedFileName =
      canonicalizeProcessingPipelineExpectedFileName(expectedFileName);
    const requirement = (
      await getProcessingPipelineRequirements(pool, pipelineCode)
    ).find((candidate) => candidate.fileName === canonicalExpectedFileName);
    if (!requirement || !requirement.id)
      throw new AppError(
        404,
        "PIPELINE_FILE_NOT_FOUND",
        "The selected file mapping is not available for this pipeline.",
      );
    if (!isProcessingPipelineWebUploadRequirement(requirement))
      throw new AppError(
        400,
        "PIPELINE_FILE_NOT_UPLOADABLE",
        "SAP output files are acquired automatically and cannot be uploaded through the portal.",
      );
    const localName =
      request.file.originalname.split(/[\\/]/).at(-1) ?? "upload.bin";
    if (
      !isProcessingPipelineWebUploadRequirement({
        ...requirement,
        fileName: localName,
      })
    )
      throw new AppError(
        400,
        "PIPELINE_FILE_NOT_UPLOADABLE",
        "SAP output files are acquired automatically and cannot be uploaded through the portal.",
      );
    const normalizedLocalName =
      canonicalizeProcessingPipelineExpectedFileName(localName);
    const savedName =
      requirement.match === "exact"
        ? requirement.fileName
        : normalizedLocalName;
    const validUploadName = pipelineCode.startsWith("bss_billcycle_")
      ? matchesBillCycleUploadFile(requirement, localName)
      : requirement.match === "glob"
        ? matchesProcessingPipelineRequirement(requirement, savedName)
        : true;
    if (!validUploadName)
      throw new AppError(
        400,
        "PIPELINE_FILENAME_MISMATCH",
        `The selected filename must match ${requirement.fileName}.`,
      );
    const key = processingPipelineStorage.fileKey(pipelineCode, savedName);
    try {
      const exists = await processingPipelineStorage.fileExists(
        pipelineCode,
        key,
      );
      if (exists && replace !== "true")
        throw new AppError(
          409,
          "PIPELINE_FILE_EXISTS",
          "A file already exists at this location. Confirm replacement and try again.",
        );
      const stored = await processingPipelineStorage.uploadFile(
        pipelineCode,
        savedName,
        request.file.buffer,
        request.file.mimetype || "application/octet-stream",
      );
      const workspaceId = await ensureWorkspace(pool, request.auth!.userId);
      if (batchId) {
        const recorded = await recordPipelineUploadBatchFile(pool, {
          batchId,
          pipelineCode,
          workspaceId,
          requirementId: requirement.id,
          originalName: localName,
          objectKey: stored.key,
        });
        if (!recorded)
          throw new AppError(
            404,
            "PIPELINE_UPLOAD_BATCH_NOT_FOUND",
            "The selected upload batch was not found.",
          );
      }
      await audit(pool, workspaceId, "processing-pipeline.file-uploaded", {
        pipelineCode,
        expectedFileName: requirement.fileName,
        originalName: localName,
        objectKey: stored.key,
        replaced: exists,
      });
      response.status(201).json({
        file: stored,
        renamed: requirement.match === "exact" && localName !== savedName,
        replaced: exists,
      });
    } catch (error) {
      throw mapStorageError(error);
    }
  });
  router.delete("/:pipelineCode/files", async (request, response) => {
    const pipelineCode = pipelineCodeSchema.parse(request.params.pipelineCode);
    const { key } = contentQuerySchema.parse(request.query);
    const fileName =
      processingPipelineStorage.inboundFileName(pipelineCode, key) ?? "";
    const requirements = await getProcessingPipelineRequirements(
      pool,
      pipelineCode,
    );
    if (
      !requirements.some((requirement) =>
        matchesProcessingPipelineRequirement(requirement, fileName),
      )
    )
      throw new AppError(
        404,
        "PIPELINE_FILE_NOT_FOUND",
        "The requested file is not configured for this pipeline.",
      );
    try {
      if (!(await processingPipelineStorage.fileExists(pipelineCode, key)))
        throw new AppError(
          404,
          "PIPELINE_FILE_NOT_FOUND",
          "The requested file was not found in storage.",
        );
      await processingPipelineStorage.deleteFile(pipelineCode, key);
      await markPipelineUploadFileRemoved(pool, pipelineCode, key);
      const workspaceId = await ensureWorkspace(pool, request.auth!.userId);
      await audit(pool, workspaceId, "processing-pipeline.file-removed", {
        pipelineCode,
        objectKey: key,
      });
      response.status(204).end();
    } catch (error) {
      throw mapStorageError(error);
    }
  });
  router.post(
    "/:pipelineCode/runs",
    async (request, response) => {
      const pipelineCode = pipelineCodeSchema.parse(
        request.params.pipelineCode,
      );
      const { expectedFileName } = expectedFileSchema.parse(request.body);
      const canonicalExpectedFileName =
        canonicalizeProcessingPipelineExpectedFileName(expectedFileName);
      const requirement = (
        await getProcessingPipelineRequirements(pool, pipelineCode)
      ).find((candidate) => candidate.fileName === canonicalExpectedFileName);
      if (!requirement)
        throw new AppError(
          404,
          "PIPELINE_FILE_NOT_FOUND",
          "The selected file mapping is not available for this pipeline.",
        );
      if (!requirement.stepFunction)
        throw new AppError(
          404,
          "PIPELINE_STEP_FUNCTION_NOT_MAPPED",
          "No Step Functions state machine is mapped to the selected file.",
        );
      if (requirement.match !== "exact")
        throw new AppError(
          400,
          "PIPELINE_FILE_PATTERN_UNSUPPORTED",
          "A specific file must be selected before starting its processing run.",
        );
      const key = processingPipelineStorage.fileKey(
        pipelineCode,
        requirement.fileName,
      );
      try {
        if (!(await processingPipelineStorage.fileExists(pipelineCode, key)))
          throw new AppError(
            404,
            "PIPELINE_FILE_NOT_FOUND",
            "Upload the selected file before starting its processing run.",
          );
      } catch (error) {
        throw mapStorageError(error);
      }
      const runId = randomUUID();
      const workspaceId = await ensureWorkspace(pool, request.auth!.userId);
      try {
        const stateMachine = await stepFunctionsRunner.describeStateMachine(
          requirement.stepFunction.stateMachineName,
        );
        if (
          stateMachine.status !== "ACTIVE" ||
          stateMachine.type !== "STANDARD"
        )
          throw new AppError(
            409,
            "PIPELINE_STEP_FUNCTION_NOT_RUNNABLE",
            "The mapped Step Functions state machine must be active and Standard before it can be run.",
          );
        const started = await stepFunctionsRunner.startExecution(
          requirement.stepFunction.stateMachineName,
          requirement.stepFunction.executionInput,
        );
        const sourceFiles = [
          {
            expectedFileName: requirement.fileName,
            key,
            s3Uri: `s3://${config.S3_BUCKET}/${key}`,
          },
        ];
        await createStepFunctionExecution(pool, {
          id: runId,
          fileMappingId: requirement.stepFunction.mappingId,
          executionArn: started.executionArn,
          executionInput: requirement.stepFunction.executionInput,
          sourceFiles,
          workspaceId,
          startedByUserId: request.auth!.userId,
          status: "RUNNING",
          startedAt: started.startedAt,
        });
        try {
          await audit(
            pool,
            workspaceId,
            "processing-pipeline.step-function-started",
            {
              pipelineCode,
              expectedFileName: requirement.fileName,
              objectKey: key,
              stateMachineName: requirement.stepFunction.stateMachineName,
              executionInput: requirement.stepFunction.executionInput,
              runId,
              executionArn: started.executionArn,
            },
          );
        } catch (error) {
          logger.error("processing_pipeline.step_function_audit_failed", {
            error: String(error),
          });
        }
        response.status(201).json({
          runId,
          targetMode: "adhoc",
          stateMachineName: requirement.stepFunction.stateMachineName,
          executionInput: requirement.stepFunction.executionInput,
          startedAt: started.startedAt,
        });
      } catch (error) {
        throw mapStepFunctionError(error);
      }
    },
  );
  router.post(
    "/:pipelineCode/batch-runs",
    async (request, response) => {
      const pipelineCode = pipelineCodeSchema.parse(
        request.params.pipelineCode,
      );
      const { batchCycle } = batchRunSchema.parse(request.body);
      const mapping = await getProcessingPipelineBatchStepFunctionMapping(
        pool,
        pipelineCode,
        batchCycle,
      );
      if (!mapping)
        throw new AppError(
          404,
          "PIPELINE_BATCH_STEP_FUNCTION_NOT_MAPPED",
          "No batch Step Functions state machine is mapped to the selected bill cycle.",
        );
      let resolved: ResolvedBatchFile[];
      try {
        resolved = await resolveBatchFiles(pipelineCode, mapping);
      } catch (error) {
        throw mapStorageError(error);
      }
      const available = resolved.filter((file) => file.exists);
      const missing = resolved.filter((file) => !file.exists);
      const sourceFiles = available.map(batchSourceFile);
      const missingFiles = missing.map(batchMissingFile);
      if (!available.length)
        throw new AppError(
          409,
          "PIPELINE_BATCH_NO_SOURCE_FILES",
          "Upload at least one mapped batch source file before starting the execution.",
        );
      const workspaceId = await ensureWorkspace(pool, request.auth!.userId);
      if (missing.length) {
        const workflows = available.map((file) => ({
          file,
          stepFunction: individualBatchStepFunction(file),
        }));
        try {
          const stateMachines = await Promise.all(
            workflows.map(async ({ file, stepFunction }) => ({
              file,
              stepFunction,
              stateMachine: await stepFunctionsRunner.describeStateMachine(
                stepFunction.stateMachineName,
              ),
            })),
          );
          if (
            stateMachines.some(
              ({ stateMachine }) =>
                stateMachine.status !== "ACTIVE" ||
                stateMachine.type !== "STANDARD",
            )
          )
            throw new AppError(
              409,
              "PIPELINE_STEP_FUNCTION_NOT_RUNNABLE",
              "Every mapped Step Functions state machine must be active and Standard before a partial batch can run.",
            );

          const startedRuns: {
            runId: string;
            expectedFileName: string;
            key: string;
            s3Uri: string;
            stateMachineName: string;
            executionInput: Record<string, unknown>;
            startedAt: string;
          }[] = [];
          const failedFiles: {
            expectedFileName: string;
            key: string;
            s3Uri: string;
            error: { status: number; code: string; message: string };
          }[] = [];
          for (const { file, stepFunction } of workflows) {
            try {
              const started = await stepFunctionsRunner.startExecution(
                stepFunction.stateMachineName,
                stepFunction.executionInput,
              );
              const runId = randomUUID();
              const run = {
                runId,
                expectedFileName: file.expectedFileName,
                key: file.key,
                s3Uri: file.s3Uri,
                stateMachineName: stepFunction.stateMachineName,
                executionInput: stepFunction.executionInput,
                startedAt: started.startedAt,
              };
              await createStepFunctionExecution(pool, {
                id: runId,
                fileMappingId: stepFunction.mappingId,
                executionArn: started.executionArn,
                executionInput: stepFunction.executionInput,
                sourceFiles: [batchSourceFile(file)],
                workspaceId,
                startedByUserId: request.auth!.userId,
                status: "RUNNING",
                startedAt: started.startedAt,
              });
              startedRuns.push(run);
            } catch (error) {
              const mapped = mapStepFunctionError(error);
              failedFiles.push({
                expectedFileName: file.expectedFileName,
                key: file.key,
                s3Uri: file.s3Uri,
                error: {
                  status: mapped.status,
                  code: mapped.code,
                  message: mapped.message,
                },
              });
            }
          }
          if (!startedRuns.length) {
            const failure = failedFiles[0]?.error;
            throw new AppError(
              failure?.status ?? 502,
              failure?.code ?? "PIPELINE_STEP_FUNCTION_UNAVAILABLE",
              failure?.message ??
                "No Step Functions workflow could be started.",
            );
          }
          try {
            await audit(
              pool,
              workspaceId,
              "processing-pipeline.partial-batch-started",
              {
                pipelineCode,
                batchCycle,
                sourceFiles,
                missingFiles,
                startedRuns,
                failedFiles,
              },
            );
          } catch (error) {
            logger.error("processing_pipeline.partial_batch_audit_failed", {
              error: String(error),
            });
          }
          response.status(failedFiles.length ? 207 : 201).json({
            targetMode: "partial",
            batchCycle,
            sourceFiles,
            missingFiles,
            startedRuns,
            failedFiles,
          });
          return;
        } catch (error) {
          throw mapStepFunctionError(error);
        }
      }
      const runId = randomUUID();
      try {
        const stateMachine = await stepFunctionsRunner.describeStateMachine(
          mapping.stateMachineName,
        );
        if (
          stateMachine.status !== "ACTIVE" ||
          stateMachine.type !== "STANDARD"
        )
          throw new AppError(
            409,
            "PIPELINE_STEP_FUNCTION_NOT_RUNNABLE",
            "The mapped Step Functions state machine must be active and Standard before it can be run.",
          );
        const started = await stepFunctionsRunner.startExecution(
          mapping.stateMachineName,
          mapping.executionInput,
        );
        await createStepFunctionExecution(pool, {
          id: runId,
          batchMappingId: mapping.mappingId,
          executionArn: started.executionArn,
          executionInput: mapping.executionInput,
          sourceFiles,
          workspaceId,
          startedByUserId: request.auth!.userId,
          status: "RUNNING",
          startedAt: started.startedAt,
        });
        try {
          await audit(
            pool,
            workspaceId,
            "processing-pipeline.batch-step-function-started",
            {
              pipelineCode,
              batchCycle,
              sourceFiles,
              stateMachineName: mapping.stateMachineName,
              executionInput: mapping.executionInput,
              runId,
              executionArn: started.executionArn,
            },
          );
        } catch (error) {
          logger.error("processing_pipeline.batch_step_function_audit_failed", {
            error: String(error),
          });
        }
        response.status(201).json({
          runId,
          targetMode: "batch",
          stateMachineName: mapping.stateMachineName,
          executionInput: mapping.executionInput,
          sourceFiles,
          startedAt: started.startedAt,
        });
      } catch (error) {
        throw mapStepFunctionError(error);
      }
    },
  );
  router.get(
    "/:pipelineCode/runs/:runId",
    async (request, response) => {
      const pipelineCode = pipelineCodeSchema.parse(
        request.params.pipelineCode,
      );
      const runId = z.string().uuid().parse(request.params.runId);
      const execution = await getStepFunctionExecution(
        pool,
        runId,
        pipelineCode,
      );
      if (!execution)
        throw new AppError(
          404,
          "PIPELINE_RUN_NOT_FOUND",
          "The requested processing run was not found for this pipeline.",
        );
      try {
        const [observed, stateMachine] = await Promise.all([
          stepFunctionsRunner.describeExecution(execution.executionArn),
          stepFunctionsRunner.describeStateMachine(execution.stateMachineName),
        ]);
        await updateStepFunctionExecution(pool, runId, observed);
        const durationMs = observed.completedAt
          ? new Date(observed.completedAt).getTime() -
            new Date(observed.startedAt ?? execution.startedAt).getTime()
          : null;
        const region = encodeURIComponent(config.AWS_REGION);
        response.json({
          runId,
          targetMode: execution.targetMode,
          executionArn: execution.executionArn,
          stateMachineName: execution.stateMachineName,
          stateMachine,
          executionInput: execution.executionInput,
          sourceFiles: execution.sourceFiles,
          status: observed.status,
          errorCode: observed.errorCode,
          errorMessage: observed.errorMessage,
          input: observed.input,
          inputIncluded: observed.inputIncluded,
          output: observed.output,
          outputIncluded: observed.outputIncluded,
          mapRunArn: observed.mapRunArn,
          traceHeader: observed.traceHeader,
          startedAt: observed.startedAt ?? execution.startedAt,
          completedAt: observed.completedAt,
          durationMs,
          lastObservedAt: new Date().toISOString(),
          stepFunctionsConsoleUrl: `https://${config.AWS_REGION}.console.aws.amazon.com/states/home?region=${region}#/statemachines`,
        });
      } catch (error) {
        throw mapStepFunctionError(error);
      }
    },
  );
  return router;
}
