import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { S3Client } from "@aws-sdk/client-s3";
import { Pool } from "pg";
import { createApplication } from "../../src/app/createApp.js";
import type { AppDependencies } from "../../src/app/dependencies.js";
import { PostgresRateLimiter } from "../../src/app/security.js";
import { OktaAuthenticator } from "../../src/auth.js";
import { loadConfig } from "../../src/config.js";
import { migrations } from "../../src/migrations.js";
import { ProcessingPipelineStorage } from "../../src/processingPipelineStorage.js";

/** Disposable PostgreSQL schema, real API/auth/RBAC and AWS SDK over local HTTP. */
export async function startWorkspaceTicketApp(port = 0) {
  if (!process.env.TEST_DATABASE_URL || !process.env.TEST_S3_ENDPOINT)
    throw new Error(
      "Set TEST_DATABASE_URL and TEST_S3_ENDPOINT to disposable local services.",
    );
  const schema = `ticket_test_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    max: 1,
    options: `-c search_path=${schema},public`,
  });
  const client = new S3Client({
    region: "ap-southeast-1",
    endpoint: process.env.TEST_S3_ENDPOINT,
    forcePathStyle: true,
    credentials: { accessKeyId: "local-test", secretAccessKey: "local-test" },
  });
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_HOST: "127.0.0.1",
    DATABASE_PORT: "55432",
    DATABASE_NAME: "postgres",
    DATABASE_USER: "ticket_tests",
    DATABASE_PASSWORD: "local-only",
    OKTA_ISSUER: "https://example.okta.com/oauth2/default",
    OKTA_CLIENT_ID: "ticket-tests",
    RATE_LIMIT_HMAC_SECRET: "ticket-tests-local-only-secret-32-characters",
    S3_BUCKET: schema,
    AWS_REGION: "ap-southeast-1",
  });
  await pool.query(`CREATE SCHEMA ${schema}`);
  await pool.query(`SET search_path TO ${schema}, public`);
  for (const migration of migrations) await pool.query(migration.sql);
  const users: Record<string, string> = {};
  for (const role of ["admin", "business", "none"]) {
    users[role] = randomUUID();
    await pool.query(
      "INSERT INTO app_user (id,email,okta_subject,display_name,is_admin) VALUES ($1,$2,$3,$4,$5)",
      [
        users[role],
        `${role}@example.test`,
        `ticket-${role}`,
        `Ticket ${role}`,
        role === "admin",
      ],
    );
  }
  await pool.query(
    "INSERT INTO app_user_modules (user_id,module_id) VALUES ($1,'bss_eom_glob')",
    [users.business],
  );
  const authenticate = new OktaAuthenticator(pool, config, {
    async verifyAccessToken(token) {
      if (!["admin", "business", "none", "first-login"].includes(token))
        throw new Error("Invalid test token");
      return {
        claims: {
          sub: `ticket-${token}`,
          email: `${token}@example.test`,
          name: `Ticket ${token}`,
          exp: Math.floor(Date.now() / 1000) + 3600,
        },
      };
    },
  }).middleware;
  const app = createApplication({
    pool,
    config,
    authenticate,
    processingPipelineStorage: new ProcessingPipelineStorage(
      client,
      config.S3_BUCKET,
    ),
    stepFunctionsRunner: {} as AppDependencies["stepFunctionsRunner"],
    rateLimiter: new PostgresRateLimiter(pool, config),
    logger: { info() {}, error() {} },
  });
  const server = app.listen(port, "127.0.0.1");
  await once(server, "listening");
  return {
    pool,
    users,
    config,
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`,
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      client.destroy();
      await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await pool.end();
    },
  };
}
