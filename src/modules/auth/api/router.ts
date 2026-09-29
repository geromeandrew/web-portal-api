import express from "express";
import type { AppDependencies } from "../../../app/dependencies.js";
import { getEffectiveModules } from "../../../rbac.js";

export function createAuthRouter({ authenticate, pool }: AppDependencies) {
  const router = express.Router();
  router.get("/me", authenticate, async (request, response) => {
    response.json({
      user: {
        id: request.auth!.userId,
        email: request.auth!.email,
        displayName: request.auth!.displayName,
        createdAt: request.auth!.createdAt.toISOString(),
        isAdmin: request.auth!.isAdmin,
        modules: await getEffectiveModules(pool, request.auth!.userId),
      },
    });
  });
  return router;
}
