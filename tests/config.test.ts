import { describe, expect, it } from "vitest";
import { createAwsClientOptions } from "../src/aws.js";
import { loadConfig } from "../src/config.js";

const base = {
  DATABASE_HOST: "127.0.0.1",
  DATABASE_PORT: "5432",
  DATABASE_NAME: "web_portal",
  DATABASE_USER: "portal",
  DATABASE_PASSWORD: "password",
  OKTA_ISSUER: "https://example.okta.com/oauth2/default",
  OKTA_CLIENT_ID: "test-client-id",
  RATE_LIMIT_HMAC_SECRET:
    "a-very-long-test-secret-that-is-at-least-32-characters",
  S3_BUCKET: "billing-cycle-files",
  AWS_REGION: "ap-southeast-1",
};

describe("loadConfig", () => {
  it("does not read the upload limit from deployment environment variables", () => {
    expect(
      loadConfig({ ...base, MAX_UPLOAD_BYTES: "1048576" }),
    ).not.toHaveProperty("MAX_UPLOAD_BYTES");
    expect(
      loadConfig({ ...base, MAX_UPLOAD_BYTES: "invalid" }),
    ).not.toHaveProperty("MAX_UPLOAD_BYTES");
  });
  it("uses the dedicated Portal schema and disables database TLS by default", () => {
    expect(loadConfig(base).DATABASE_SCHEMA).toBe("web_portal");
    expect(loadConfig(base).DATABASE_SSL).toBe(false);
  });

  it("enables database TLS when configured", () => {
    expect(loadConfig({ ...base, DATABASE_SSL: "true" }).DATABASE_SSL).toBe(
      true,
    );
  });

  it("supports disabling database TLS for a local PostgreSQL server", () => {
    expect(loadConfig({ ...base, DATABASE_SSL: "false" }).DATABASE_SSL).toBe(
      false,
    );
  });

  it("uses configured Okta values and keeps proxy trust disabled locally", () => {
    const config = loadConfig(base);
    expect(config.OKTA_ISSUER).toBe(base.OKTA_ISSUER);
    expect(config.OKTA_AUDIENCE).toBe("api://default");
    expect(config.OKTA_CLIENT_ID).toBe(base.OKTA_CLIENT_ID);
    expect(config.RATE_LIMIT_HMAC_SECRET).toBe(base.RATE_LIMIT_HMAC_SECRET);
    expect(config.TRUST_PROXY_HOPS).toBe(0);
  });

  it("requires the Okta issuer and client ID", () => {
    const { OKTA_ISSUER: _issuer, ...withoutIssuer } = base;
    const { OKTA_CLIENT_ID: _clientId, ...withoutClientId } = base;
    expect(() => loadConfig(withoutIssuer)).toThrow("OKTA_ISSUER");
    expect(() => loadConfig(withoutClientId)).toThrow("OKTA_CLIENT_ID");
  });

  it("rejects the Okta org issuer for a custom API", () => {
    expect(() =>
      loadConfig({ ...base, OKTA_ISSUER: "https://globe.okta.com" }),
    ).toThrow("OKTA_ISSUER");
  });

  it("requires the dedicated rate-limit secret", () => {
    const { RATE_LIMIT_HMAC_SECRET: _secret, ...withoutRateLimitSecret } = base;
    expect(() => loadConfig(withoutRateLimitSecret)).toThrow(
      "RATE_LIMIT_HMAC_SECRET",
    );
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

  it("requires individual database connection settings and a safe schema identifier", () => {
    const { DATABASE_HOST: _databaseHost, ...withoutHost } = base;
    const { DATABASE_PORT: _databasePort, ...withoutPort } = base;
    expect(() => loadConfig(withoutHost)).toThrow("DATABASE_HOST");
    expect(() => loadConfig(withoutPort)).toThrow("DATABASE_PORT");
    expect(() =>
      loadConfig({ ...base, DATABASE_SCHEMA: "web-portal" }),
    ).toThrow("DATABASE_SCHEMA");
  });
});
