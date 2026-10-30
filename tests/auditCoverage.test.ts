import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  auditRoutes,
  classifyAuditRoute,
} from "../src/platform/auditRoutes.js";
import { securityHeadersApp } from "./fixtures/securityHeaders.js";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

describe("audit route coverage", () => {
  it("classifies every feature router declaration, including rejected requests", () => {
    const modules = [
      ["src/modules/auth/api/router.ts", "/api/auth"],
      ["src/modules/auth/api/adminRouter.ts", "/api/admin"],
      [
        "src/modules/processing-pipelines/api/router.ts",
        "/api/processing-pipelines",
      ],
      ["src/modules/prepaid/api/router.ts", "/api/workflows/prepaid"],
    ];
    for (const [file, prefix] of modules) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(
        /router\.(get|post|put|patch|delete)\(\s*["']([^"']+)["']/g,
      )) {
        const route = prefix + (match[2] === "/" ? "" : match[2]);
        expect(
          auditRoutes.some(
            ([method, path]) =>
              method === match[1].toUpperCase() && path === route,
          ),
          route,
        ).toBe(true);
      }
    }
    expect(
      classifyAuditRoute("HEAD", "/api/workflows/prepaid/report.csv")?.action,
    ).toBe("report.transfer");
    expect(classifyAuditRoute("GET", "/API/AUTH/ME")?.action).toBe(
      "auth.session_validated",
    );
    expect(
      classifyAuditRoute("GET", "/api/workflows/prepaid/reportXcsv"),
    ).toBeUndefined();
  });
  it("keeps liveness up and blocks business requests while startup is migrating", async () => {
    let ready = false;
    const { app, calls } = securityHeadersApp({}, () => ready);
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      for (const path of ["/api/readyz", "/api/admin/users"]) {
        const r = await fetch(base + path);
        expect(r.status).toBe(503);
        await r.text();
      }
      const health = await fetch(base + "/api/healthz");
      expect(health.status).toBe(200);
      await health.text();
      expect(calls.database).toBe(0);
      expect(calls.auth).toBe(0);
      ready = true;
      const r = await fetch(base + "/api/admin/users");
      expect(r.status).toBe(401);
      await r.text();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it("readiness fails safely without a DB while liveness remains available", async () => {
    const { app } = securityHeadersApp();
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const ready = await fetch(base + "/api/readyz");
      expect(ready.status).toBe(503);
      expect(await ready.json()).toEqual({ ready: false });
      const health = await fetch(base + "/api/healthz");
      expect(health.status).toBe(200);
      await health.text();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
