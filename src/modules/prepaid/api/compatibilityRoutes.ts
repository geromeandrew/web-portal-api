import { z } from "zod";
import { AppError } from "../../../errors.js";
import {
  commandSchema,
  regionSchema,
  encodeDelimited,
} from "../domain/contracts.js";
import type { Router } from "express";
import type { PrepaidRouteContext } from "./routeContext.js";

export function registerPrepaidCompatibilityRoutes(
  router: Router,
  context: Pick<PrepaidRouteContext, "pool" | "service">,
) {
  const { pool, service } = context;
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
}
