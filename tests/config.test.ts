import { describe, expect, it } from "vitest";
import { createAwsClientOptions } from "../src/aws.js";
import { loadConfig } from "../src/config.js";

const base = {
  DATABASE_URL: "postgresql://portal:password@127.0.0.1:5432/web_portal",
  RATE_LIMIT_HMAC_SECRET:
    "a-very-long-test-secret-that-is-at-least-32-characters",
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
    expect(loadConfig(base).DATABASE_SSL).toBe(true);
  });

  it("supports disabling database TLS for a local PostgreSQL server", () => {
    expect(loadConfig({ ...base, DATABASE_SSL: "false" }).DATABASE_SSL).toBe(
      false,
    );
  });

  it("uses the provisional Okta defaults and keeps proxy trust disabled locally", () => {
    const config = loadConfig(base);
    expect(config.OKTA_ISSUER).toBe("https://globe.okta.com/oauth2/default");
    expect(config.OKTA_AUDIENCE).toBe("api://default");
    expect(config.OKTA_CLIENT_ID).toBe("0oa28lk9m5953nLCA0h8");
    expect(config.RATE_LIMIT_HMAC_SECRET).toBe(base.RATE_LIMIT_HMAC_SECRET);
    expect(config.TRUST_PROXY_HOPS).toBe(0);
  });

  it("rejects the Okta org issuer for a custom API", () => {
    expect(() => loadConfig({ ...base, OKTA_ISSUER: "https://globe.okta.com" })).toThrow("OKTA_ISSUER");
  });

  it("accepts the legacy JWT secret only as a rate-limit migration fallback", () => {
    const { RATE_LIMIT_HMAC_SECRET: _secret, ...withoutNewName } = base;
    expect(
      loadConfig({
        ...withoutNewName,
        JWT_SECRET: "a-legacy-secret-that-is-still-at-least-32-characters",
      }).RATE_LIMIT_HMAC_SECRET,
    ).toBe("a-legacy-secret-that-is-still-at-least-32-characters");
  });

  it("uses the AWS SDK default credential chain outside local development", () => {
    const config = loadConfig(base);
    expect(config.AWS_LOCAL).toBe(false);
    expect(createAwsClientOptions(config)).toEqual({
      region: "ap-southeast-1",
    });
  });

  it("requires and uses explicit credentials for local AWS access", () => {
    expect(() => loadConfig({ ...base, AWS_LOCAL: "true" })).toThrow(
      "AWS_ACCESS_KEY_ID",
    );

    const config = loadConfig({
      ...base,
      AWS_LOCAL: "true",
      AWS_ACCESS_KEY_ID: "local-access-key",
      AWS_SECRET_ACCESS_KEY: "local-secret-key",
    });
    expect(createAwsClientOptions(config)).toEqual({
      region: "ap-southeast-1",
      credentials: {
        accessKeyId: "local-access-key",
        secretAccessKey: "local-secret-key",
      },
    });
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
