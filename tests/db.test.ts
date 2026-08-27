import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createPool } from "../src/db.js";
import type { Config } from "../src/config.js";

vi.mock("node:fs", () => ({ readFileSync: vi.fn(() => "RDS CA") }));
vi.mock("pg", () => ({ Pool: vi.fn() }));

const config: Config = {
  NODE_ENV: "test",
  PORT: 3001,
  DATABASE_URL:
    "postgresql://esatp_sme:password@database.example.com:1769/isgesatpdv",
  DATABASE_SCHEMA: "web_portal",
  JWT_SECRET: "a-very-long-test-secret-that-is-at-least-32-characters",
  JWT_EXPIRES_IN: "8h",
  ADMIN_EMAIL: "admin@example.com",
  ADMIN_PASSWORD: "a-secure-bootstrap-password",
  LAMBDA_UPLOAD_URL: "https://example.lambda-url.ap-southeast-1.on.aws",
  S3_BUCKET: "billing-cycle-files",
  AWS_REGION: "ap-southeast-1",
  AWS_LOCAL: false,
  MAX_UPLOAD_BYTES: 4_500_000,
  ALLOWED_MIME_TYPES: "application/pdf",
  OPENAPI_INCLUDE_NON_ESSENTIAL_ENDPOINTS: false,
  allowedMimeTypes: ["application/pdf"],
};

describe("createPool", () => {
  it("uses the ap-southeast-1 RDS CA with certificate verification", () => {
    createPool(config);

    expect(readFileSync).toHaveBeenCalledWith(
      expect.objectContaining({ pathname: expect.stringContaining("certs/") }),
      "utf8",
    );
    expect(Pool).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionString: config.DATABASE_URL,
        ssl: { ca: "RDS CA", rejectUnauthorized: true },
      }),
    );
  });

  it("can create a bootstrap pool without a schema-specific search path", () => {
    createPool(config, false);

    expect(Pool).toHaveBeenLastCalledWith(
      expect.objectContaining({
        connectionString: config.DATABASE_URL,
        ssl: { ca: "RDS CA", rejectUnauthorized: true },
      }),
    );
    expect(Pool).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ options: expect.any(String) }),
    );
  });
});
