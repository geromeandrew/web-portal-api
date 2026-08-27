import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { RequestHandler } from "express";
import type { Pool } from "pg";
import type { Config } from "./config.js";
import { AppError } from "./errors.js";

export type AccessTokenPayload = {
  sub: string;
  email: string;
  version: number;
  sessionId: string;
  tokenId: string;
};

export async function hashPassword(password: string) {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string) {
  return bcrypt.compare(password, hash);
}

export function signAccessToken(config: Config, payload: AccessTokenPayload) {
  return jwt.sign(payload, config.JWT_SECRET, {
    expiresIn: config.JWT_EXPIRES_IN,
    algorithm: "HS256",
  } as jwt.SignOptions);
}

export function createAuthMiddleware(
  pool: Pool,
  config: Config,
): RequestHandler {
  return async (request, _response, next) => {
    try {
      const authorization = request.header("authorization");
      if (!authorization?.startsWith("Bearer "))
        throw new AppError(401, "UNAUTHENTICATED", "Sign in is required.");
      const token = authorization.slice(7);
      const payload = jwt.verify(token, config.JWT_SECRET, {
        algorithms: ["HS256"],
      }) as jwt.JwtPayload & AccessTokenPayload;
      if (
        !payload.sub ||
        typeof payload.version !== "number" ||
        !payload.sessionId ||
        !payload.tokenId ||
        typeof payload.exp !== "number"
      )
        throw new AppError(401, "UNAUTHENTICATED", "Your session is invalid.");
      const result = await pool.query<{
        id: string;
        email: string;
        is_bootstrap_admin: boolean;
        is_active: boolean;
        must_change_password: boolean;
        token_version: number;
      }>(
        `SELECT user_account.id, user_account.email, user_account.is_bootstrap_admin,
          user_account.is_active, user_account.must_change_password, user_account.token_version
         FROM users user_account
         JOIN auth_sessions session ON session.id = $2
           AND session.user_id = user_account.id
           AND session.revoked_at IS NULL
           AND session.expires_at > now()
           AND session.token_version = user_account.token_version
         WHERE user_account.id = $1
           AND NOT EXISTS (
             SELECT 1 FROM revoked_access_tokens revoked
             WHERE revoked.token_id = $3 AND revoked.expires_at > now()
           )`,
        [payload.sub, payload.sessionId, payload.tokenId],
      );
      const user = result.rows[0];
      if (!user || !user.is_active || user.token_version !== payload.version)
        throw new AppError(
          401,
          "SESSION_REVOKED",
          "Your session is no longer active.",
        );
      request.auth = {
        userId: user.id,
        email: user.email,
        isBootstrapAdmin: user.is_bootstrap_admin,
        mustChangePassword: user.must_change_password,
        sessionId: payload.sessionId,
        tokenId: payload.tokenId,
        tokenExpiresAt: new Date(payload.exp * 1_000),
      };
      next();
    } catch (error) {
      next(
        error instanceof AppError
          ? error
          : new AppError(
              401,
              "UNAUTHENTICATED",
              "Your session is invalid or expired.",
            ),
      );
    }
  };
}

export const requireBootstrapAdmin: RequestHandler = (
  request,
  _response,
  next,
) => {
  if (!request.auth?.isBootstrapAdmin)
    return next(
      new AppError(
        403,
        "FORBIDDEN",
        "Only the bootstrap administrator can manage users.",
      ),
    );
  next();
};
