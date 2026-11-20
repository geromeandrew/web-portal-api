import { z } from "zod";
import { assertAdministrator } from "../../../rbac.js";
import { AppError } from "../../../errors.js";
import { manualIntegrationSchema } from "../domain/contracts.js";
import type { Router } from "express";
import type { PrepaidRouteContext } from "./routeContext.js";
import { uuid } from "./requestSchemas.js";
export function registerPrepaidConfigurationRoutes(
  router: Router,
  context: Pick<
    PrepaidRouteContext,
    "pool" | "service" | "references" | "catalog" | "upload"
  >,
) {
  const { pool, service, references, catalog, upload } = context;
  router.get("/integration", async (_req, res) => {
    res.json(await service.integration());
  });
  router.use("/reference-versions", async (req, _res, next) => {
    await assertAdministrator(pool, req.auth!.userId);
    next();
  });
  router.get("/reference-versions", async (req, res) => {
    res.json({ versions: await catalog.list(req.auth!.userId) });
  });
  router.post("/reference-versions", upload, async (req, res) => {
    if (!req.file)
      throw new AppError(
        400,
        "PREPAID_REFERENCE_FILE_REQUIRED",
        "Attach the approved reference JSONL as multipart field 'file', with JSON metadata in field 'metadata'.",
      );
    let metadata: unknown;
    try {
      metadata = JSON.parse(req.body?.metadata ?? "");
    } catch {
      throw new AppError(
        400,
        "PREPAID_REFERENCE_METADATA_REQUIRED",
        "Supply valid JSON reference approval metadata.",
      );
    }
    res
      .status(201)
      .json(await catalog.import(req.auth!.userId, req.file.buffer, metadata));
  });
  router.get("/reference-versions/:checksum/file", async (req, res) => {
    const bytes = await catalog.export(
      req.auth!.userId,
      String(req.params.checksum),
    );
    res
      .attachment(`ztf0455s-${req.params.checksum}.jsonl`)
      .type("application/x-ndjson")
      .send(bytes);
  });
  router.put("/integration", async (req, res) => {
    res.json(
      await service.configure(
        req.auth!.userId,
        manualIntegrationSchema.parse(req.body),
      ),
    );
  });
  router.post("/reference-exports", async (req, res) => {
    res.status(202).json(await references.create(req.auth!.userId, req.body));
  });
  router.get("/reference-exports/:referenceId", async (req, res) => {
    res.json(
      await references.get(
        req.auth!.userId,
        uuid.parse(req.params.referenceId),
      ),
    );
  });
  router.post("/reference-exports/:referenceId/reconcile", async (req, res) => {
    z.object({})
      .strict()
      .parse(req.body ?? {});
    res
      .status(202)
      .json(
        await references.reconcile(
          req.auth!.userId,
          uuid.parse(req.params.referenceId),
        ),
      );
  });
}
