import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createPool } from "../src/db.js";
import type { Config } from "../src/config.js";

vi.mock("pg", () => ({ Pool: vi.fn() }));

const config: Config = {
  NODE_ENV: "test",
  PORT: 3001,
  DATABASE_HOST: "database.example.com",
  DATABASE_PORT: 1769,
  DATABASE_NAME: "isgesatpdv",
  DATABASE_USER: "esatp_sme",
  DATABASE_PASSWORD: "password",
  DATABASE_SSL: true,
  DATABASE_SCHEMA: "web_portal",
  OKTA_ISSUER: "https://example.okta.com/oauth2/default",
  OKTA_AUDIENCE: "api://default",
  OKTA_CLIENT_ID: "test-client-id",
  RATE_LIMIT_HMAC_SECRET: "a-very-long-test-secret-that-is-at-least-32-characters",
  S3_BUCKET: "billing-cycle-files",
  AWS_REGION: "ap-southeast-1",
  AWS_LOCAL: false,
  MAX_UPLOAD_BYTES: 4_500_000,
  OPENAPI_INCLUDE_NON_ESSENTIAL_ENDPOINTS: false,
};

describe("createPool", () => {
  it("uses encrypted TLS without requiring an RDS CA certificate", () => {
    createPool(config);

    expect(Pool).toHaveBeenCalledWith(
      expect.objectContaining({
        host: config.DATABASE_HOST,
        port: config.DATABASE_PORT,
        database: config.DATABASE_NAME,
        user: config.DATABASE_USER,
        password: config.DATABASE_PASSWORD,
        ssl: { rejectUnauthorized: false },
      }),
    );
  });

  it("can create a bootstrap pool without a schema-specific search path", () => {
    createPool(config, false);

    expect(Pool).toHaveBeenLastCalledWith(
      expect.objectContaining({
        host: config.DATABASE_HOST,
        port: config.DATABASE_PORT,
        database: config.DATABASE_NAME,
        user: config.DATABASE_USER,
        password: config.DATABASE_PASSWORD,
        ssl: { rejectUnauthorized: false },
      }),
    );
    expect(Pool).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ options: expect.any(String) }),
    );
  });

  it("disables TLS when configured", () => {
    createPool({ ...config, DATABASE_SSL: false });

    expect(Pool).toHaveBeenLastCalledWith(
      expect.objectContaining({ ssl: false }),
    );
  });

  it("uses the individually configured database connection settings", () => {
    createPool({ ...config, DATABASE_HOST: "other-database.example.com" });

    expect(Pool).toHaveBeenLastCalledWith(
      expect.objectContaining({
        host: "other-database.example.com",
        port: config.DATABASE_PORT,
        database: config.DATABASE_NAME,
        user: config.DATABASE_USER,
        password: config.DATABASE_PASSWORD,
        ssl: { rejectUnauthorized: false },
      }),
    );
  });
});
