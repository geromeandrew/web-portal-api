import express from "express";
import type { AppDependencies } from "../../../app/dependencies.js";
import { createAuthMiddleware } from "../../../auth.js";
import { MemoService } from "../application/memoService.js";
import { createMemoController } from "./controller.js";
export function createMemoRouter({ pool, config }: AppDependencies) {
  const router = express.Router();
  router.use(createAuthMiddleware(pool, config));
  const controller = createMemoController(new MemoService(pool));
  router.get("/state", controller.getState);
  router.get("/errors.csv", controller.downloadErrors);
  return router;
}
