import express from "express";
import type { AppDependencies } from "../../../app/dependencies.js";
import { createAuthMiddleware, requireBootstrapAdmin } from "../../../auth.js";
import { UserService } from "../application/userService.js";
import { createUsersController } from "./controller.js";
export function createUsersRouter({ pool, config }: AppDependencies) {
  const router = express.Router();
  router.use(createAuthMiddleware(pool, config), requireBootstrapAdmin);
  const controller = createUsersController(new UserService(pool));
  router.get("/", controller.list);
  router.post("/", controller.create);
  router.patch("/:id", controller.update);
  return router;
}
