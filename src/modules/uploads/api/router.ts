import express, { type RequestHandler } from "express";
import type { AppDependencies } from "../../../app/dependencies.js";
import { UploadService } from "../application/uploadService.js";
import { createUploadsController } from "./controller.js";

export function createUploadsRouter(
  { pool, config, logger, authenticate }: AppDependencies,
  singleFile: RequestHandler,
) {
  const router = express.Router();
  router.use(authenticate);
  const controller = createUploadsController(
    new UploadService(pool, config, logger),
  );
  router.post("/", singleFile, controller.create);
  router.delete("/:id", controller.remove);
  return router;
}
