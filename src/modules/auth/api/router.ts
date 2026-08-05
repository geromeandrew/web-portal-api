import express from "express";
import { z } from "zod";
import type { AppDependencies } from "../../../app/dependencies.js";
import {
  createAuthMiddleware,
  signAccessToken,
  verifyPassword,
  hashPassword,
} from "../../../auth.js";
import { AppError } from "../../../errors.js";
import { ensureWorkspace } from "../../../workspace.js";
import { userDto, type UserRow } from "../../shared/api/dtos.js";

const passwordSchema = z.string().min(12).max(256);

export function createAuthRouter({ pool, config }: AppDependencies) {
  const router = express.Router();
  const authenticate = createAuthMiddleware(pool, config);
  router.post("/login", async (request, response) => {
    const body = z
      .object({ email: z.string().email(), password: z.string().min(1) })
      .parse(request.body);
    const result = await pool.query<UserRow>(
      "SELECT * FROM users WHERE email = $1",
      [body.email.trim().toLowerCase()],
    );
    const user = result.rows[0];
    if (
      !user ||
      !user.is_active ||
      !(await verifyPassword(body.password, user.password_hash))
    )
      throw new AppError(
        401,
        "INVALID_CREDENTIALS",
        "Email or password is incorrect.",
      );
    await ensureWorkspace(pool, user.id);
    response.json({
      accessToken: signAccessToken(config, {
        sub: user.id,
        email: user.email,
        version: user.token_version,
      }),
      user: userDto(user),
    });
  });
  router.post("/logout", authenticate, (_request, response) =>
    response.status(204).end(),
  );
  router.get("/me", authenticate, async (request, response) => {
    const result = await pool.query<UserRow>(
      "SELECT * FROM users WHERE id = $1",
      [request.auth!.userId],
    );
    response.json({ user: userDto(result.rows[0]) });
  });
  router.post("/change-password", authenticate, async (request, response) => {
    const body = z
      .object({
        currentPassword: z.string().min(1),
        newPassword: passwordSchema,
      })
      .parse(request.body);
    const result = await pool.query<UserRow>(
      "SELECT * FROM users WHERE id = $1",
      [request.auth!.userId],
    );
    const user = result.rows[0];
    if (
      !user ||
      !(await verifyPassword(body.currentPassword, user.password_hash))
    )
      throw new AppError(
        400,
        "INVALID_PASSWORD",
        "Your current password is incorrect.",
      );
    await pool.query(
      "UPDATE users SET password_hash = $1, must_change_password = false, token_version = token_version + 1, updated_at = now() WHERE id = $2",
      [await hashPassword(body.newPassword), user.id],
    );
    const refreshed = await pool.query<UserRow>(
      "SELECT * FROM users WHERE id = $1",
      [user.id],
    );
    const next = refreshed.rows[0];
    response.json({
      accessToken: signAccessToken(config, {
        sub: next.id,
        email: next.email,
        version: next.token_version,
      }),
      user: userDto(next),
    });
  });
  return router;
}
