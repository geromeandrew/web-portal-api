import type { Pool, PoolClient } from "pg";
import { AppError } from "./errors.js";

type Queryable = Pool | PoolClient;

export type AppModuleDto = {
  moduleId: string;
  moduleName: string;
  routePath: string;
  accessLevel: "BUSINESS_USER";
};

export async function getEffectiveModules(
  db: Queryable,
  userId: string,
): Promise<AppModuleDto[]> {
  const result = await db.query<AppModuleDto>(
    `SELECT module.module_id AS "moduleId", module.module_name AS "moduleName",
            module.route_path AS "routePath", 'BUSINESS_USER'::text AS "accessLevel"
       FROM app_modules module
       JOIN app_user account ON account.id = $1
      WHERE module.is_active
        AND account.is_active
        AND (account.is_admin OR EXISTS (
          SELECT 1 FROM app_user_modules assignment
           WHERE assignment.user_id = account.id AND assignment.module_id = module.module_id
        ))
      ORDER BY module.display_order, module.module_id`,
    [userId],
  );
  return result.rows as AppModuleDto[];
}

export async function assertModuleAccess(
  db: Queryable,
  userId: string,
  moduleId: string,
) {
  const result = await db.query(
    `SELECT 1
       FROM app_user account
       JOIN app_modules module ON module.module_id = $2
      WHERE account.id = $1 AND account.is_active AND module.is_active
        AND (account.is_admin OR EXISTS (
          SELECT 1 FROM app_user_modules assignment
           WHERE assignment.user_id = account.id AND assignment.module_id = module.module_id
        ))`,
    [userId, moduleId],
  );
  if (!result.rowCount)
    throw new AppError(403, "MODULE_ACCESS_DENIED", "You do not have access to this workspace.");
}

export async function assertAdministrator(db: Queryable, userId: string) {
  const result = await db.query(
    "SELECT 1 FROM app_user WHERE id = $1 AND is_active AND is_admin",
    [userId],
  );
  if (!result.rowCount)
    throw new AppError(403, "ADMIN_REQUIRED", "Administrator permission is required.");
}

export async function auditRbac(
  db: Queryable,
  input: { actorUserId: string; targetUserId?: string; moduleId?: string; action: string; detail?: unknown },
) {
  await db.query(
    `INSERT INTO app_rbac_audit_events (id, actor_user_id, target_user_id, module_id, action, detail)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)`,
    [input.actorUserId, input.targetUserId ?? null, input.moduleId ?? null, input.action, JSON.stringify(input.detail ?? {})],
  );
}
