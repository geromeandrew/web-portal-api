import { once } from "node:events";
import type { AddressInfo } from "node:net";
import SwaggerParser from "@apidevtools/swagger-parser";
import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { Config } from "../src/config.js";
import { openApiDocument } from "../src/openapi.js";
import { createApp } from "../src/routes.js";

const config: Config = {
  NODE_ENV: "test",
  PORT: 3001,
  DATABASE_URL: "postgresql://portal:password@127.0.0.1:5432/web_portal",
  JWT_SECRET: "a-very-long-test-secret-that-is-at-least-32-characters",
  JWT_EXPIRES_IN: "8h",
  ADMIN_EMAIL: "admin@example.com",
  ADMIN_PASSWORD: "a-secure-bootstrap-password",
  LAMBDA_UPLOAD_URL: "https://example.lambda-url.ap-southeast-1.on.aws",
  S3_BUCKET: "billing-cycle-files",
  AWS_REGION: "ap-southeast-1",
  MAX_UPLOAD_BYTES: 4_500_000,
  ALLOWED_MIME_TYPES: "application/pdf",
  allowedMimeTypes: ["application/pdf"],
};

describe("OpenAPI documentation", () => {
  it("is a valid OpenAPI document covering every API route", async () => {
    await expect(SwaggerParser.validate(openApiDocument)).resolves.toBeDefined();
    const operationCount = Object.values(openApiDocument.paths).reduce((total, path) => total + Object.keys(path).filter((key) => ["get", "post", "put", "patch", "delete"].includes(key)).length, 0);
    expect(operationCount).toBe(25);
    expect(openApiDocument.paths["/api/uploads"]?.post).toBeDefined();
    expect(openApiDocument.paths["/api/workflows/prepaid/report.csv"]?.get?.responses["200"].content?.["text/csv"]).toBeDefined();
    expect(openApiDocument.paths["/api/processing-pipelines/{pipelineCode}/files"]?.get?.parameters).toHaveLength(1);
    expect(openApiDocument.paths["/api/auth/login"]?.post?.security).toEqual([]);
    expect(openApiDocument.paths["/api/billing-cycle/files"]).toBeUndefined();
  });

  it("serves the OpenAPI JSON and Swagger UI", async () => {
    const server = createApp({} as Pool, config).listen(0);
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;

    try {
      const [rootResponse, specResponse, docsResponse, stylesheetResponse] = await Promise.all([
        fetch(`http://127.0.0.1:${port}/`, { redirect: "manual" }),
        fetch(`http://127.0.0.1:${port}/api/openapi.json`),
        fetch(`http://127.0.0.1:${port}/api/docs/`),
        fetch(`http://127.0.0.1:${port}/api/docs/swagger-ui.css`),
      ]);
      expect(rootResponse.status).toBe(302);
      expect(rootResponse.headers.get("location")).toBe("/api/docs/");
      expect(specResponse.status).toBe(200);
      expect(await specResponse.json()).toEqual(openApiDocument);
      expect(docsResponse.status).toBe(200);
      expect(docsResponse.headers.get("content-type")).toContain("text/html");
      expect(stylesheetResponse.status).toBe(200);
      expect(stylesheetResponse.headers.get("content-type")).toContain("text/css");
      await Promise.all([docsResponse.text(), stylesheetResponse.text()]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
