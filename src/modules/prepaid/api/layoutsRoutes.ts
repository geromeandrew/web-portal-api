import { z } from "zod";
import {
  commandSchema,
  editSchema,
  regionSchema,
} from "../domain/contracts.js";
import type { Router } from "express";
import type { PrepaidRouteContext } from "./routeContext.js";
import { uuid, page } from "./requestSchemas.js";
export function registerPrepaidLayoutsRoutes(
  router: Router,
  context: Pick<PrepaidRouteContext, "service">,
) {
  const { service } = context;
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
}
