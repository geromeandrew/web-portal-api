import express from "express";
import type { AppDependencies } from "../../../app/dependencies.js";
import { createAuthMiddleware } from "../../../auth.js";
import { PrepaidService } from "../application/prepaidService.js";
import { createPrepaidController } from "./controller.js";

export function createPrepaidRouter({ pool, config }: AppDependencies) {
  const router = express.Router();
  router.use(createAuthMiddleware(pool, config));

  const controller = createPrepaidController(new PrepaidService(pool));
  router.get("/state", controller.getState);
  router.post("/process", controller.process);
  router.post("/layouts/:region/reset", controller.resetLayout);
  router.post("/layouts/:region/import", controller.importLayout);
  router.patch("/layouts/:region/freeze", controller.freezeLayout);
  router.post("/allocation/validate", controller.validateAllocation);
  router.get("/report.csv", controller.downloadReport);
  return router;
}
