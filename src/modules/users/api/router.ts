import { randomUUID } from "node:crypto";
import express from "express";
import { z } from "zod";
import type { AppDependencies } from "../../../app/dependencies.js";
import {
  createAuthMiddleware,
  hashPassword,
  requireBootstrapAdmin,
} from "../../../auth.js";
import { AppError } from "../../../errors.js";
import { ensureWorkspace } from "../../../workspace.js";
import { userDto, type UserRow } from "../../shared/api/dtos.js";

const passwordSchema = z.string().min(12).max(256);
export function createUsersRouter({ pool, config }: AppDependencies) {
  const router = express.Router();
  router.use(createAuthMiddleware(pool, config), requireBootstrapAdmin);
  router.get("/", async (_request, response) => {
    const users = await pool.query<UserRow>(
      "SELECT * FROM users ORDER BY created_at DESC",
    );
    response.json({ users: users.rows.map(userDto) });
  });
  router.post("/", async (request, response) => {
    const body = z
      .object({ email: z.string().email(), temporaryPassword: passwordSchema })
      .parse(request.body);
    const email = body.email.trim().toLowerCase();
    const duplicate = await pool.query("SELECT 1 FROM users WHERE email = $1", [
      email,
    ]);
    if (duplicate.rowCount)
      throw new AppError(
        409,
        "EMAIL_EXISTS",
        "An account with this email already exists.",
      );
    const id = randomUUID();
    await pool.query(
      "INSERT INTO users (id, email, password_hash, must_change_password) VALUES ($1, $2, $3, true)",
      [id, email, await hashPassword(body.temporaryPassword)],
    );
    await ensureWorkspace(pool, id);
    const created = await pool.query<UserRow>(
      "SELECT * FROM users WHERE id = $1",
      [id],
    );
    response.status(201).json({ user: userDto(created.rows[0]) });
  });
  router.patch("/:id", async (request, response) => {
    const body = z
      .object({
        isActive: z.boolean().optional(),
        temporaryPassword: passwordSchema.optional(),
      })
      .refine(
        (value) =>
          value.isActive !== undefined || value.temporaryPassword !== undefined,
      )
      .parse(request.body);
    if (request.params.id === request.auth!.userId && body.isActive === false)
      throw new AppError(
        400,
        "SELF_DEACTIVATION",
        "You cannot deactivate your own account.",
      );
    const result = await pool.query<UserRow>(
      "SELECT * FROM users WHERE id = $1",
      [request.params.id],
    );
    const user = result.rows[0];
    if (!user) throw new AppError(404, "USER_NOT_FOUND", "User not found.");
    await pool.query(
      "UPDATE users SET is_active = COALESCE($1, is_active), password_hash = COALESCE($2, password_hash), must_change_password = CASE WHEN $2 IS NULL THEN must_change_password ELSE true END, token_version = token_version + 1, updated_at = now() WHERE id = $3",
      [
        body.isActive,
        body.temporaryPassword
          ? await hashPassword(body.temporaryPassword)
          : null,
        user.id,
      ],
    );
    const updated = await pool.query<UserRow>(
      "SELECT * FROM users WHERE id = $1",
      [user.id],
    );
    response.json({ user: userDto(updated.rows[0]) });
  });
  return router;
}
