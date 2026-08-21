import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { hashPassword } from "../../../auth.js";
import { AppError } from "../../../errors.js";
import { ensureWorkspace } from "../../../workspace.js";
import { userDto, type UserRow } from "../../shared/api/dtos.js";

export class UserService {
  constructor(private readonly pool: Pool) {}

  async list() {
    const users = await this.pool.query<UserRow>(
      "SELECT * FROM users ORDER BY created_at DESC",
    );
    return users.rows.map(userDto);
  }

  async create(emailInput: string, temporaryPassword: string) {
    const email = emailInput.trim().toLowerCase();
    const duplicate = await this.pool.query(
      "SELECT 1 FROM users WHERE email = $1",
      [email],
    );
    if (duplicate.rowCount) {
      throw new AppError(
        409,
        "EMAIL_EXISTS",
        "An account with this email already exists.",
      );
    }

    const id = randomUUID();
    await this.pool.query(
      "INSERT INTO users (id, email, password_hash, must_change_password) VALUES ($1, $2, $3, true)",
      [id, email, await hashPassword(temporaryPassword)],
    );
    await ensureWorkspace(this.pool, id);
    return userDto(await this.findRequired(id));
  }

  async update(
    id: string,
    actorId: string,
    input: { isActive?: boolean; temporaryPassword?: string },
  ) {
    if (id === actorId && input.isActive === false) {
      throw new AppError(
        400,
        "SELF_DEACTIVATION",
        "You cannot deactivate your own account.",
      );
    }

    const user = await this.findRequired(id);
    await this.pool.query(
      "UPDATE users SET is_active = COALESCE($1, is_active), password_hash = COALESCE($2, password_hash), must_change_password = CASE WHEN $2 IS NULL THEN must_change_password ELSE true END, token_version = token_version + 1, updated_at = now() WHERE id = $3",
      [
        input.isActive,
        input.temporaryPassword
          ? await hashPassword(input.temporaryPassword)
          : null,
        user.id,
      ],
    );
    return userDto(await this.findRequired(user.id));
  }

  private async findRequired(id: string) {
    const result = await this.pool.query<UserRow>(
      "SELECT * FROM users WHERE id = $1",
      [id],
    );
    const user = result.rows[0];
    if (!user) throw new AppError(404, "USER_NOT_FOUND", "User not found.");
    return user;
  }
}
