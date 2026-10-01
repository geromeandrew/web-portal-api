import express from "express";
import type { AppDependencies } from "../../../app/dependencies.js";
import { PrepaidService } from "../application/prepaidService.js";
import { createPrepaidController } from "./controller.js";
import { assertModuleAccess } from "../../../rbac.js";

export function createPrepaidRouter({
  pool,
  authenticate,
  processingPipelineStorage,
}: AppDependencies) {
  const router = express.Router();
  router.use(authenticate);
  router.use(async (request, _response, next) => {
    try {
      await assertModuleAccess(pool, request.auth!.userId, "prepaid_reclass");
      next();
    } catch (error) {
      next(error);
    }
  });

  const controller = createPrepaidController(
    new PrepaidService(pool, processingPipelineStorage),
  );
  router.get("/state", controller.getState);
  router.get("/history", controller.getHistory);
  router.delete("/uploads", controller.clearUploads);
  router.post("/process", controller.process);
  router.post("/layouts/:region/reset", controller.resetLayout);
  router.post("/layouts/:region/import", controller.importLayout);
  router.patch("/layouts/:region/freeze", controller.freezeLayout);
  router.post("/allocation/validate", controller.validateAllocation);
  router.get("/report.csv", controller.downloadReport);
  return router;
}
