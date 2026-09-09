import express from "express";
import type { AppDependencies } from "../../../app/dependencies.js";

export function createAuthRouter({ authenticate }: AppDependencies) {
  const router = express.Router();
  router.get("/me", authenticate, (request, response) => {
    response.json({
      user: {
        id: request.auth!.userId,
        email: request.auth!.email,
        displayName: request.auth!.displayName,
        createdAt: request.auth!.createdAt.toISOString(),
      },
    });
  });
  return router;
}
