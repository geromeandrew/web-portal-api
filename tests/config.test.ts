import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const base = {
  DATABASE_URL: "postgresql://portal:password@127.0.0.1:5432/web_portal",
  JWT_SECRET: "a-very-long-test-secret-that-is-at-least-32-characters",
  ADMIN_EMAIL: "admin@example.com",
  ADMIN_PASSWORD: "a-secure-bootstrap-password",
  LAMBDA_UPLOAD_URL: "https://example.lambda-url.ap-southeast-1.on.aws",
  S3_BUCKET: "billing-cycle-files",
  AWS_REGION: "ap-southeast-1",
};

describe("loadConfig", () => {
  it("normalizes the Lambda URL and MIME type list", () => {
    const config = loadConfig({
      ...base,
      LAMBDA_UPLOAD_URL: `${base.LAMBDA_UPLOAD_URL}/`,
      ALLOWED_MIME_TYPES: "application/pdf, image/png",
    });
    expect(config.LAMBDA_UPLOAD_URL).toBe(base.LAMBDA_UPLOAD_URL);
    expect(config.allowedMimeTypes).toEqual(["application/pdf", "image/png"]);
  });

  it("uses the dedicated Portal schema by default", () => {
    expect(loadConfig(base).DATABASE_SCHEMA).toBe("web_portal");
  });

  it("hides non-essential Swagger endpoints by default and can restore them", () => {
    expect(loadConfig(base).OPENAPI_INCLUDE_NON_ESSENTIAL_ENDPOINTS).toBe(
      false,
    );
    expect(
      loadConfig({ ...base, OPENAPI_INCLUDE_NON_ESSENTIAL_ENDPOINTS: "true" })
        .OPENAPI_INCLUDE_NON_ESSENTIAL_ENDPOINTS,
    ).toBe(true);
  });

  it("requires a database URL and a safe schema identifier", () => {
    const { DATABASE_URL: _databaseUrl, ...withoutUrl } = base;
    expect(() => loadConfig(withoutUrl)).toThrow("DATABASE_URL");
    expect(() =>
      loadConfig({ ...base, DATABASE_SCHEMA: "web-portal" }),
    ).toThrow("DATABASE_SCHEMA");
  });
});
