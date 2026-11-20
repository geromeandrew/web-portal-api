import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { AppError } from "../../../errors.js";
import { frozenReports } from "../application/reportService.js";
import { regionSchema, encodeDelimited } from "../domain/contracts.js";
import type { Router } from "express";
import type { PrepaidRouteContext } from "./routeContext.js";
import { uuid, page } from "./requestSchemas.js";
export function registerPrepaidReportsRoutes(
  router: Router,
  context: Pick<PrepaidRouteContext, "service" | "workspace">,
) {
  const { service } = context;
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
        !!context.workspace.fullBatch,
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
      const rows = await service.repo.reconciliationCsvRows(output.revisionId);
      res
        .attachment(`prepaid-${region}-reconciliation.csv`)
        .type("text/csv")
        .send(encodeDelimited(rows, fields, ",", "\r\n", "utf8"));
    },
  );
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
}
