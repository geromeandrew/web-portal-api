import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { RequestHandler } from "express";
import type { Pool } from "pg";
import type { Config } from "./config.js";
import { AppError } from "./errors.js";

type TokenPayload = { sub: string; email: string; version: number };

export async function hashPassword(password: string) {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string) {
  return bcrypt.compare(password, hash);
}

export function signAccessToken(config: Config, payload: TokenPayload) {
  return jwt.sign(payload, config.JWT_SECRET, { expiresIn: config.JWT_EXPIRES_IN } as jwt.SignOptions);
}

export function createAuthMiddleware(pool: Pool, config: Config): RequestHandler {
  return async (request, _response, next) => {
    try {
      const authorization = request.header("authorization");
      if (!authorization?.startsWith("Bearer ")) throw new AppError(401, "UNAUTHENTICATED", "Sign in is required.");
      const token = authorization.slice(7);
      const payload = jwt.verify(token, config.JWT_SECRET) as jwt.JwtPayload & TokenPayload;
      if (!payload.sub || typeof payload.version !== "number") throw new AppError(401, "UNAUTHENTICATED", "Your session is invalid.");
      const result = await pool.query<{
        id: string; email: string; is_bootstrap_admin: boolean; is_active: boolean; must_change_password: boolean; token_version: number;
      }>("SELECT id, email, is_bootstrap_admin, is_active, must_change_password, token_version FROM users WHERE id = $1", [payload.sub]);
      const user = result.rows[0];
      if (!user || !user.is_active || user.token_version !== payload.version) throw new AppError(401, "SESSION_REVOKED", "Your session is no longer active.");
      request.auth = { userId: user.id, email: user.email, isBootstrapAdmin: user.is_bootstrap_admin, mustChangePassword: user.must_change_password };
      next();
    } catch (error) {
      next(error instanceof AppError ? error : new AppError(401, "UNAUTHENTICATED", "Your session is invalid or expired."));
    }
  };
}

export const requireBootstrapAdmin: RequestHandler = (request, _response, next) => {
  if (!request.auth?.isBootstrapAdmin) return next(new AppError(403, "FORBIDDEN", "Only the bootstrap administrator can manage users."));
  next();
};
