import { z } from "zod";
import { AppError } from "../../../errors.js";
import { sourceCodeSchema } from "../domain/contracts.js";
import type { Router } from "express";
import type { PrepaidRouteContext } from "./routeContext.js";
import { uuid } from "./requestSchemas.js";
export function registerPrepaidWorkspaceRoutes(
  router: Router,
  context: Pick<PrepaidRouteContext, "workspace" | "upload">,
) {
  const { workspace, upload } = context;
  router.get("/workspace", async (req, res) => {
    const userId = req.auth!.userId;
    const [state, batch] = await Promise.all([
      workspace.state(userId),
      workspace.fullBatch?.status(userId),
    ]);
    res.json(
      workspace.fullBatch
        ? {
            ...state,
            error: state.error?.replace(/^AWS batch is waiting:/, "Import is waiting:") ?? null,
            awsBatchEnabled: true,
            awsBatch: batch,
            awsBatchActive: !!batch && batch.status !== "closed",
            awsBatchResetAllowed: batch?.canClose === true,
            awsBatchReviewReady: batch?.canReview === true,
          }
        : state,
    );
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
          z.string().uuid().optional().parse(req.body?.uploadId),
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
}
