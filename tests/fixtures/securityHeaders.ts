import type { Pool } from "pg";
import { loadConfig, type Config } from "../../src/config.js";
import { createApplication } from "../../src/app/createApp.js";
import { AppError } from "../../src/errors.js";
import type { AppDependencies } from "../../src/app/dependencies.js";

/** Test-only app: no .env, remote database, AWS or Okta access. All features deny auth. */
export function securityHeadersApp(overrides: Partial<Config> = {}) {
  const config = {
    ...loadConfig({
      NODE_ENV: "test",
      DATABASE_HOST: "127.0.0.1",
      DATABASE_PORT: "5432",
      DATABASE_NAME: "test_only",
      DATABASE_USER: "test_only",
      DATABASE_PASSWORD: "test_only",
      OKTA_ISSUER: "https://example.okta.com/oauth2/default",
      OKTA_CLIENT_ID: "test-only",
      RATE_LIMIT_HMAC_SECRET: "security-tests-only-not-a-real-secret-32-chars",
      S3_BUCKET: "test-only",
      AWS_REGION: "ap-southeast-1",
    }),
    ...overrides,
  };
  const calls = { database: 0, sharedLimiter: 0, auth: 0 };
  const shared = {
    allowed: true,
    remaining: 119,
    resetAt: new Date(Date.now() + 60000),
  };
  const app = createApplication({
    config,
    pool: {
      query: async () => {
        calls.database++;
        throw Error("Test attempted unexpected database access");
      },
    } as unknown as Pool,
    rateLimiter: {
      consume: async () => {
        calls.sharedLimiter++;
        return shared;
      },
    },
    processingPipelineStorage: {},
    stepFunctionsRunner: {},
    authenticate: (_request, _response, next) => {
      calls.auth++;
      next(
        new AppError(
          401,
          "TEST_AUTH_REQUIRED",
          "Test authentication required.",
        ),
      );
    },
    logger: { info: () => {}, error: () => {} },
  } as AppDependencies);
  return { app, config, calls, shared };
}
