import { z } from "zod";
import { AppError } from "../../../errors.js";
import { periodSchema, sourceCodeSchema } from "../domain/contracts.js";
import type { Router } from "express";
import type { PrepaidRouteContext } from "./routeContext.js";
import { uuid } from "./requestSchemas.js";
export function registerPrepaidRunsRoutes(
  router: Router,
  context: Pick<PrepaidRouteContext, "pool" | "service" | "upload">,
) {
  const { pool, service, upload } = context;
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
}
