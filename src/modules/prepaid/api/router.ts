import { z } from "zod";
import { batchLayoutEditSchema } from "../domain/contracts.js";
import {
  PrepaidFullBatch,
  prepaidFullBatchPrefix,
} from "../application/fullBatch.js";
import express, { type RequestHandler } from "express";
import type { AppDependencies } from "../../../app/dependencies.js";
import { assertModuleAccess } from "../../../rbac.js";
import { AppError } from "../../../errors.js";
import { PrepaidRunService } from "../application/runService.js";
import { builtinPrepaidConfiguration } from "../domain/builtinConfiguration.js";
import { PrepaidWorkspaceService } from "../application/workspaceService.js";
import { PrepaidReferenceRefreshService } from "../application/referenceRefreshService.js";
import { PrepaidRepository } from "../infrastructure/repository.js";
import { PrepaidReferenceCatalog } from "../infrastructure/referenceCatalog.js";
import { createPrepaidStorage } from "../infrastructure/prepaidStorage.js";
import { registerPrepaidWorkspaceRoutes } from "./workspaceRoutes.js";
import { registerPrepaidConfigurationRoutes } from "./configurationRoutes.js";
import { registerPrepaidRunsRoutes } from "./runsRoutes.js";
import { registerPrepaidLayoutsRoutes } from "./layoutsRoutes.js";
import { registerPrepaidReportsRoutes } from "./reportsRoutes.js";
import { registerPrepaidCompatibilityRoutes } from "./compatibilityRoutes.js";
/** Composition root: authenticate, check schema, then register feature endpoints. */
export function createPrepaidRouter(
  dependencies: AppDependencies,
  upload: RequestHandler,
) {
  const { pool, config, authenticate } = dependencies;
  const service = new PrepaidRunService(
    new PrepaidRepository(pool, config.DATABASE_SCHEMA),
    dependencies.prepaidStorage ?? createPrepaidStorage(config),
    builtinPrepaidConfiguration(config),
  );
  const router = express.Router();
  const envPrefix = prepaidFullBatchPrefix(config);
  const batch = envPrefix
    ? new PrepaidFullBatch(
        service.repo,
        service.storage,
        dependencies.stepFunctionsRunner,
        envPrefix,
        config.PREPAID_FULL_BATCH_DELIVERY_ENABLED === "true",
      )
    : undefined;
  const workspace = new PrepaidWorkspaceService(service, batch);
  const references = new PrepaidReferenceRefreshService(service.repo);
  const catalog = new PrepaidReferenceCatalog(service.repo);
  router.use(authenticate);
  router.use(async (req, _res, next) => {
    try {
      await assertModuleAccess(pool, req.auth!.userId, "prepaid_reclass");
      next();
    } catch (error) {
      next(error);
    }
  });
  router.get("/readiness", async (_req, res) => {
    const startup = dependencies.prepaidStartupStatus?.();
    const readiness = await service.readiness();
    const checks = [...readiness.checks];
    if (startup?.baseIssue)
      checks.unshift({ code: "startupMigrations", status: "missing", message: startup.baseIssue });
    if (batch && startup?.billingIssue)
      checks.unshift({ code: "billingMigrations", status: "missing", message: startup.billingIssue });
    res.json({
      ...readiness,
      readyForUploads: readiness.readyForUploads && !startup?.baseIssue,
      readyForPreparation: readiness.readyForPreparation && !startup?.baseIssue && !(batch && startup?.billingIssue),
      checks,
    });
  });
  router.use((_req, _res, next) => {
    const issue = dependencies.prepaidStartupStatus?.()?.baseIssue;
    next(issue ? new AppError(503, "PREPAID_MIGRATIONS_PENDING", issue) : undefined);
  });
  router.post("/workspace/prepare", (_req, _res, next) => {
    const issue = batch && dependencies.prepaidStartupStatus?.()?.billingIssue;
    next(issue ? new AppError(503, "PREPAID_BILLING_MIGRATIONS_PENDING", issue) : undefined);
  });
  router.use(async (_req, _res, next) => {
    try {
      const ready = await pool.query(
        "WITH workflow_constraint AS MATERIALIZED (SELECT oid FROM pg_constraint WHERE conrelid=to_regclass($5) AND conname='prepaid_source_extractions_workflow_check' AND contype='c' AND convalidated) SELECT to_regclass($1) present, to_regclass($2) workspace, to_regclass($3) consistency,to_regclass($4) legacy,to_regclass($5) extractions, EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass($5) AND attname='context' AND NOT attisdropped) backend_context, EXISTS(SELECT 1 FROM workflow_constraint WHERE pg_get_constraintdef(oid) LIKE '%charges_318%') all_sources, to_regclass($6) batch_table",
        [
          `${service.repo.schema}.prepaid_runs`,
          `${service.repo.schema}.prepaid_upload_sessions`,
          `${service.repo.schema}.prepaid_snapshot_context`,
          `${service.repo.schema}.prepaid_source_totals`,
          `${service.repo.schema}.prepaid_source_extractions`,
          service.repo.table("full_batches"),
        ],
      );
      if (
        !ready.rows[0]?.present ||
        !ready.rows[0]?.workspace ||
        !ready.rows[0]?.consistency ||
        !ready.rows[0]?.legacy ||
        !ready.rows[0]?.extractions ||
        !ready.rows[0]?.backend_context ||
        !ready.rows[0]?.all_sources
      )
        throw new AppError(
          503,
          "PREPAID_SCHEMA_NOT_INSTALLED",
          "Prepaid-only migrations 001 through 008 must be installed before using this backend.",
        );
      if (batch && !ready.rows[0].batch_table)
        throw new AppError(
          503,
          "PREPAID_BATCH_SCHEMA_NOT_INSTALLED",
          "Install Prepaid migration 015 before running the batch workflow.",
        );
      next();
    } catch (error) {
      next(error);
    }
  });
  router.use("/workspace", async (_req, _res, next) => {
    try {
      const result = await pool.query("SELECT to_regclass($1) present", [
        `${service.repo.schema}.prepaid_upload_sessions`,
      ]);
      if (!result.rows[0]?.present)
        throw new AppError(
          503,
          "PREPAID_WORKSPACE_SCHEMA_NOT_INSTALLED",
          "Install Prepaid migration 002 before using source upload sessions.",
        );
      next();
    } catch (error) {
      next(error);
    }
  });
  const context = { pool, service, workspace, references, catalog, upload };
  router.get("/aws-batch", async (req, res) =>
    res.json({
      enabled: !!batch,
      batch: batch ? await batch.status(req.auth!.userId) : null,
    }),
  );
  router.get("/aws-batch/review/:region/:section", async (req, res) => {
    if (!batch)
      throw new AppError(404, "PREPAID_BATCH_DISABLED", "Batch review is unavailable.");
    const input = z.object({
      batchId: z.string().uuid(),
      variant: z.enum(["mt", "bb"]).default("mt"),
      offset: z.coerce.number().int().min(0).max(100000).default(0),
    }).parse(req.query);
    res.json(await batch.review(
      req.auth!.userId,
      input.batchId,
      z.enum(["eg", "sg"]).parse(req.params.region),
      z.enum(["layout", "allocation", "allocation-summary", "jv"]).parse(req.params.section),
      input.variant,
      input.offset,
    ));
  });
  router.patch("/aws-batch/review/:region/layout", async (req, res) => {
    if (!batch)
      throw new AppError(404, "PREPAID_BATCH_DISABLED", "Batch review is unavailable.");
    const input = batchLayoutEditSchema.parse(req.body);
    res.json(await batch.saveLayout(
      req.auth!.userId, input.batchId, z.enum(["eg", "sg"]).parse(req.params.region),
      input.layoutVersion, input.changes,
    ));
  });
  router.get("/aws-batch/:batchId/reports/amaxee.xlsx", async (req, res) => {
    if (!batch)
      throw new AppError(404, "PREPAID_BATCH_DISABLED", "Batch reports are unavailable.");
    const report = await batch.downloadAmaxee(
      req.auth!.userId,
      z.string().uuid().parse(req.params.batchId),
    );
    res.set("Cache-Control", "private, no-store")
      .attachment(report.filename)
      .type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .send(report.bytes);
  });
  router.get("/aws-batch/:batchId/journal/:region", async (req, res) => {
    if (!batch)
      throw new AppError(404, "PREPAID_BATCH_DISABLED", "Batch reports are unavailable.");
    const workbook = await batch.downloadWorkbook(
      req.auth!.userId,
      z.string().uuid().parse(req.params.batchId),
      z.enum(["eg", "sg"]).parse(req.params.region),
    );
    res.attachment(workbook.filename)
      .type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .send(workbook.bytes);
  });
  router.get("/aws-batch/journal/:region", async (req, res) => {
    if (!batch)
      throw new AppError(
        404,
        "PREPAID_BATCH_DISABLED",
        "AWS batch is disabled on this portal.",
      );
    res.json(
      await batch.download(
        req.auth!.userId,
        z.enum(["eg", "sg"]).parse(req.params.region),
      ),
    );
  });
  router.post("/aws-batch/action", async (req, res) => {
    if (!batch)
      throw new AppError(
        404,
        "PREPAID_BATCH_DISABLED",
        "AWS batch is disabled on this portal.",
      );
    res
      .status(202)
      .json(
        await batch.action(
          req.auth!.userId,
          z.enum(["eg", "sg", "close"]).parse(req.body?.action),
        ),
      );
  });
  registerPrepaidWorkspaceRoutes(router, context);
  registerPrepaidConfigurationRoutes(router, context);
  registerPrepaidRunsRoutes(router, context);
  registerPrepaidLayoutsRoutes(router, context);
  registerPrepaidReportsRoutes(router, context);
  registerPrepaidCompatibilityRoutes(router, context);
  return router;
}
