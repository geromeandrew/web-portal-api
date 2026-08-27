import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { Config } from "../../../config.js";
import { withTransaction } from "../../../db.js";
import { AppError } from "../../../errors.js";
import { signAccessToken, type AccessTokenPayload } from "../../../auth.js";
import type { UserRow } from "../../shared/api/dtos.js";

const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");

const newRefreshToken = () => randomBytes(48).toString("base64url");

export type SessionAuthentication = {
  accessToken: string;
  refreshToken: string;
  user: UserRow;
};

export class SessionService {
  constructor(
    private readonly pool: Pool,
    private readonly config: Config,
  ) {}

  async create(user: UserRow): Promise<SessionAuthentication> {
    const sessionId = randomUUID();
    const refreshToken = newRefreshToken();
    const expiresAt = new Date(
      Date.now() + this.config.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1_000,
    );
    await withTransaction(this.pool, async (client) => {
      await client.query(
        "INSERT INTO auth_sessions (id, user_id, token_version, expires_at) VALUES ($1, $2, $3, $4)",
        [sessionId, user.id, user.token_version, expiresAt],
      );
      await client.query(
        "INSERT INTO auth_refresh_tokens (id, session_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)",
        [randomUUID(), sessionId, hashToken(refreshToken), expiresAt],
      );
    });
    return this.authentication(user, sessionId, refreshToken);
  }

  async refresh(refreshToken: string): Promise<SessionAuthentication> {
    return withTransaction(this.pool, async (client) => {
      const result = await client.query<{
        token_id: string;
        consumed_at: Date | null;
        token_expires_at: Date;
        session_id: string;
        session_expires_at: Date;
        revoked_at: Date | null;
        id: string;
        email: string;
        password_hash: string;
        is_bootstrap_admin: boolean;
        is_active: boolean;
        must_change_password: boolean;
        token_version: number;
        session_token_version: number;
        created_at: Date;
        updated_at: Date;
      }>(
        `SELECT refresh_token.id AS token_id, refresh_token.consumed_at,
          refresh_token.expires_at AS token_expires_at, session.id AS session_id,
          session.expires_at AS session_expires_at, session.revoked_at,
          session.token_version AS session_token_version, user_account.*
         FROM auth_refresh_tokens refresh_token
         JOIN auth_sessions session ON session.id = refresh_token.session_id
         JOIN users user_account ON user_account.id = session.user_id
         WHERE refresh_token.token_hash = $1 FOR UPDATE OF refresh_token, session`,
        [hashToken(refreshToken)],
      );
      const row = result.rows[0];
      const invalid =
        !row ||
        row.consumed_at !== null ||
        row.revoked_at !== null ||
        row.token_expires_at <= new Date() ||
        row.session_expires_at <= new Date() ||
        !row.is_active ||
        row.session_token_version !== row.token_version;
      if (invalid) {
        if (row) {
          await client.query(
            "UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1",
            [row.session_id],
          );
        }
        throw new AppError(
          401,
          "SESSION_REVOKED",
          "Your session is no longer active.",
        );
      }

      const nextRefreshToken = newRefreshToken();
      await client.query(
        "UPDATE auth_refresh_tokens SET consumed_at = now() WHERE id = $1",
        [row.token_id],
      );
      await client.query(
        "INSERT INTO auth_refresh_tokens (id, session_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)",
        [
          randomUUID(),
          row.session_id,
          hashToken(nextRefreshToken),
          row.session_expires_at,
        ],
      );
      return this.authentication(row, row.session_id, nextRefreshToken);
    });
  }

  async revokeCurrent(
    payload: AccessTokenPayload,
    expiresAt: Date,
  ): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      await client.query(
        "UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1 AND user_id = $2",
        [payload.sessionId, payload.sub],
      );
      await client.query(
        "INSERT INTO revoked_access_tokens (token_id, expires_at) VALUES ($1, $2) ON CONFLICT (token_id) DO NOTHING",
        [payload.tokenId, expiresAt],
      );
      await client.query(
        "DELETE FROM revoked_access_tokens WHERE expires_at <= now()",
      );
      await client.query(
        "DELETE FROM auth_refresh_tokens WHERE expires_at <= now()",
      );
      await client.query("DELETE FROM auth_sessions WHERE expires_at <= now()");
    });
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.pool.query(
      "UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, now()) WHERE user_id = $1",
      [userId],
    );
  }

  private authentication(
    user: UserRow,
    sessionId: string,
    refreshToken: string,
  ): SessionAuthentication {
    const tokenId = randomUUID();
    return {
      accessToken: signAccessToken(this.config, {
        sub: user.id,
        email: user.email,
        version: user.token_version,
        sessionId,
        tokenId,
      }),
      refreshToken,
      user,
    };
  }
}
