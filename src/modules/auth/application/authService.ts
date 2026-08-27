import type { Pool } from "pg";
import type { Config } from "../../../config.js";
import { AppError } from "../../../errors.js";
import { hashPassword, verifyPassword } from "../../../auth.js";
import { SessionService } from "./sessionService.js";
import { ensureWorkspace } from "../../../workspace.js";
import { userDto, type UserRow } from "../../shared/api/dtos.js";

export type AuthenticatedUser = {
  accessToken: string;
  refreshToken: string;
  user: ReturnType<typeof userDto>;
};

export class AuthService {
  constructor(
    private readonly pool: Pool,
    private readonly config: Config,
  ) {}

  async login(email: string, password: string): Promise<AuthenticatedUser> {
    const user = await this.findByEmail(email);
    if (
      !user ||
      !user.is_active ||
      !(await verifyPassword(password, user.password_hash))
    ) {
      throw new AppError(
        401,
        "INVALID_CREDENTIALS",
        "Email or password is incorrect.",
      );
    }

    await ensureWorkspace(this.pool, user.id);
    return this.createAuthenticatedUser(user);
  }

  async getCurrentUser(userId: string) {
    return userDto(await this.findRequiredById(userId));
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<AuthenticatedUser> {
    const user = await this.findById(userId);
    if (!user || !(await verifyPassword(currentPassword, user.password_hash))) {
      throw new AppError(
        400,
        "INVALID_PASSWORD",
        "Your current password is incorrect.",
      );
    }

    await this.pool.query(
      "UPDATE users SET password_hash = $1, must_change_password = false, token_version = token_version + 1, updated_at = now() WHERE id = $2",
      [await hashPassword(newPassword), user.id],
    );
    await this.sessions.revokeAllForUser(user.id);
    return this.createAuthenticatedUser(await this.findRequiredById(user.id));
  }

  async refresh(refreshToken: string): Promise<AuthenticatedUser> {
    const session = await this.sessions.refresh(refreshToken);
    return {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      user: userDto(session.user),
    };
  }

  async logout(auth: NonNullable<Express.Request["auth"]>) {
    await this.sessions.revokeCurrent(
      {
        sub: auth.userId,
        email: auth.email,
        version: 0,
        sessionId: auth.sessionId,
        tokenId: auth.tokenId,
      },
      auth.tokenExpiresAt,
    );
  }

  private async findByEmail(email: string) {
    const result = await this.pool.query<UserRow>(
      "SELECT * FROM users WHERE email = $1",
      [email.trim().toLowerCase()],
    );
    return result.rows[0];
  }

  private async findById(id: string) {
    const result = await this.pool.query<UserRow>(
      "SELECT * FROM users WHERE id = $1",
      [id],
    );
    return result.rows[0];
  }

  private async findRequiredById(id: string) {
    const user = await this.findById(id);
    if (!user) throw new AppError(404, "USER_NOT_FOUND", "User not found.");
    return user;
  }

  private async createAuthenticatedUser(
    user: UserRow,
  ): Promise<AuthenticatedUser> {
    const session = await this.sessions.create(user);
    return {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      user: userDto(session.user),
    };
  }

  private get sessions() {
    return new SessionService(this.pool, this.config);
  }
}
