import express, { type RequestHandler } from "express";
import type { AppDependencies } from "../../../app/dependencies.js";
import { createAuthMiddleware } from "../../../auth.js";
import { UploadService } from "../application/uploadService.js";
import { createUploadsController } from "./controller.js";

export function createUploadsRouter(
  { pool, config, logger }: AppDependencies,
  singleFile: RequestHandler,
) {
  const router = express.Router();
  router.use(createAuthMiddleware(pool, config));
  const controller = createUploadsController(
    new UploadService(pool, config, logger),
  );
  router.post("/", singleFile, controller.create);
  router.delete("/:id", controller.remove);
  return router;
}
