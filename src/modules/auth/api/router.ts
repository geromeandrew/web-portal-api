import express from "express";
import type { AppDependencies } from "../../../app/dependencies.js";
import { createAuthMiddleware } from "../../../auth.js";
import { AuthService } from "../application/authService.js";
import { createAuthController } from "./controller.js";

export function createAuthRouter({ pool, config }: AppDependencies) {
  const router = express.Router();
  const authenticate = createAuthMiddleware(pool, config);
  const controller = createAuthController(new AuthService(pool, config));
  router.post("/login", controller.login);
  router.post("/logout", authenticate, controller.logout);
  router.get("/me", authenticate, controller.me);
  router.post("/change-password", authenticate, controller.changePassword);
  return router;
}
