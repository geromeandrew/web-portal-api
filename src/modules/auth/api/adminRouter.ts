import { randomUUID } from "node:crypto";
import express from "express";
import { z } from "zod";
import type { AppDependencies } from "../../../app/dependencies.js";
import { AppError } from "../../../errors.js";
import { assertAdministrator, auditRbac } from "../../../rbac.js";

const userIdSchema = z.string().uuid();
const moduleIdSchema = z.string().min(1).max(100);
const createUserSchema = z.object({
  email: z.string().email().max(200),
  firstName: z.string().trim().max(200).nullable().optional(),
  lastName: z.string().trim().max(200).nullable().optional(),
  isActive: z.boolean().default(true),
  isAdmin: z.boolean().default(false),
});
const updateUserSchema = createUserSchema.omit({ email: true }).partial();

export function createAdminRouter({ pool, authenticate }: AppDependencies) {
  const router = express.Router();
  router.use(authenticate);
  router.use(async (request, _response, next) => {
    try { await assertAdministrator(pool, request.auth!.userId); next(); } catch (error) { next(error); }
  });

  router.get("/modules", async (_request, response) => {
    const result = await pool.query(
      `SELECT module_id AS "moduleId", module_name AS "moduleName", route_path AS "routePath", is_active AS "isActive"
         FROM app_modules ORDER BY display_order, module_id`,
    );
    response.json({ modules: result.rows });
  });

  router.get("/users", async (request, response) => {
    const query = z.string().trim().max(200).optional().parse(request.query.q);
    const result = await pool.query(
      `SELECT account.id, account.email, account.first_name AS "firstName", account.last_name AS "lastName",
              account.display_name AS "displayName", account.is_active AS "isActive", account.is_admin AS "isAdmin",
              account.last_login_at AS "lastLoginAt", COALESCE(json_agg(assignment.module_id ORDER BY assignment.module_id)
                FILTER (WHERE assignment.module_id IS NOT NULL), '[]'::json) AS "moduleIds"
         FROM app_user account LEFT JOIN app_user_modules assignment ON assignment.user_id = account.id
        WHERE ($1::text IS NULL OR account.email ILIKE '%' || $1 || '%' OR account.first_name ILIKE '%' || $1 || '%' OR account.last_name ILIKE '%' || $1 || '%')
        GROUP BY account.id ORDER BY account.email LIMIT 200`,
      [query ?? null],
    );
    response.json({ users: result.rows });
  });

  router.post("/users", async (request, response) => {
    const body = createUserSchema.parse(request.body);
    const email = body.email.toLowerCase();
    const displayName = [body.firstName, body.lastName].filter(Boolean).join(" ") || null;
    const created = await pool.query(
      `INSERT INTO app_user (id, email, first_name, last_name, display_name, is_active, is_admin, created_by_user_id, updated_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8) RETURNING id, email`,
      [randomUUID(), email, body.firstName ?? null, body.lastName ?? null, displayName, body.isActive, body.isAdmin, request.auth!.userId],
    ).catch((error: { code?: string }) => {
      if (error.code === "23505") throw new AppError(409, "EMAIL_EXISTS", "An account with that email already exists.");
      throw error;
    });
    await auditRbac(pool, { actorUserId: request.auth!.userId, targetUserId: created.rows[0].id, action: "user.created" });
    response.status(201).json({ user: created.rows[0] });
  });

  router.patch("/users/:userId", async (request, response) => {
    const userId = userIdSchema.parse(request.params.userId);
    const body = updateUserSchema.parse(request.body);
    if (userId === request.auth!.userId && (body.isAdmin === false || body.isActive === false))
      throw new AppError(409, "SELF_ADMIN_CHANGE_DENIED", "You cannot deactivate yourself or remove your own administrator access.");
    if (body.isAdmin === false || body.isActive === false) {
      const target = await pool.query<{ is_admin: boolean }>("SELECT is_admin FROM app_user WHERE id = $1", [userId]);
      if (target.rows[0]?.is_admin) {
        const admins = await pool.query("SELECT 1 FROM app_user WHERE is_active AND is_admin");
        if ((admins.rowCount ?? 0) <= 1) throw new AppError(409, "LAST_ADMIN_DENIED", "At least one active administrator is required.");
      }
    }
    const updated = await pool.query(
      `UPDATE app_user SET first_name = COALESCE($1, first_name), last_name = COALESCE($2, last_name),
         is_active = COALESCE($3, is_active), is_admin = COALESCE($4, is_admin), updated_by_user_id = $5, updated_at = now()
       WHERE id = $6 RETURNING id, email, first_name AS "firstName", last_name AS "lastName", is_active AS "isActive", is_admin AS "isAdmin"`,
      [body.firstName, body.lastName, body.isActive, body.isAdmin, request.auth!.userId, userId],
    );
    if (!updated.rowCount) throw new AppError(404, "USER_NOT_FOUND", "The account was not found.");
    await auditRbac(pool, { actorUserId: request.auth!.userId, targetUserId: userId, action: "user.updated", detail: body });
    response.json({ user: updated.rows[0] });
  });

  router.put("/users/:userId/modules/:moduleId", async (request, response) => {
    const userId = userIdSchema.parse(request.params.userId); const moduleId = moduleIdSchema.parse(request.params.moduleId);
    await pool.query(`INSERT INTO app_user_modules (user_id, module_id, assigned_by_user_id) VALUES ($1, $2, $3) ON CONFLICT (user_id, module_id) DO NOTHING`, [userId, moduleId, request.auth!.userId]);
    await auditRbac(pool, { actorUserId: request.auth!.userId, targetUserId: userId, moduleId, action: "module.assigned" });
    response.status(204).end();
  });
  router.delete("/users/:userId/modules/:moduleId", async (request, response) => {
    const userId = userIdSchema.parse(request.params.userId); const moduleId = moduleIdSchema.parse(request.params.moduleId);
    await pool.query("DELETE FROM app_user_modules WHERE user_id = $1 AND module_id = $2", [userId, moduleId]);
    await auditRbac(pool, { actorUserId: request.auth!.userId, targetUserId: userId, moduleId, action: "module.removed" });
    response.status(204).end();
  });
  return router;
}
