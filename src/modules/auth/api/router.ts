import express from "express";
import type { AppDependencies } from "../../../app/dependencies.js";
import { createAuthMiddleware } from "../../../auth.js";
import { AuthService } from "../application/authService.js";
import { createAuthController } from "./controller.js";
import {
  clientIpKey,
  createRateLimitMiddleware,
  loginAccountPolicy,
  loginIpPolicy,
  refreshPolicy,
} from "../../../app/security.js";

export function createAuthRouter({
  pool,
  config,
  rateLimiter,
}: AppDependencies) {
  const router = express.Router();
  const authenticate = createAuthMiddleware(pool, config);
  const controller = createAuthController(
    new AuthService(pool, config),
    config,
  );
  const loginAccountKey = (request: express.Request) => {
    const email =
      request.body &&
      typeof request.body === "object" &&
      typeof request.body.email === "string"
        ? request.body.email.trim().toLowerCase()
        : "invalid-email";
    return `${request.ip}:${email}`;
  };
  router.post(
    "/login",
    createRateLimitMiddleware(rateLimiter, loginIpPolicy, clientIpKey),
    createRateLimitMiddleware(rateLimiter, loginAccountPolicy, loginAccountKey),
    controller.login,
  );
  router.post(
    "/refresh",
    createRateLimitMiddleware(rateLimiter, refreshPolicy, clientIpKey),
    controller.refresh,
  );
  router.post("/logout", authenticate, controller.logout);
  router.get("/me", authenticate, controller.me);
  router.post("/change-password", authenticate, controller.changePassword);
  return router;
}
