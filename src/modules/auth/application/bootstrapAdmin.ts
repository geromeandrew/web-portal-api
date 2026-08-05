import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { Config } from "../../../config.js";
import { hashPassword } from "../../../auth.js";
import type { UserRow } from "../../shared/api/dtos.js";

export async function ensureBootstrapAdmin(pool: Pool, config: Config) {
  const email = config.ADMIN_EMAIL.trim().toLowerCase();
  const passwordHash = await hashPassword(config.ADMIN_PASSWORD);
  const created = await pool.query<UserRow>(
    "INSERT INTO users (id, email, password_hash, is_bootstrap_admin) VALUES ($1, $2, $3, true) ON CONFLICT (email) DO NOTHING RETURNING *",
    [randomUUID(), email, passwordHash],
  );
  return created.rows[0] ?? null;
}
