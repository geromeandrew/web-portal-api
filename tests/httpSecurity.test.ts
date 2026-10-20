import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { describe, it, expect, vi } from "vitest";
import express from "express";
import type { Config } from "../src/config.js";
import {
  createCorsMiddleware,
  createGlobalRateLimiter,
} from "../src/app/httpSecurity.js";
import { securityHeadersApp } from "./fixtures/securityHeaders.js";

async function withApp(
  overrides: Partial<Config>,
  run: (
    base: string,
    fixture: ReturnType<typeof securityHeadersApp>,
  ) => Promise<void>,
) {
  const fixture = securityHeadersApp(overrides);
  const server = fixture.app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await run(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      fixture,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
const origin = "https://esatp-dv.globetel.cloud";

async function withRateLimitApp(
  limit: number,
  trustProxy: number,
  run: (base: string) => Promise<void>,
) {
  const app = express();
  app.set("trust proxy", trustProxy);
  app.use(createCorsMiddleware());
  app.use(createGlobalRateLimiter({ limit, windowSeconds: 60 }));
  app.get("/", (_request, response) => response.status(200).end());
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function assertBaseline(headers: Headers) {
  expect(headers.get("content-security-policy")).toContain("script-src 'self'");
  expect(headers.get("content-security-policy")).toContain(
    "script-src-attr 'none'",
  );
  expect(headers.get("content-security-policy")).toContain("object-src 'none'");
  expect(headers.get("content-security-policy")).toContain(
    "frame-ancestors 'self'",
  );
  expect(headers.get("content-security-policy")).not.toMatch(
    /unsafe-eval|script-src[^;]*unsafe-inline/,
  );
  expect(headers.get("cross-origin-opener-policy")).toBe("same-origin");
  expect(headers.get("cross-origin-resource-policy")).toBe("same-origin");
  expect(headers.get("origin-agent-cluster")).toBe("?1");
  expect(headers.get("permissions-policy")).toBe(
    "geolocation=(), camera=(), microphone=(), fullscreen=(self)",
  );
  expect(headers.get("referrer-policy")).toBe(
    "strict-origin-when-cross-origin",
  );
  expect(headers.get("x-content-type-options")).toBe("nosniff");
  expect(headers.get("x-dns-prefetch-control")).toBe("off");
  expect(headers.get("x-download-options")).toBe("noopen");
  expect(headers.get("x-frame-options")).toBe("SAMEORIGIN");
  expect(headers.get("x-permitted-cross-domain-policies")).toBe("none");
  expect(headers.get("x-xss-protection")).toBe("1; mode=block");
  expect(headers.get("x-powered-by")).toBeNull();
}

describe("API security middleware over real HTTP", () => {
  it("allows same-origin Swagger POSTs even on a custom local API port without weakening cross-origin checks", async () => {
    await withApp({}, async (base) => {
      const sameOrigin = await fetch(`${base}/api/admin/users`, {
        method: "POST",
        headers: { Origin: base, "Content-Type": "application/json" },
        body: "{}",
      });
      expect(sameOrigin.status).toBe(401); // Passed CORS; authentication still required.
      expect(sameOrigin.headers.get("access-control-allow-origin")).toBe(base);
      await sameOrigin.text();
      const denied = await fetch(`${base}/api/healthz`, {
        headers: {
          Origin: "https://evil.example",
          "X-Forwarded-Host": "evil.example",
        },
      });
      expect(denied.status).toBe(403);
      await denied.text();
    });
  });
  it("shows the requested header family on health without a database/auth call", async () => {
    await withApp({ NODE_ENV: "production" }, async (base, f) => {
      const response = await fetch(`${base}/api/healthz`);
      expect(response.status).toBe(200);
      assertBaseline(response.headers);
      expect(response.headers.get("strict-transport-security")).toBe(
        "max-age=31536000; includeSubDomains",
      );
      expect(response.headers.get("x-ratelimit-limit")).toBe("20000");
      expect(response.headers.get("x-ratelimit-remaining")).toBe("19999");
      expect(Number(response.headers.get("x-ratelimit-reset"))).toBeGreaterThan(
        Date.now() / 1000,
      );
      expect(response.headers.get("ratelimit-limit")).toBe("20000");
      expect(Number(response.headers.get("ratelimit-reset"))).toBeGreaterThan(
        0,
      );
      expect(response.headers.get("ratelimit-policy")).toBe("20000;w=60");
      expect(await response.json()).toBe("The pod is healthy");
      expect(f.calls).toEqual({ database: 0, sharedLimiter: 0, auth: 0 });
    });
  });
  it("does not force HTTPS on local development", async () => {
    await withApp({}, async (base) => {
      const response = await fetch(`${base}/api/healthz`);
      expect(response.headers.get("strict-transport-security")).toBeNull();
      expect(response.headers.get("content-security-policy")).not.toContain(
        "upgrade-insecure-requests",
      );
      await response.text();
    });
  });
  it.each([
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "https://esatp-dv.globetel.cloud",
    "https://esatp-st.globetel.cloud",
    "https://esatp.globetel.cloud",
  ])("allows approved browser origin %s with credentials", async (approved) => {
    await withApp({}, async (base) => {
      const response = await fetch(`${base}/api/healthz`, {
        headers: { Origin: approved },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe(
        approved,
      );
      expect(response.headers.get("access-control-allow-credentials")).toBe(
        "true",
      );
      expect(response.headers.get("vary")).toContain("Origin");
      expect(response.headers.get("access-control-expose-headers")).toBeNull();
      await response.text();
    });
  });
  it.each([
    "https://evil.example",
    "https://esatp-dv.globetel.cloud.evil.example",
    "null",
    "http://localhost:5174",
  ])("denies unapproved browser origin %s", async (unapproved) => {
    await withApp({}, async (base, f) => {
      const response = await fetch(`${base}/api/healthz`, {
        headers: { Origin: unapproved },
      });
      expect(response.status).toBe(403);
      assertBaseline(response.headers);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      expect(await response.json()).toMatchObject({
        error: { code: "CORS_ORIGIN_DENIED" },
      });
      expect(f.calls.database).toBe(0);
    });
  });
  it("answers CORS preflight with headers before authentication or PostgreSQL", async () => {
    await withApp({}, async (base, f) => {
      const response = await fetch(`${base}/api/admin/users`, {
        method: "OPTIONS",
        headers: {
          Origin: origin,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "authorization,content-type",
        },
      });
      expect(response.status).toBe(204);
      assertBaseline(response.headers);
      expect(response.headers.get("access-control-allow-methods")).toContain(
        "POST",
      );
      expect(response.headers.get("access-control-allow-headers")).toContain(
        "Authorization",
      );
      expect(response.headers.get("x-ratelimit-remaining")).toBe("19999");
      expect(f.calls).toEqual({ database: 0, sharedLimiter: 0, auth: 0 });
    });
  });
  it("decrements actual global counters and returns 429 with CORS, quota and Retry-After headers", async () => {
    await withRateLimitApp(2, 0, async (base) => {
      const options = { headers: { Origin: origin } };
      const first = await fetch(`${base}/`, options);
      expect(first.headers.get("x-ratelimit-remaining")).toBe("1");
      await first.text();
      const second = await fetch(`${base}/`, options);
      expect(second.headers.get("x-ratelimit-remaining")).toBe("0");
      await second.text();
      const limited = await fetch(`${base}/`, options);
      expect(limited.status).toBe(429);
      expect(limited.headers.get("access-control-allow-origin")).toBe(origin);
      expect(limited.headers.get("x-ratelimit-remaining")).toBe("0");
      expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(await limited.json()).toMatchObject({
        error: { code: "RATE_LIMITED" },
      });
    });
  });
  it("retains and reports the stronger existing shared feature quota instead of the outer 20000 limit", async () => {
    await withApp({}, async (base, f) => {
      const response = await fetch(`${base}/api/auth/me`);
      expect(response.status).toBe(401);
      assertBaseline(response.headers);
      expect(response.headers.get("x-ratelimit-limit")).toBe("120");
      expect(response.headers.get("ratelimit-limit")).toBe("120");
      expect(response.headers.get("ratelimit-policy")).toBe("120;w=60");
      await response.text();
      f.shared.allowed = false;
      f.shared.remaining = 0;
      const limited = await fetch(`${base}/api/auth/me`);
      expect(limited.status).toBe(429);
      expect(limited.headers.get("x-ratelimit-remaining")).toBe("0");
      expect(limited.headers.get("retry-after")).not.toBeNull();
      await limited.text();
      expect(f.calls.auth).toBe(1);
    });
  });
  it.each([
    "key=one&key=two",
    "key=one&%6bey=two",
    "__proto__=one&__proto__=two",
  ])(
    "rejects ambiguous query parameters using Express 5-compatible HPP: %s",
    async (query) => {
      await withApp({}, async (base, f) => {
        const response = await fetch(`${base}/api/healthz?${query}`);
        expect(response.status).toBe(400);
        assertBaseline(response.headers);
        expect(await response.json()).toMatchObject({
          error: { code: "HTTP_PARAMETER_POLLUTION" },
        });
        expect(f.calls.database).toBe(0);
      });
    },
  );
  it("rejects repeated URL-encoded form values while preserving valid JSON arrays", async () => {
    await withApp({}, async (base, f) => {
      const polluted = await fetch(`${base}/api/auth/me`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "role=user&role=admin",
      });
      expect(polluted.status).toBe(400);
      expect(await polluted.json()).toMatchObject({
        error: { code: "HTTP_PARAMETER_POLLUTION" },
      });
      expect(f.calls.auth).toBe(0);
      const array = await fetch(`${base}/api/admin/users`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modules: ["one", "two"] }),
      });
      expect(array.status).toBe(401);
      expect(await array.json()).toMatchObject({
        error: { code: "TEST_AUTH_REQUIRED" },
      });
    });
  });
  it("keeps headers on bad JSON, oversized JSON, excessive form parameters and 404s", async () => {
    await withApp({}, async (base) => {
      for (const [body, contentType, expected] of [
        ['{"private":"do-not-reflect",', "application/json", 400],
        [
          JSON.stringify({ value: "x".repeat(131073) }),
          "application/json",
          413,
        ],
        [
          Array.from({ length: 101 }, (_, n) => `field${n}=value`).join("&"),
          "application/x-www-form-urlencoded",
          413,
        ],
      ] as const) {
        const response = await fetch(`${base}/api/auth/me`, {
          method: "POST",
          headers: { "Content-Type": contentType },
          body,
        });
        expect(response.status).toBe(expected);
        assertBaseline(response.headers);
        expect(await response.text()).not.toContain("do-not-reflect");
      }
      const missing = await fetch(`${base}/not-a-route`);
      expect(missing.status).toBe(404);
      assertBaseline(missing.headers);
      await missing.text();
    });
  });
  it("keeps Swagger HTML, self-hosted scripts and health operational without DB access", async () => {
    await withApp({}, async (base, f) => {
      for (const path of [
        "/api/docs/",
        "/api/docs/swagger-ui-bundle.js",
        "/api/docs/swagger-ui-init.js",
        "/api/docs/swagger-ui.css",
        "/api/openapi.json",
      ]) {
        const response = await fetch(base + path);
        expect(response.status).toBe(200);
        assertBaseline(response.headers);
        const text = await response.text();
        if (path === "/api/docs/") {
          expect(text).toContain('src="./swagger-ui-init.js"');
          expect(text).not.toMatch(
            /<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/,
          );
        }
        if (path.endsWith("swagger-ui-init.js"))
          expect(text).toMatch(/"validatorUrl"\s*:\s*null/);
      }
      expect(f.calls.database).toBe(0);
    });
  });
  it("does not let a direct client evade its quota by spoofing X-Forwarded-For", async () => {
    const warning = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await withRateLimitApp(1, 0, async (base) => {
        const first = await fetch(`${base}/`, {
          headers: { "X-Forwarded-For": "192.0.2.1" },
        });
        expect(first.status).toBe(200);
        await first.text();
        const second = await fetch(`${base}/`, {
          headers: { "X-Forwarded-For": "192.0.2.2" },
        });
        expect(second.status).toBe(429);
        await second.text();
      });
    } finally {
      warning.mockRestore();
    }
  });
  it("uses the configured nearest trusted proxy hop rather than attacker-controlled leftmost addresses", async () => {
    await withRateLimitApp(1, 1, async (base) => {
      const first = await fetch(`${base}/`, {
        headers: { "X-Forwarded-For": "192.0.2.1, 198.51.100.1" },
      });
      expect(first.status).toBe(200);
      await first.text();
      const second = await fetch(`${base}/`, {
        headers: { "X-Forwarded-For": "192.0.2.2, 198.51.100.1" },
      });
      expect(second.status).toBe(429);
      await second.text();
    });
  });
});
