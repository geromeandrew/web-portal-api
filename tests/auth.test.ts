import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAuthMiddleware,
  OktaAuthenticator,
  type AccessTokenVerifier,
} from "../src/auth.js";
import type { Config } from "../src/config.js";
import { AppError } from "../src/errors.js";
import type { UserRow } from "../src/modules/shared/api/dtos.js";

const config = {
  OKTA_ISSUER: "https://example.okta.com/oauth2/default",
  OKTA_AUDIENCE: "api://default",
  OKTA_CLIENT_ID: "test-client-id",
} as Config;

const existingUser: UserRow = {
  id: "d0bedf7f-7722-48e6-a21c-702eee6a70f8",
  email: "person@example.com",
  password_hash: null,
  okta_subject: null,
  is_bootstrap_admin: false,
  is_active: false,
  must_change_password: false,
  token_version: 1,
  created_at: new Date("2026-01-02T03:04:05.000Z"),
};

const temporaryUser: UserRow = {
  ...existingUser,
  id: "6c3cecab-9e52-41b5-a2f2-d4da10cba187",
  email: "juan.miguel.delacruz@globe.com",
};

function poolWithCandidates(candidates: UserRow[]) {
  const queries: Array<{ sql: string; values?: unknown[] }> = [];
  const client = {
    query: vi.fn(async (sql: string, values?: unknown[]) => {
      queries.push({ sql, values });
      if (sql.includes("SELECT * FROM users")) return { rows: candidates };
      if (sql.includes("UPDATE users SET okta_subject")) {
        return {
          rows: [
            {
              ...existingUser,
              okta_subject: String(values?.[0]),
              email: String(values?.[1]),
            },
          ],
        };
      }
      if (sql.includes("UPDATE users SET email")) {
        return { rows: [{ ...existingUser, email: String(values?.[0]) }] };
      }
      if (sql.includes("SELECT id FROM workspaces")) {
        return { rows: [{ id: "workspace-id" }] };
      }
      return { rows: [], rowCount: 1 };
    }),
    release: vi.fn(),
  };
  return {
    pool: {
      connect: async () => client,
      query: async (_sql: string, values?: unknown[]) => ({
        rows: candidates
          .filter((candidate) => candidate.okta_subject === values?.[0])
          .map((candidate) => ({ email: candidate.email })),
      }),
    } as unknown as Pool,
    queries,
  };
}

async function invoke(
  authenticator: OktaAuthenticator,
  authorization?: string,
) {
  const request = {
    header: (name: string) =>
      name === "authorization" ? authorization : undefined,
  } as never;
  const error = await new Promise<unknown>((resolve) => {
    void authenticator.middleware(request, {} as never, resolve as never);
  });
  return { request: request as Express.Request, error };
}

async function invokeMiddleware(middleware: Express.RequestHandler) {
  const request = { header: () => undefined } as never;
  const error = await new Promise<unknown>((resolve) => {
    void middleware(request, {} as never, resolve as never);
  });
  return { request: request as Express.Request, error };
}

afterEach(() => vi.unstubAllGlobals());

describe("OktaAuthenticator", () => {
  it("rejects requests without a bearer token", async () => {
    const { pool } = poolWithCandidates([]);
    const verifier = { verifyAccessToken: vi.fn() } as AccessTokenVerifier;
    const result = await invoke(new OktaAuthenticator(pool, config, verifier));

    expect(result.error).toMatchObject({
      status: 401,
      code: "UNAUTHENTICATED",
    });
    expect(verifier.verifyAccessToken).not.toHaveBeenCalled();
  });

  it("maps verifier failures to a sanitized 401", async () => {
    const { pool } = poolWithCandidates([]);
    const verifier: AccessTokenVerifier = {
      verifyAccessToken: vi.fn().mockRejectedValue(new Error("bad signature")),
    };
    const result = await invoke(
      new OktaAuthenticator(pool, config, verifier),
      "Bearer invalid-token",
    );

    expect(result.error).toMatchObject({
      status: 401,
      code: "UNAUTHENTICATED",
    });
  });

  it("links a matching legacy email and preserves its local UUID", async () => {
    const { pool, queries } = poolWithCandidates([existingUser]);
    const verifier: AccessTokenVerifier = {
      verifyAccessToken: vi.fn().mockResolvedValue({
        claims: {
          sub: "00u-okta-subject",
          email: "Person@Example.com",
          exp: 1_900_000_000,
        },
      }),
    };
    const result = await invoke(
      new OktaAuthenticator(pool, config, verifier),
      "Bearer valid-token",
    );

    expect(result.error).toBeUndefined();
    expect(verifier.verifyAccessToken).toHaveBeenCalledWith(
      "valid-token",
      "api://default",
    );
    expect(result.request.auth).toMatchObject({
      userId: existingUser.id,
      oktaSubject: "00u-okta-subject",
      email: "person@example.com",
    });
    expect(
      queries.some(
        ({ sql, values }) =>
          sql.includes("UPDATE users SET okta_subject") &&
          values?.[0] === "00u-okta-subject",
      ),
    ).toBe(true);
  });

  it("uses userinfo when the access token has no email claim", async () => {
    const { pool } = poolWithCandidates([existingUser]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            sub: "00u-okta-subject",
            email: "person@example.com",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const verifier: AccessTokenVerifier = {
      verifyAccessToken: vi.fn().mockResolvedValue({
        claims: { sub: "00u-okta-subject", exp: 1_900_000_000 },
      }),
    };
    const result = await invoke(
      new OktaAuthenticator(pool, config, verifier),
      "Bearer valid-token",
    );

    expect(result.error).toBeUndefined();
    expect(fetch).toHaveBeenCalledWith(
      "https://example.okta.com/oauth2/default/v1/userinfo",
      { headers: { Authorization: "Bearer valid-token" } },
    );
  });

  it("rejects an email already linked to another Okta subject", async () => {
    const { pool } = poolWithCandidates([
      { ...existingUser, okta_subject: "different-subject" },
    ]);
    const verifier: AccessTokenVerifier = {
      verifyAccessToken: vi.fn().mockResolvedValue({
        claims: {
          sub: "new-subject",
          email: "person@example.com",
          exp: 1_900_000_000,
        },
      }),
    };
    const result = await invoke(
      new OktaAuthenticator(pool, config, verifier),
      "Bearer valid-token",
    );

    expect(result.error).toBeInstanceOf(AppError);
    expect(result.error).toMatchObject({
      status: 409,
      code: "IDENTITY_CONFLICT",
    });
  });
});

describe("temporary local authentication", () => {
  it("uses the preview identity without requiring or verifying a bearer token", async () => {
    const queries: Array<{ sql: string; values?: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        queries.push({ sql, values });
        if (sql.includes("SELECT * FROM users WHERE lower(email)")) return { rows: [temporaryUser] };
        if (sql.includes("SELECT id FROM workspaces")) return { rows: [{ id: "workspace-id" }] };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: async () => client } as unknown as Pool;
    const verifier = { verifyAccessToken: vi.fn() } as AccessTokenVerifier;

    const result = await invokeMiddleware(createAuthMiddleware(pool, config, verifier));

    expect(result.error).toBeUndefined();
    expect(result.request.auth).toMatchObject({
      userId: temporaryUser.id,
      email: "juan.miguel.delacruz@globe.com",
      oktaSubject: "temporary-local-auth-bypass",
    });
    expect(verifier.verifyAccessToken).not.toHaveBeenCalled();
    expect(queries.some(({ sql }) => sql.includes("SELECT * FROM users WHERE lower(email)"))).toBe(true);
  });

  it("creates the preview user with the legacy password field for older local schemas", async () => {
    const queries: Array<{ sql: string; values?: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        queries.push({ sql, values });
        if (sql.includes("SELECT * FROM users WHERE lower(email)")) return { rows: [] };
        if (sql.includes("INSERT INTO users")) return { rows: [temporaryUser] };
        if (sql.includes("SELECT id FROM workspaces")) return { rows: [{ id: "workspace-id" }] };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: async () => client } as unknown as Pool;

    const result = await invokeMiddleware(createAuthMiddleware(pool, config));

    expect(result.error).toBeUndefined();
    expect(queries.find(({ sql }) => sql.includes("INSERT INTO users"))?.values).toEqual([
      expect.any(String),
      "juan.miguel.delacruz@globe.com",
      "temporary-local-auth-bypass-disabled",
    ]);
  });
});
