import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { Config } from "../src/config.js";
import {
  createSecurityHeaders,
  PostgresRateLimiter,
} from "../src/app/security.js";

const config: Config = {
  NODE_ENV: "test",
  PORT: 3001,
  DATABASE_URL: "postgresql://portal:password@127.0.0.1:5432/web_portal",
  DATABASE_SCHEMA: "web_portal",
  OKTA_ISSUER: "https://example.okta.com/oauth2/default",
  OKTA_AUDIENCE: "api://default",
  OKTA_CLIENT_ID: "test-client-id",
  RATE_LIMIT_HMAC_SECRET: "a-very-long-test-secret-that-is-at-least-32-characters",
  TRUST_PROXY_HOPS: 0,
  LAMBDA_UPLOAD_URL: "https://example.lambda-url.ap-southeast-1.on.aws",
  S3_BUCKET: "billing-cycle-files",
  AWS_REGION: "ap-southeast-1",
  AWS_LOCAL: false,
  MAX_UPLOAD_BYTES: 4_500_000,
  ALLOWED_MIME_TYPES: "application/pdf",
  allowedMimeTypes: ["application/pdf"],
  OPENAPI_INCLUDE_NON_ESSENTIAL_ENDPOINTS: false,
};

describe("PostgresRateLimiter", () => {
  it("uses an opaque key and reports rate-limit state from an atomic query", async () => {
    const queries: unknown[][] = [];
    const pool = {
      query: async (_sql: string, values: unknown[]) => {
        queries.push(values);
        return {
          rows: [
            {
              request_count: 3,
              expires_at: new Date(Date.now() + 60_000),
            },
          ],
        };
      },
    } as unknown as Pool;
    const limiter = new PostgresRateLimiter(pool, config);
    const result = await limiter.consume(
      { scope: "test", limit: 3, windowSeconds: 60 },
      "192.0.2.10",
    );

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(0);
    expect(queries[0][1]).not.toBe("192.0.2.10");
  });
});

describe("security headers", () => {
  it("sets the ISDP headers and enables HSTS only in production", () => {
    const headers: Record<string, string> = {};
    const response = {
      set: (name: string | Record<string, string>, value?: string) => {
        if (typeof name === "string") headers[name] = value!;
        else Object.assign(headers, name);
      },
    };
    createSecurityHeaders({ ...config, NODE_ENV: "production" })(
      {} as never,
      response as never,
      () => undefined,
    );

    expect(headers).toMatchObject({
      "X-Frame-Options": "DENY",
      "X-XSS-Protection": "1; mode=block",
      "X-Content-Type-Options": "nosniff",
      "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    });
  });
});
