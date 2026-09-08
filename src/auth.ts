import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";
import OktaJwtVerifier from "@okta/jwt-verifier";
import type { Pool } from "pg";
import { z } from "zod";
import type { Config } from "./config.js";
import { withTransaction } from "./db.js";
import { AppError } from "./errors.js";
import type { UserRow } from "./modules/shared/api/dtos.js";
import { ensureWorkspace } from "./workspace.js";

/**
 * TEMPORARY LOCAL UI-REVIEW SWITCH.
 *
 * Set this to true before restoring normal Okta enforcement or deploying the
 * API. Keep it false only while the matching local frontend bypass is active.
 */
export const ENABLE_OKTA_AUTH = false;
const temporaryAuthEmail = "juan.miguel.delacruz@globe.com";
const temporaryAuthSubject = "temporary-local-auth-bypass";
const temporaryAuthPasswordHash = "temporary-local-auth-bypass-disabled";

type VerifiedAccessToken = {
  claims: {
    sub?: unknown;
    email?: unknown;
    exp?: unknown;
    [key: string]: unknown;
  };
};

export type AccessTokenVerifier = {
  verifyAccessToken(
    token: string,
    audience: string | string[],
  ): Promise<VerifiedAccessToken>;
};

const userInfoSchema = z.object({
  sub: z.string().min(1),
  email: z.string().email(),
});

const identityConflict = () =>
  new AppError(
    409,
    "IDENTITY_CONFLICT",
    "This Okta identity cannot be linked to the existing portal account.",
  );

/**
 * Verifies Okta access tokens and maps their stable subject to a local UUID.
 * The local row remains the owner of existing workspace and audit data.
 */
export class OktaAuthenticator {
  private readonly verifier: AccessTokenVerifier;

  constructor(
    private readonly pool: Pool,
    private readonly config: Config,
    verifier?: AccessTokenVerifier,
  ) {
    this.verifier =
      verifier ??
      new OktaJwtVerifier({
        issuer: config.OKTA_ISSUER,
        clientId: config.OKTA_CLIENT_ID,
        assertClaims: { cid: config.OKTA_CLIENT_ID },
      });
  }

  readonly middleware: RequestHandler = async (request, _response, next) => {
    const authorization = request.header("authorization");
    const match = authorization?.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      next(new AppError(401, "UNAUTHENTICATED", "Sign in is required."));
      return;
    }

    let verified: VerifiedAccessToken;
    try {
      verified = await this.verifier.verifyAccessToken(
        match[1],
        this.config.OKTA_AUDIENCE,
      );
    } catch {
      next(
        new AppError(
          401,
          "UNAUTHENTICATED",
          "Your Okta access token is invalid or expired.",
        ),
      );
      return;
    }

    try {
      const subject = z.string().min(1).parse(verified.claims.sub);
      const expiresAt = new Date(
        z.number().int().positive().parse(verified.claims.exp) * 1_000,
      );
      const email = await this.resolveEmail(
        match[1],
        subject,
        verified.claims.email,
      );
      const user = await this.findOrCreateUser(subject, email);
      request.auth = {
        userId: user.id,
        oktaSubject: subject,
        email: user.email,
        createdAt: user.created_at,
        tokenExpiresAt: expiresAt,
      };
      next();
    } catch (error) {
      next(
        error instanceof AppError
          ? error
          : new AppError(
              401,
              "IDENTITY_CLAIMS_INVALID",
              "The Okta identity does not contain the required profile claims.",
            ),
      );
    }
  };

  private async resolveEmail(
    accessToken: string,
    subject: string,
    emailClaim: unknown,
  ) {
    const parsedClaim = z.string().email().safeParse(emailClaim);
    if (parsedClaim.success) return parsedClaim.data.trim().toLowerCase();

    // Once an Okta subject is linked, the local email is sufficient for
    // workspace ownership and avoids a userinfo round-trip on every API call.
    const linked = await this.pool.query<{ email: string }>(
      "SELECT email FROM users WHERE okta_subject = $1",
      [subject],
    );
    if (linked.rows[0]) return linked.rows[0].email.trim().toLowerCase();

    let response: Response;
    try {
      response = await fetch(`${this.config.OKTA_ISSUER}/v1/userinfo`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
    } catch {
      throw new AppError(
        503,
        "IDENTITY_PROVIDER_UNAVAILABLE",
        "Okta profile information is temporarily unavailable.",
      );
    }
    if (!response.ok) {
      throw new AppError(
        response.status === 401 ? 401 : 503,
        response.status === 401
          ? "UNAUTHENTICATED"
          : "IDENTITY_PROVIDER_UNAVAILABLE",
        response.status === 401
          ? "Your Okta access token is invalid or expired."
          : "Okta profile information is temporarily unavailable.",
      );
    }
    const profile = userInfoSchema.parse(await response.json());
    if (profile.sub !== subject) throw identityConflict();
    return profile.email.trim().toLowerCase();
  }

  private async findOrCreateUser(subject: string, email: string) {
    return withTransaction(this.pool, async (client) => {
      const candidates = await client.query<UserRow>(
        "SELECT * FROM users WHERE okta_subject = $1 OR lower(email) = $2 FOR UPDATE",
        [subject, email],
      );
      const subjectUser = candidates.rows.find(
        (candidate) => candidate.okta_subject === subject,
      );
      const emailUser = candidates.rows.find(
        (candidate) => candidate.email.toLowerCase() === email,
      );
      if (subjectUser && emailUser && subjectUser.id !== emailUser.id) {
        throw identityConflict();
      }

      let user: UserRow;
      if (subjectUser) {
        const updated = await client.query<UserRow>(
          "UPDATE users SET email = $1, updated_at = now() WHERE id = $2 RETURNING *",
          [email, subjectUser.id],
        );
        user = updated.rows[0];
      } else if (emailUser) {
        if (emailUser.okta_subject && emailUser.okta_subject !== subject) {
          throw identityConflict();
        }
        const linked = await client.query<UserRow>(
          "UPDATE users SET okta_subject = $1, email = $2, updated_at = now() WHERE id = $3 RETURNING *",
          [subject, email, emailUser.id],
        );
        user = linked.rows[0];
      } else {
        const created = await client.query<UserRow>(
          "INSERT INTO users (id, email, okta_subject) VALUES ($1, $2, $3) RETURNING *",
          [randomUUID(), email, subject],
        );
        user = created.rows[0];
      }
      await ensureWorkspace(client, user.id);
      return user;
    }).catch((error: unknown) => {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "23505"
      ) {
        throw identityConflict();
      }
      throw error;
    });
  }
}

/**
 * Supplies a stable local user for temporary UI work without assigning an
 * Okta subject. A later real Okta login can therefore link the same email.
 */
export class TemporaryAuthenticator {
  constructor(private readonly pool: Pool) {}

  readonly middleware: RequestHandler = async (request, _response, next) => {
    try {
      const user = await this.findOrCreateUser();
      request.auth = {
        userId: user.id,
        oktaSubject: temporaryAuthSubject,
        email: user.email,
        createdAt: user.created_at,
        tokenExpiresAt: new Date("2999-12-31T23:59:59.999Z"),
      };
      next();
    } catch (error) {
      next(error);
    }
  };

  private async findOrCreateUser() {
    return withTransaction(this.pool, async (client) => {
      const existing = await client.query<UserRow>(
        "SELECT * FROM users WHERE lower(email) = $1 FOR UPDATE",
        [temporaryAuthEmail],
      );
      const user = existing.rows[0] ?? (
        await client.query<UserRow>(
          "INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3) RETURNING *",
          [randomUUID(), temporaryAuthEmail, temporaryAuthPasswordHash],
        )
      ).rows[0];
      await ensureWorkspace(client, user.id);
      return user;
    });
  }
}

export function createAuthMiddleware(
  pool: Pool,
  config: Config,
  verifier?: AccessTokenVerifier,
) {
  if (!ENABLE_OKTA_AUTH) return new TemporaryAuthenticator(pool).middleware;
  return new OktaAuthenticator(pool, config, verifier).middleware;
}
