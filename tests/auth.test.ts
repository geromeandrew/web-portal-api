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
  display_name: null,
  is_bootstrap_admin: false,
  is_active: false,
  must_change_password: false,
  token_version: 1,
  created_at: new Date("2026-01-02T03:04:05.000Z"),
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
              display_name: String(values?.[2]),
            },
          ],
        };
      }
      if (sql.includes("UPDATE users SET email")) {
        return {
          rows: [
            {
              ...existingUser,
              email: String(values?.[0]),
              display_name: String(values?.[1]),
            },
          ],
        };
      }
      if (
        sql.includes(
          "INSERT INTO users (id, email, okta_subject, display_name)",
        )
      ) {
        return {
          rows: [
            {
              ...existingUser,
              id: String(values?.[0]),
              email: String(values?.[1]),
              okta_subject: String(values?.[2]),
              display_name: String(values?.[3]),
            },
          ],
        };
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
          .map((candidate) => ({
            email: candidate.email,
            display_name: candidate.display_name,
          })),
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

  it("uses a verified preferred username when it is an email address", async () => {
    const { pool } = poolWithCandidates([existingUser]);
    const verifier: AccessTokenVerifier = {
      verifyAccessToken: vi.fn().mockResolvedValue({
        claims: {
          sub: "00u-okta-subject",
          preferred_username: "Person@Example.com",
          exp: 1_900_000_000,
        },
      }),
    };

    const result = await invoke(
      new OktaAuthenticator(pool, config, verifier),
      "Bearer valid-token",
    );

    expect(result.error).toBeUndefined();
    expect(result.request.auth?.email).toBe("person@example.com");
  });

  it("uses Okta uid when sub is unavailable and does not require exp metadata", async () => {
    const { pool } = poolWithCandidates([existingUser]);
    const verifier: AccessTokenVerifier = {
      verifyAccessToken: vi.fn().mockResolvedValue({
        claims: {
          uid: "00u-okta-uid",
          email: "Person@Example.com",
        },
      }),
    };

    const result = await invoke(
      new OktaAuthenticator(pool, config, verifier),
      "Bearer valid-token",
    );

    expect(result.error).toBeUndefined();
    expect(result.request.auth).toMatchObject({
      oktaSubject: "00u-okta-uid",
      email: "person@example.com",
    });
  });

  it("uses a preferred username returned by userinfo when email is omitted", async () => {
    const { pool } = poolWithCandidates([existingUser]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            sub: "00u-okta-subject",
            preferred_username: "person@example.com",
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
    expect(result.request.auth?.email).toBe("person@example.com");
  });

  it("ignores a userinfo response for a different subject", async () => {
    const { pool } = poolWithCandidates([]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            sub: "different-okta-subject",
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
    expect(result.request.auth?.email).toMatch(/@identity\.invalid$/);
  });

  it("provisions a stable local identity when Okta does not expose an email", async () => {
    const { pool, queries } = poolWithCandidates([]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ sub: "00u-no-email" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const verifier: AccessTokenVerifier = {
      verifyAccessToken: vi.fn().mockResolvedValue({
        claims: { sub: "00u-no-email", exp: 1_900_000_000 },
      }),
    };

    const result = await invoke(
      new OktaAuthenticator(pool, config, verifier),
      "Bearer valid-token",
    );

    expect(result.error).toBeUndefined();
    expect(result.request.auth?.email).toMatch(
      /^okta-[a-f0-9]{64}@identity\.invalid$/,
    );
    expect(
      queries.find(({ sql }) =>
        sql.includes(
          "INSERT INTO users (id, email, okta_subject, display_name)",
        ),
      )?.values?.[1],
    ).toBe(result.request.auth?.email);
  });

  it("stores an Okta profile name for a user without an email claim", async () => {
    const { pool, queries } = poolWithCandidates([]);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ sub: "00u-profile-name", name: "Jane Example" }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        ),
    );
    const verifier: AccessTokenVerifier = {
      verifyAccessToken: vi.fn().mockResolvedValue({
        claims: { sub: "00u-profile-name", exp: 1_900_000_000 },
      }),
    };

    const result = await invoke(
      new OktaAuthenticator(pool, config, verifier),
      "Bearer valid-token",
    );

    expect(result.error).toBeUndefined();
    expect(result.request.auth?.displayName).toBe("Jane Example");
    expect(
      queries.find(({ sql }) =>
        sql.includes(
          "INSERT INTO users (id, email, okta_subject, display_name)",
        ),
      )?.values?.[3],
    ).toBe("Jane Example");
  });

  it("creates and provisions a user for a previously unseen Okta identity", async () => {
    const { pool, queries } = poolWithCandidates([]);
    const verifier: AccessTokenVerifier = {
      verifyAccessToken: vi.fn().mockResolvedValue({
        claims: {
          sub: "00u-new-okta-subject",
          email: "New.Person@Example.com",
          exp: 1_900_000_000,
        },
      }),
    };

    const result = await invoke(
      new OktaAuthenticator(pool, config, verifier),
      "Bearer valid-token",
    );

    expect(result.error).toBeUndefined();
    expect(result.request.auth).toMatchObject({
      oktaSubject: "00u-new-okta-subject",
      email: "new.person@example.com",
    });
    expect(
      queries.find(({ sql }) =>
        sql.includes(
          "INSERT INTO users (id, email, okta_subject, display_name)",
        ),
      )?.values,
    ).toEqual([
      expect.any(String),
      "new.person@example.com",
      "00u-new-okta-subject",
      "New Person",
    ]);
    expect(
      queries.some(({ sql }) => sql.includes("SELECT id FROM workspaces")),
    ).toBe(true);
  });

  it("does not rewrite an already-synchronized Okta user", async () => {
    const linkedUser: UserRow = {
      ...existingUser,
      okta_subject: "00u-okta-subject",
      display_name: "Person Example",
    };
    const { pool, queries } = poolWithCandidates([linkedUser]);
    const verifier: AccessTokenVerifier = {
      verifyAccessToken: vi.fn().mockResolvedValue({
        claims: {
          sub: "00u-okta-subject",
          email: "person@example.com",
          name: "Person Example",
          exp: 1_900_000_000,
        },
      }),
    };

    const result = await invoke(
      new OktaAuthenticator(pool, config, verifier),
      "Bearer valid-token",
    );

    expect(result.error).toBeUndefined();
    expect(queries.some(({ sql }) => sql.startsWith("UPDATE users SET"))).toBe(
      false,
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

  it("reconciles an empty synthetic Okta account with its legacy email account", async () => {
    const syntheticUser: UserRow = {
      ...existingUser,
      id: "bfda188c-70f2-4b9b-a59f-9f3d36288121",
      email:
        "okta-e32021d7a866eea9791da1f196de04bb5fa1b285f48e6a11ef37726870c6ed37@identity.invalid",
      okta_subject: "00u-okta-subject",
      display_name: "Okta account",
    };
    const { pool, queries } = poolWithCandidates([syntheticUser, existingUser]);
    const verifier: AccessTokenVerifier = {
      verifyAccessToken: vi.fn().mockResolvedValue({
        claims: {
          sub: "00u-okta-subject",
          email: "person@example.com",
          name: "Person Example",
          exp: 1_900_000_000,
        },
      }),
    };

    const result = await invoke(
      new OktaAuthenticator(pool, config, verifier),
      "Bearer valid-token",
    );

    expect(result.error).toBeUndefined();
    expect(result.request.auth).toMatchObject({
      userId: existingUser.id,
      email: "person@example.com",
      displayName: "Person Example",
    });
    expect(
      queries.some(
        ({ sql, values }) =>
          sql === "DELETE FROM users WHERE id = $1" &&
          values?.[0] === syntheticUser.id,
      ),
    ).toBe(true);
  });
});

describe("configured API authentication", () => {
  it("requires an Okta bearer token when normal authentication is enabled", async () => {
    const { pool } = poolWithCandidates([]);
    const verifier = { verifyAccessToken: vi.fn() } as AccessTokenVerifier;

    const result = await invokeMiddleware(
      createAuthMiddleware(pool, config, verifier),
    );

    expect(result.error).toMatchObject({
      status: 401,
      code: "UNAUTHENTICATED",
    });
    expect(verifier.verifyAccessToken).not.toHaveBeenCalled();
  });
});
