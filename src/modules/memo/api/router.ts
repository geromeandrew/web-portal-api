import express from "express";
import type { AppDependencies } from "../../../app/dependencies.js";
import { MemoService } from "../application/memoService.js";
import { createMemoController } from "./controller.js";
export function createMemoRouter({ pool, authenticate }: AppDependencies) {
  const router = express.Router();
  router.use(authenticate);
  const controller = createMemoController(new MemoService(pool));
  router.get("/state", controller.getState);
  router.get("/errors.csv", controller.downloadErrors);
  return router;
}
