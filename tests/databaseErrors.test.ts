import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { loadConfig } from "../src/config.js";
import { getDatabaseErrorDiagnostics } from "../src/databaseErrors.js";
import { createErrorHandler } from "../src/errors.js";
import type { Logger } from "../src/platform/logger.js";

const config = loadConfig({
  DATABASE_HOST: "10.220.179.25",
  DATABASE_PORT: "1769",
  DATABASE_NAME: "isgesatpdv",
  DATABASE_USER: "esatp_adm",
  DATABASE_PASSWORD: "must-never-appear-in-logs",
  DATABASE_SSL: "true",
  OKTA_ISSUER: "https://example.okta.com/oauth2/default",
  OKTA_CLIENT_ID: "test-client-id",
  RATE_LIMIT_HMAC_SECRET:
    "a-very-long-test-secret-that-is-at-least-32-characters",
  S3_BUCKET: "billing-cycle-files",
  AWS_REGION: "ap-southeast-1",
});

function timeoutError() {
  const error = Object.assign(
    new Error("connect ETIMEDOUT 10.220.179.25:1769"),
    {
      code: "ETIMEDOUT",
      errno: -110,
      syscall: "connect",
      address: "10.220.179.25",
      port: 1769,
    },
  );
  error.stack = `${error.stack}\n    at /app/node_modules/pg-pool/index.js:45:11`;
  return error;
}

describe("database error diagnostics", () => {
  it("explains PostgreSQL TCP timeouts without logging the password", () => {
    const diagnostics = getDatabaseErrorDiagnostics(timeoutError(), config);

    expect(diagnostics).toMatchObject({
      databaseError: true,
      errorCode: "ETIMEDOUT",
      syscall: "connect",
      remoteAddress: "10.220.179.25",
      remotePort: 1769,
      databaseHost: "10.220.179.25",
      databasePort: 1769,
      databaseName: "isgesatpdv",
      databaseUser: "esatp_adm",
      databaseSsl: true,
    });
    expect(diagnostics?.diagnosis).toContain("NetworkPolicy");
    expect(JSON.stringify(diagnostics)).not.toContain(config.DATABASE_PASSWORD);
  });

  it("explains pg_hba rejections for unencrypted connections", () => {
    const error = Object.assign(
      new Error(
        'no pg_hba.conf entry for host "10.240.64.10", user "esatp_adm", database "isgesatpdv", no encryption',
      ),
      { code: "28000", severity: "FATAL", routine: "ClientAuthentication" },
    );

    expect(getDatabaseErrorDiagnostics(error, config)?.diagnosis).toContain(
      "Enable DATABASE_SSL",
    );
  });

  it("does not mislabel unrelated errors as database failures", () => {
    expect(
      getDatabaseErrorDiagnostics(
        new Error("Unexpected application bug"),
        config,
      ),
    ).toBeUndefined();
  });
});

describe("API error handling", () => {
  it("logs actionable database context and returns a sanitized 503", () => {
    const logger: Logger = {
      info: vi.fn(),
      error: vi.fn(),
    };
    let responseStatus: number | undefined;
    let responseBody: unknown;
    const response = {
      status(status: number) {
        responseStatus = status;
        return this;
      },
      json(body: unknown) {
        responseBody = body;
        return this;
      },
    } as unknown as Response;

    createErrorHandler(logger, config)(
      timeoutError(),
      { method: "GET", originalUrl: "/api/docs/" } as Request,
      response,
      vi.fn(),
    );

    expect(logger.error).toHaveBeenCalledWith(
      "database.request_failed",
      expect.objectContaining({
        method: "GET",
        path: "/api/docs/",
        errorCode: "ETIMEDOUT",
        databaseSsl: true,
      }),
    );
    expect(responseStatus).toBe(503);
    expect(responseBody).toEqual({
      error: {
        code: "DATABASE_UNAVAILABLE",
        message: "The database is temporarily unavailable.",
      },
    });
  });
});
