import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const base = {
  DATABASE_URL: "postgresql://portal:password@127.0.0.1:5432/web_portal",
  JWT_SECRET: "a-very-long-test-secret-that-is-at-least-32-characters",
  ADMIN_EMAIL: "admin@example.com",
  ADMIN_PASSWORD: "a-secure-bootstrap-password",
  LAMBDA_UPLOAD_URL: "https://example.lambda-url.ap-southeast-1.on.aws",
};

describe("loadConfig", () => {
  it("normalizes the Lambda URL and MIME type list", () => {
    const config = loadConfig({ ...base, LAMBDA_UPLOAD_URL: `${base.LAMBDA_UPLOAD_URL}/`, ALLOWED_MIME_TYPES: "application/pdf, image/png" });
    expect(config.LAMBDA_UPLOAD_URL).toBe(base.LAMBDA_UPLOAD_URL);
    expect(config.allowedMimeTypes).toEqual(["application/pdf", "image/png"]);
  });

  it("builds a local database URL from PostgreSQL settings", () => {
    const { DATABASE_URL: _databaseUrl, ...withoutUrl } = base;
    const config = loadConfig({ ...withoutUrl, POSTGRES_DB: "web_portal", POSTGRES_USER: "portal", POSTGRES_PASSWORD: "password" });
    expect(config.DATABASE_URL).toBe("postgresql://portal:password@127.0.0.1:5432/web_portal");
  });
});
