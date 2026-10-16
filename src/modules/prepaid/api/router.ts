import express, { type RequestHandler } from "express";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import type { AppDependencies } from "../../../app/dependencies.js";
import { assertModuleAccess } from "../../../rbac.js";
import { AppError } from "../../../errors.js";
import { PrepaidRunService } from "../application/runService.js";
import { PrepaidWorkspaceService } from "../application/workspaceService.js";
import { frozenReports } from "../application/reportService.js";
import { PrepaidRepository } from "../infrastructure/repository.js";
import { createPrepaidStorage } from "../infrastructure/prepaidStorage.js";
import {
  commandSchema,
  editSchema,
  manualIntegrationSchema,
  periodSchema,
  regionSchema,
  sourceCodeSchema,
  encodeDelimited,
} from "../domain/contracts.js";

const uuid = z.string().uuid();
const page = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().nonnegative().default(0),
  revisionId: uuid.optional(),
});
export function createPrepaidRouter(
  dependencies: AppDependencies,
  upload: RequestHandler,
) {
  const { pool, config, authenticate } = dependencies;
  const service = new PrepaidRunService(
    new PrepaidRepository(pool, config.DATABASE_SCHEMA),
    dependencies.prepaidStorage ?? createPrepaidStorage(config),
  );
  const router = express.Router();
  const workspace = new PrepaidWorkspaceService(service);
  router.use(authenticate);
  router.use(async (req, _res, next) => {
    try {
      await assertModuleAccess(pool, req.auth!.userId, "prepaid_reclass");
      next();
    } catch (error) {
      next(error);
    }
  });
  router.get("/readiness", async (_req, res) =>
    res.json(await service.readiness()),
  );
  router.use(async (_req, _res, next) => {
    try {
      const ready = await pool.query(
        "SELECT to_regclass($1) present, to_regclass($2) workspace, to_regclass($3) consistency,to_regclass($4) legacy,to_regclass($5) extractions, EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass($5) AND attname='context' AND NOT attisdropped) backend_context",
        [
          `${service.repo.schema}.prepaid_runs`,
          `${service.repo.schema}.prepaid_upload_sessions`,
          `${service.repo.schema}.prepaid_snapshot_context`,
          `${service.repo.schema}.prepaid_source_totals`,
          `${service.repo.schema}.prepaid_source_extractions`,
        ],
      );
      if (
        !ready.rows[0]?.present ||
        !ready.rows[0]?.workspace ||
        !ready.rows[0]?.consistency ||
        !ready.rows[0]?.legacy ||
        !ready.rows[0]?.extractions ||
        !ready.rows[0]?.backend_context
      )
        throw new AppError(
          503,
          "PREPAID_SCHEMA_NOT_INSTALLED",
          "Prepaid-only migrations 001 through 007 must be installed before using this backend.",
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
  router.get("/workspace", async (req, res) => {
    res.json(await workspace.state(req.auth!.userId));
  });
  router.get("/workspace/extractions", async (req, res) => {
    res.json(await workspace.extractions(req.auth!.userId));
  });
  router.post("/workspace/sources/:code", upload, async (req, res) => {
    if (!req.file)
      throw new AppError(
        400,
        "PREPAID_FILE_REQUIRED",
        "Attach a file in multipart field 'file'.",
      );
    res
      .status(201)
      .json(
        await workspace.upload(
          req.auth!.userId,
          sourceCodeSchema.parse(req.params.code),
          req.file,
        ),
      );
  });
  router.delete("/workspace/sources/:code", async (req, res) => {
    res.json(
      await workspace.remove(
        req.auth!.userId,
        sourceCodeSchema.parse(req.params.code),
      ),
    );
  });
  router.post("/workspace/prepare", async (req, res) => {
    res.json(await workspace.prepare(req.auth!.userId));
  });
  router.post("/workspace/reset", async (req, res) => {
    const input = z
      .object({
        runId: uuid.optional(),
        eg: z.number().int().nonnegative().optional(),
        sg: z.number().int().nonnegative().optional(),
        sessionId: uuid.optional(),
        sessionVersion: z.number().int().nonnegative().optional(),
      })
      .parse(req.body);
    res.json(await workspace.reset(req.auth!.userId, input));
  });
  router.get("/integration", async (_req, res) => {
    res.json(await service.integration());
  });
  router.put("/integration", async (req, res) => {
    res.json(
      await service.configure(
        req.auth!.userId,
        manualIntegrationSchema.parse(req.body),
      ),
    );
  });
  router.get("/report-history", async (req, res) => {
    const input = z
      .object({
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .refine((value) => {
            const parsed = new Date(`${value}T00:00:00Z`);
            return (
              !Number.isNaN(parsed.getTime()) &&
              parsed.toISOString().slice(0, 10) === value
            );
          }, "Invalid calendar date")
          .optional(),
        limit: z.coerce.number().int().min(1).max(100).default(25),
        offset: z.coerce.number().int().nonnegative().default(0),
      })
      .parse(req.query);
    res.json(
      await service.reportHistory(
        req.auth!.userId,
        input.date,
        input.limit,
        input.offset,
      ),
    );
  });
  router.get("/runs/:runId/reports/:snapshotFile", async (req, res) => {
    const snapshotId = uuid.parse(
      z
        .string()
        .regex(/\.zip$/)
        .parse(req.params.snapshotFile)
        .slice(0, -4),
    );
    const bytes = await frozenReports(
      service,
      req.auth!.userId,
      uuid.parse(req.params.runId),
      snapshotId,
    );
    res
      .attachment(`prepaid-${snapshotId}-reports.zip`)
      .type("application/zip")
      .send(bytes);
  });
  router.post("/runs/:runId/reset-workspace", async (req, res) => {
    const versions = z
      .object({
        eg: z.number().int().nonnegative(),
        sg: z.number().int().nonnegative(),
      })
      .parse(req.body);
    res.json(
      await service.resetWorkspace(
        req.auth!.userId,
        uuid.parse(req.params.runId),
        versions,
      ),
    );
  });
  router.get(
    "/runs/:runId/layouts/:region/allocation-summary",
    async (req, res) => {
      const input = z
        .object({ variant: z.enum(["mt", "bb"]), revisionId: uuid.optional() })
        .parse(req.query);
      res.json(
        await service.allocationSummary(
          req.auth!.userId,
          uuid.parse(req.params.runId),
          regionSchema.parse(req.params.region),
          input.variant,
          input.revisionId,
        ),
      );
    },
  );
  router.get(
    "/runs/:runId/layouts/:region/reconciliation.csv",
    async (req, res) => {
      const runId = uuid.parse(req.params.runId),
        region = regionSchema.parse(req.params.region),
        revisionId = uuid.optional().parse(req.query.revisionId);
      const output = await service.output(
        req.auth!.userId,
        runId,
        region,
        "reconciliation_rows",
        undefined,
        500,
        0,
        revisionId,
      );
      if (revisionId && !["frozen", "superseded"].includes(output.status))
        throw new AppError(
          409,
          "PREPAID_REPORT_NOT_FROZEN",
          "Archived reports require a frozen revision.",
        );
      const fields = [
        "revenue_type",
        "allocation_type",
        "tax_rate",
        "gross",
        "amount",
        "tax_amount",
        "total_gross",
        "difference",
      ];
      const rows = (
        await pool.query(
          `SELECT ${fields.join(",")} FROM ${service.repo.table("reconciliation_rows")} WHERE revision_id=$1 ORDER BY revenue_type,allocation_type,tax_rate`,
          [output.revisionId],
        )
      ).rows;
      res
        .attachment(`prepaid-${region}-reconciliation.csv`)
        .type("text/csv")
        .send(encodeDelimited(rows, fields, ",", "\r\n", "utf8"));
    },
  );
  router.get("/runs", async (req, res) => {
    res.json({ runs: await service.list(req.auth!.userId) });
  });
  router.post("/runs", async (req, res) => {
    res
      .status(201)
      .json(
        await service.create(
          req.auth!.userId,
          z.object({ period: periodSchema }).parse(req.body).period,
        ),
      );
  });
  router.get("/runs/:runId", async (req, res) => {
    res.json(await service.get(req.auth!.userId, uuid.parse(req.params.runId)));
  });
  router.post("/runs/:runId/select", async (req, res) => {
    res.json(
      await service.select(req.auth!.userId, uuid.parse(req.params.runId)),
    );
  });
  router.get("/runs/:runId/sources", async (req, res) => {
    res.json(
      await service.sources(req.auth!.userId, uuid.parse(req.params.runId)),
    );
  });
  router.post(
    "/runs/:runId/sources/:code",
    async (req, _res, next) => {
      try {
        await service.repo.own(
          pool,
          req.auth!.userId,
          uuid.parse(req.params.runId),
        );
        sourceCodeSchema.parse(req.params.code);
        next();
      } catch (error) {
        next(error);
      }
    },
    upload,
    async (req, res) => {
      if (!req.file)
        throw new AppError(
          400,
          "PREPAID_FILE_REQUIRED",
          "Attach a file in multipart field 'file'.",
        );
      res
        .status(201)
        .json(
          await service.upload(
            req.auth!.userId,
            uuid.parse(req.params.runId),
            sourceCodeSchema.parse(req.params.code),
            req.file,
          ),
        );
    },
  );
  router.delete("/runs/:runId/sources/:code", async (req, res) => {
    res.json(
      await service.remove(
        req.auth!.userId,
        uuid.parse(req.params.runId),
        sourceCodeSchema.parse(req.params.code),
      ),
    );
  });
  router.post("/runs/:runId/upstream", async (req, res) => {
    res
      .status(201)
      .json(
        await service.attachUpstream(
          req.auth!.userId,
          uuid.parse(req.params.runId),
          z.object({ manifestKey: z.string().min(1) }).parse(req.body)
            .manifestKey,
        ),
      );
  });
  router.delete("/runs/:runId/upstream", async (req, res) => {
    res.json(
      await service.removeUpstream(
        req.auth!.userId,
        uuid.parse(req.params.runId),
      ),
    );
  });
  router.post("/runs/:runId/process", async (req, res) => {
    res
      .status(202)
      .json(
        await service.process(req.auth!.userId, uuid.parse(req.params.runId)),
      );
  });
  router.get("/runs/:runId/layouts/:region", async (req, res) => {
    res.json(
      await service.layout(
        req.auth!.userId,
        uuid.parse(req.params.runId),
        regionSchema.parse(req.params.region),
      ),
    );
  });
  router.patch("/runs/:runId/layouts/:region", async (req, res) => {
    res.json(
      await service.save(
        req.auth!.userId,
        uuid.parse(req.params.runId),
        regionSchema.parse(req.params.region),
        editSchema.parse(req.body),
      ),
    );
  });
  for (const action of ["import", "reset", "validate"] as const)
    router.post(`/runs/:runId/layouts/:region/${action}`, async (req, res) => {
      res.json(
        await service.command(
          req.auth!.userId,
          uuid.parse(req.params.runId),
          regionSchema.parse(req.params.region),
          action,
          commandSchema.parse(req.body).version,
        ),
      );
    });
  router.post("/runs/:runId/layouts/:region/edit", async (req, res) => {
    const input = commandSchema
      .extend({
        reason: z
          .string()
          .trim()
          .min(1)
          .max(1000)
          .default("Frozen layout edited from Prepaid workspace"),
      })
      .parse(req.body);
    res.json(
      await service.edit(
        req.auth!.userId,
        uuid.parse(req.params.runId),
        regionSchema.parse(req.params.region),
        input.version,
        input.reason,
      ),
    );
  });
  router.post("/runs/:runId/layouts/:region/freeze", async (req, res) => {
    res
      .status(200)
      .json(
        await service.freeze(
          req.auth!.userId,
          uuid.parse(req.params.runId),
          regionSchema.parse(req.params.region),
          commandSchema.parse(req.body).version,
        ),
      );
  });
  for (const [path, table] of [
    ["allocations", "allocations"],
    ["reconciliation", "reconciliation_rows"],
    ["jv", "jv_lines"],
  ] as const)
    router.get(`/runs/:runId/layouts/:region/${path}`, async (req, res) => {
      const input = page.parse(req.query),
        variant =
          path === "allocations"
            ? z.enum(["mt", "bb"]).optional().parse(req.query.variant)
            : undefined;
      res.json(
        await service.output(
          req.auth!.userId,
          uuid.parse(req.params.runId),
          regionSchema.parse(req.params.region),
          table,
          variant,
          input.limit,
          input.offset,
          input.revisionId,
        ),
      );
    });
  for (const suffix of [
    "reference-membership",
    "reference-membership.csv",
  ] as const)
    router.get(`/runs/:runId/layouts/:region/${suffix}`, async (req, res) => {
      const input = page
        .extend({ mode: z.enum(["all", "gp-non-bb"]).default("all") })
        .parse(req.query);
      const csv = suffix.endsWith(".csv");
      const result = await service.referenceMembership(
        req.auth!.userId,
        uuid.parse(req.params.runId),
        regionSchema.parse(req.params.region),
        input.mode,
        csv ? 50001 : input.limit,
        csv ? 0 : input.offset,
        input.revisionId,
      );
      if (!csv) {
        res.json(result);
        return;
      }
      if (!result.complete)
        throw new AppError(
          409,
          "PREPAID_REFERENCE_MEMBERSHIP_UNVERIFIED",
          "The reference export must attest legacy BRAND category before this membership report can be generated.",
        );
      if (result.total > 50000)
        throw new AppError(
          413,
          "PREPAID_REPORT_TOO_LARGE",
          "Membership report exceeds 50,000 rows.",
        );
      const headers =
        input.mode === "gp-non-bb"
          ? ["revenue_type", "sub_product", "cost_element"]
          : [
              "revenue_type",
              "sub_product",
              "period",
              "profit_center",
              "cost_element",
              "posting_key",
              "variant",
              "allocation_type",
              "uom",
              "tax_rate",
              "average_rate",
              "hits",
              "amount",
              "denominator",
              "allocation",
              "gross",
              "hits2",
              "amount2",
            ];
      res
        .attachment(`prepaid-reference-membership-${input.mode}.csv`)
        .type("text/csv")
        .send(encodeDelimited(result.rows, headers, ",", "\r\n", "utf8"));
    });
  router.get("/runs/:runId/history", async (req, res) => {
    res.json({
      activities: await service.history(
        req.auth!.userId,
        uuid.parse(req.params.runId),
      ),
    });
  });
  router.get("/runs/:runId/exports", async (req, res) => {
    res.json({
      exports: await service.exports(
        req.auth!.userId,
        uuid.parse(req.params.runId),
      ),
    });
  });
  router.get("/runs/:runId/exports/:exportId/download", async (req, res) => {
    const object = await service.download(
      req.auth!.userId,
      uuid.parse(req.params.runId),
      uuid.parse(req.params.exportId),
    );
    if (!object.Body)
      throw new AppError(
        502,
        "PREPAID_EXPORT_BODY_MISSING",
        "Export object is unavailable.",
      );
    res.attachment("prepaid-jv.txt").type("application/octet-stream");
    await pipeline(object.Body as Readable, res);
  });
  router.post("/runs/:runId/jobs/:jobId/retry", async (req, res) => {
    res
      .status(202)
      .json(
        await service.retry(
          req.auth!.userId,
          uuid.parse(req.params.runId),
          uuid.parse(req.params.jobId),
        ),
      );
  });
  router.post("/runs/:runId/jobs/:jobId/reconcile", async (req, res) => {
    res
      .status(202)
      .json(
        await service.reconcile(
          req.auth!.userId,
          uuid.parse(req.params.runId),
          uuid.parse(req.params.jobId),
          z
            .object({ receiptKey: z.string().min(1).optional() })
            .parse(req.body ?? {}).receiptKey,
        ),
      );
  });
  // Compatibility routes never return demo success or delete global source objects.
  router.get("/state", async (req, res) => {
    let id: string;
    try {
      id = await service.active(req.auth!.userId);
    } catch (error) {
      if (error instanceof AppError && error.code === "PREPAID_RUN_REQUIRED") {
        res.json({
          setupRequired: true,
          runs: await service.list(req.auth!.userId),
          egLayout: { frozen: false, rows: [] },
          sgLayout: { frozen: false, rows: [] },
          allocation: { rows: [], lastValidation: null },
          jv: { rows: [] },
          report: { rows: [] },
          sourceFiles: { expected: [] },
          uploads: [],
        });
        return;
      }
      throw error;
    }
    const [run, egLayout, sgLayout, sources] = await Promise.all([
      service.get(req.auth!.userId, id),
      service.layout(req.auth!.userId, id, "eg"),
      service.layout(req.auth!.userId, id, "sg"),
      service.sources(req.auth!.userId, id),
    ]);
    const [allocation, jv, report] = await Promise.all([
      service.output(req.auth!.userId, id, "eg", "allocations"),
      service.output(req.auth!.userId, id, "eg", "jv_lines"),
      service.output(req.auth!.userId, id, "eg", "reconciliation_rows"),
    ]);
    res.json({
      run,
      egLayout,
      sgLayout,
      allocation: { ...allocation, lastValidation: egLayout.validation },
      jv,
      report,
      sourceFiles: {
        expected: sources.required.map((x) => x.fileName),
        missing: sources.missing,
      },
      uploads: sources.files,
    });
  });
  router.get("/history", async (req, res) => {
    res.json({
      activities: await service.history(
        req.auth!.userId,
        await service.active(req.auth!.userId),
      ),
    });
  });
  router.delete("/uploads", async (req, res) => {
    res.json(
      await service.remove(
        req.auth!.userId,
        await service.active(req.auth!.userId),
      ),
    );
  });
  router.post("/process", async (req, res) => {
    res.status(202).json({
      run: await service.process(
        req.auth!.userId,
        await service.active(req.auth!.userId),
      ),
    });
  });
  for (const action of ["reset", "import"] as const)
    router.post(`/layouts/:region/${action}`, async (req, res) => {
      res.json({
        layout: await service.command(
          req.auth!.userId,
          await service.active(req.auth!.userId),
          regionSchema.parse(req.params.region),
          action,
          commandSchema.parse(req.body).version,
        ),
      });
    });
  router.patch("/layouts/:region/freeze", async (req, res) => {
    const input = commandSchema
      .extend({ frozen: z.literal(true) })
      .parse(req.body);
    res.status(200).json({
      layout: await service.freeze(
        req.auth!.userId,
        await service.active(req.auth!.userId),
        regionSchema.parse(req.params.region),
        input.version,
      ),
    });
  });
  router.post("/allocation/validate", async (req, res) => {
    const input = commandSchema
      .extend({ region: regionSchema })
      .parse(req.body);
    res.json({
      validation: (
        await service.command(
          req.auth!.userId,
          await service.active(req.auth!.userId),
          input.region,
          "validate",
          input.version,
        )
      ).validation,
    });
  });
  router.get("/report.csv", async (req, res) => {
    const id = await service.active(req.auth!.userId),
      region = regionSchema.parse(req.query.region ?? "eg");
    await service.repo.own(pool, req.auth!.userId, id);
    const revision = await service.repo.revision(pool, id, region);
    const rows = (
      await pool.query(
        `SELECT revenue_type,allocation_type,tax_rate,gross,amount,tax_amount,total_gross,difference FROM ${service.repo.table("reconciliation_rows")} WHERE revision_id=$1 ORDER BY revenue_type,allocation_type,tax_rate`,
        [revision.id],
      )
    ).rows;
    res
      .attachment("prepaid-reclass-report.csv")
      .type("text/csv")
      .send(
        encodeDelimited(
          rows,
          [
            "revenue_type",
            "allocation_type",
            "tax_rate",
            "gross",
            "amount",
            "tax_amount",
            "total_gross",
            "difference",
          ],
          ",",
          "\r\n",
          "utf8",
        ),
      );
  });
  return router;
}
