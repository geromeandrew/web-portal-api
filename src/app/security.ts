import { createHmac } from "node:crypto";
import type { RequestHandler } from "express";
import type { Pool } from "pg";
import type { Config } from "../config.js";

type RateLimitPolicy = {
  scope: string;
  limit: number;
  windowSeconds: number;
};

const publicApiPolicy: RateLimitPolicy = {
  scope: "public-api",
  limit: 120,
  windowSeconds: 60,
};

export const loginIpPolicy: RateLimitPolicy = {
  scope: "login-ip",
  limit: 50,
  windowSeconds: 15 * 60,
};

export const loginAccountPolicy: RateLimitPolicy = {
  scope: "login-account",
  limit: 5,
  windowSeconds: 15 * 60,
};

export const refreshPolicy: RateLimitPolicy = {
  scope: "refresh",
  limit: 30,
  windowSeconds: 60,
};

type RateLimitResult = { allowed: boolean; remaining: number; resetAt: Date };

export class PostgresRateLimiter {
  constructor(
    private readonly pool: Pool,
    private readonly config: Config,
  ) {}

  async consume(
    policy: RateLimitPolicy,
    value: string,
  ): Promise<RateLimitResult> {
    const key = createHmac("sha256", this.config.RATE_LIMIT_HMAC_SECRET)
      .update(`${policy.scope}:${value}`)
      .digest("hex");
    const result = await this.pool.query<{
      request_count: number;
      expires_at: Date;
    }>(
      `INSERT INTO rate_limit_buckets (scope, key_hash, request_count, expires_at)
       VALUES ($1, $2, 1, now() + ($3 * interval '1 second'))
       ON CONFLICT (scope, key_hash) DO UPDATE
       SET request_count = CASE
             WHEN rate_limit_buckets.expires_at <= now() THEN 1
             ELSE rate_limit_buckets.request_count + 1
           END,
           expires_at = CASE
             WHEN rate_limit_buckets.expires_at <= now()
               THEN now() + ($3 * interval '1 second')
             ELSE rate_limit_buckets.expires_at
           END
       RETURNING request_count, expires_at`,
      [policy.scope, key, policy.windowSeconds],
    );
    const row = result.rows[0];
    const remaining = Math.max(0, policy.limit - row.request_count);
    return {
      allowed: row.request_count <= policy.limit,
      remaining,
      resetAt: row.expires_at,
    };
  }
}

function setRateLimitHeaders(
  response: Parameters<RequestHandler>[1],
  policy: RateLimitPolicy,
  result: RateLimitResult,
) {
  const resetSeconds = Math.max(
    0,
    Math.ceil((result.resetAt.getTime() - Date.now()) / 1_000),
  );
  response.set({
    "RateLimit-Limit": String(policy.limit),
    "RateLimit-Remaining": String(result.remaining),
    "RateLimit-Reset": String(resetSeconds),
  });
  if (!result.allowed) response.set("Retry-After", String(resetSeconds));
}

export function createRateLimitMiddleware(
  limiter: PostgresRateLimiter,
  policy: RateLimitPolicy,
  key: (request: Parameters<RequestHandler>[0]) => string,
): RequestHandler {
  return async (request, response, next) => {
    try {
      const result = await limiter.consume(policy, key(request));
      setRateLimitHeaders(response, policy, result);
      if (result.allowed) return next();
      response.status(429).json({
        error: {
          code: "RATE_LIMITED",
          message: "Too many requests. Please try again later.",
        },
      });
    } catch (error) {
      next(error);
    }
  };
}

export const clientIpKey = (request: Parameters<RequestHandler>[0]) =>
  request.ip ?? request.socket.remoteAddress ?? "unknown";

export function createSecurityHeaders(config: Config): RequestHandler {
  return (_request, response, next) => {
    response.set({
      "X-Frame-Options": "DENY",
      "X-XSS-Protection": "1; mode=block",
      "X-Content-Type-Options": "nosniff",
    });
    if (config.NODE_ENV === "production") {
      response.set(
        "Strict-Transport-Security",
        "max-age=31536000; includeSubDomains",
      );
    }
    next();
  };
}

export { publicApiPolicy };
