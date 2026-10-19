import express, { type Response } from "express";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPrepaidUpload } from "../src/modules/prepaid/api/upload.js";
import { createErrorHandler } from "../src/errors.js";
import { prepaidMaximumSourceBytes } from "../src/modules/prepaid/domain/limits.js";
import { loadConfig } from "../src/config.js";

describe("Bounded legacy-sized Prepaid uploads", () => {
  let server: Server | undefined;
  const held: Response[] = [];
  afterEach(async () => {
    for (const res of held) if (!res.writableEnded) res.end();
    held.length = 0;
    await new Promise<void>((resolve) => {
      if (server) server.close(() => resolve());
      else resolve();
    });
    server = undefined;
  });
  const body = (size: number) => {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(size)]), "KE24.xlsx");
    return form;
  };
  async function start(maximum?: number, hold = false) {
    const app = express();
    app.post("/upload", createPrepaidUpload(maximum), (req, res) => {
      if (hold) held.push(res);
      else res.json({ bytes: req.file?.size });
    });
    app.use(createErrorHandler({ error: vi.fn() } as any, {} as any));
    server = await new Promise<Server>((resolve) => {
      const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    });
    return `http://127.0.0.1:${(server.address() as any).port}/upload`;
  }
  it("accepts actual multipart bytes above 4.5 MB", async () => {
    const url = await start();
    const res = await fetch(url, { method: "POST", body: body(5_000_000) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ bytes: 5_000_000 });
    expect(prepaidMaximumSourceBytes).toBe(104857600);
  });
  it("rejects a configured smaller bound with 413, then frees its upload slot", async () => {
    const url = await start(100);
    expect((await fetch(url, { method: "POST", body: body(101) })).status).toBe(
      413,
    );
    expect((await fetch(url, { method: "POST", body: body(99) })).status).toBe(
      200,
    );
  });
  it("bounds concurrent retained source buffers and frees slots after the response", async () => {
    const url = await start(100, true);
    const first = fetch(url, { method: "POST", body: body(10) });
    const second = fetch(url, { method: "POST", body: body(10) });
    await vi.waitFor(() => expect(held.length).toBe(2));
    const busy = await fetch(url, { method: "POST", body: body(10) });
    expect(busy.status).toBe(503);
    expect((await busy.json()).error.code).toBe("PREPAID_UPLOAD_BUSY");
    held[0].end();
    held[1].end();
    await Promise.all([first, second]);
    const next = fetch(url, { method: "POST", body: body(10) });
    await vi.waitFor(() => expect(held.length).toBe(3));
    held[2].end();
    expect((await next).status).toBe(200);
  });
  it("uses a separate configurable Prepaid ceiling without widening other uploads", () => {
    const env = {
      DATABASE_HOST: "127.0.0.1",
      DATABASE_PORT: "5432",
      DATABASE_NAME: "test",
      DATABASE_USER: "test",
      DATABASE_PASSWORD: "test",
      OKTA_ISSUER: "https://test.example/oauth2/default",
      OKTA_CLIENT_ID: "test",
      RATE_LIMIT_HMAC_SECRET: "t".repeat(32),
      S3_BUCKET: "test",
      AWS_REGION: "us-east-1",
    };
    const config = loadConfig(env);
    expect(config).not.toHaveProperty("MAX_UPLOAD_BYTES");
    expect(config.PREPAID_MAX_UPLOAD_BYTES).toBe(104857600);
    expect(() =>
      loadConfig({ ...env, PREPAID_MAX_UPLOAD_BYTES: "104857601" }),
    ).toThrow("PREPAID_MAX_UPLOAD_BYTES");
    expect(() => createPrepaidUpload(104857601)).toThrow();
  });
});
