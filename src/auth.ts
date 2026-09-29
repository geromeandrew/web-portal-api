import { createHash, randomUUID } from "node:crypto";
import type { RequestHandler } from "express";
import OktaJwtVerifier from "@okta/jwt-verifier";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import type { Config } from "./config.js";
import { withTransaction } from "./db.js";
import { AppError } from "./errors.js";
import type { AppUserRow } from "./modules/shared/api/dtos.js";
import { ensureWorkspace } from "./workspace.js";

/**
 * Enables verification of Okta access tokens for protected API requests.
 */
export const ENABLE_OKTA_AUTH = true;
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

const identityEmailSchema = z.string().email();
const identityTextSchema = z.string().trim().min(1);

const identityProfileClaimsSchema = z.object({
  email: identityEmailSchema.optional(),
  preferred_username: identityTextSchema.optional(),
  upn: identityTextSchema.optional(),
  login: identityTextSchema.optional(),
  name: identityTextSchema.optional(),
  given_name: identityTextSchema.optional(),
  family_name: identityTextSchema.optional(),
});

const userInfoSchema = identityProfileClaimsSchema.extend({
  sub: z.string().min(1),
});

function getIdentityEmail(claims: unknown) {
  const parsed = identityProfileClaimsSchema.safeParse(claims);
  if (!parsed.success) return null;
  return (
    [
      parsed.data.email,
      parsed.data.preferred_username,
      parsed.data.upn,
      parsed.data.login,
    ].find((value) => identityEmailSchema.safeParse(value).success) ?? null
  );
}

function getIdentityDisplayName(claims: unknown) {
  const parsed = identityProfileClaimsSchema.safeParse(claims);
  if (!parsed.success) return null;
  if (parsed.data.name) return parsed.data.name;
  const fullName = [parsed.data.given_name, parsed.data.family_name]
    .filter(Boolean)
    .join(" ");
  return fullName || parsed.data.preferred_username || null;
}

function getIdentitySubject(claims: Record<string, unknown>) {
  const subject = z.string().min(1).safeParse(claims.sub);
  if (subject.success) return subject.data;
  const uid = z.string().min(1).safeParse(claims.uid);
  if (uid.success) return uid.data;
  throw new AppError(
    401,
    "IDENTITY_SUBJECT_MISSING",
    "The verified Okta token does not identify a user.",
  );
}

function fallbackEmailForSubject(subject: string) {
  const identityHash = createHash("sha256").update(subject).digest("hex");
  return `okta-${identityHash}@identity.invalid`;
}

function isSyntheticEmail(email: string) {
  return email.endsWith("@identity.invalid");
}

function fallbackDisplayName(email: string) {
  if (email.endsWith("@identity.invalid")) return "Okta account";
  const localPart = email.split("@", 1)[0];
  return (
    localPart
      .replace(/[._-]+/g, " ")
      .split(" ")
      .filter(Boolean)
      .map(
        (part) =>
          `${part.slice(0, 1).toLocaleUpperCase()}${part.slice(1).toLocaleLowerCase()}`,
      )
      .join(" ") || "Okta account"
  );
}

type IdentityProfile = {
  email: string;
  displayName: string;
};

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
      const subject = getIdentitySubject(verified.claims);
      const expiration = z.coerce
        .number()
        .int()
        .positive()
        .safeParse(verified.claims.exp);
      const expiresAt = expiration.success
        ? new Date(expiration.data * 1_000)
        : new Date(Date.now() + 5 * 60 * 1_000);
      const profile = await this.resolveProfile(
        match[1],
        subject,
        verified.claims,
      );
      const user = await this.findOrCreateUser(subject, profile);
      if (!user.is_active) {
        throw new AppError(403, "ACCOUNT_INACTIVE", "This portal account is inactive.");
      }
      request.auth = {
        userId: user.id,
        oktaSubject: subject,
        email: user.email,
        displayName: user.display_name,
        createdAt: user.created_at,
        isAdmin: user.is_admin,
        tokenExpiresAt: expiresAt,
      };
      next();
    } catch (error) {
      if (!(error instanceof AppError)) {
        console.error("Okta user provisioning failed.", error);
      }
      next(
        error instanceof AppError
          ? error
          : new AppError(
              500,
              "IDENTITY_PROVISIONING_FAILED",
              "The portal could not create or load your user account.",
            ),
      );
    }
  };

  private async resolveProfile(
    accessToken: string,
    subject: string,
    claims: unknown,
  ): Promise<IdentityProfile> {
    const claimEmail = getIdentityEmail(claims);
    const claimDisplayName = getIdentityDisplayName(claims);
    const subjectEmail = identityEmailSchema.safeParse(subject);

    const linked = await this.pool.query<{
      email: string;
      display_name: string | null;
    }>("SELECT email, display_name FROM app_user WHERE okta_subject = $1", [
      subject,
    ]);
    const localProfile = linked.rows[0];

    let providerProfile: unknown = null;
    // A placeholder profile means a prior login did not expose the user's
    // Okta details. Keep attempting enrichment on later logins so the local
    // account is repaired as soon as Okta makes those claims available.
    if (
      !localProfile ||
      !localProfile.display_name ||
      isSyntheticEmail(localProfile.email)
    ) {
      try {
        const response = await fetch(`${this.config.OKTA_ISSUER}/v1/userinfo`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (response.ok) {
          const parsed = userInfoSchema.safeParse(await response.json());
          if (parsed.success) {
            // The access token is the verified identity source. Do not use a
            // userinfo response for enrichment when it identifies a different
            // subject, but do not reject the already verified token either.
            if (parsed.data.sub === subject) providerProfile = parsed.data;
          }
        }
      } catch (error) {
        if (error instanceof AppError) throw error;
      }
    }

    const providerEmail = getIdentityEmail(providerProfile);
    const providerDisplayName = getIdentityDisplayName(providerProfile);
    const email = (
      providerEmail ??
      claimEmail ??
      (subjectEmail.success ? subjectEmail.data : null) ??
      localProfile?.email ??
      fallbackEmailForSubject(subject)
    )
      .trim()
      .toLowerCase();
    const displayName =
      providerDisplayName ??
      claimDisplayName ??
      localProfile?.display_name ??
      fallbackDisplayName(email);

    return { email, displayName };
  }

  private async findOrCreateUser(subject: string, profile: IdentityProfile) {
    return withTransaction(this.pool, async (client) => {
      const candidates = await client.query<AppUserRow>(
        "SELECT * FROM app_user WHERE okta_subject = $1 OR lower(email) = $2 FOR UPDATE",
        [subject, profile.email],
      );
      const subjectUser = candidates.rows.find(
        (candidate) => candidate.okta_subject === subject,
      );
      const emailUser = candidates.rows.find(
        (candidate) => candidate.email.toLowerCase() === profile.email,
      );
      if (subjectUser && emailUser && subjectUser.id !== emailUser.id) {
        if (
          isSyntheticEmail(subjectUser.email) &&
          !emailUser.okta_subject &&
          (await this.canDiscardSyntheticUser(client, subjectUser.id))
        ) {
          await client.query("DELETE FROM app_user WHERE id = $1", [
            subjectUser.id,
          ]);
          const linked = await client.query<AppUserRow>(
            "UPDATE app_user SET okta_subject = $1, email = $2, display_name = $3, last_login_at = now(), updated_at = now() WHERE id = $4 RETURNING *",
            [subject, profile.email, profile.displayName, emailUser.id],
          );
          await ensureWorkspace(client, linked.rows[0].id);
          return linked.rows[0];
        }
        throw identityConflict();
      }

      let user: AppUserRow;
      if (subjectUser) {
        // A synthetic email is a placeholder produced when no usable email
        // was available at first login. Repair only that placeholder. For a
        // real, already-linked account, the portal remains the owner of its
        // profile fields; logging in must not overwrite them from Okta.
        if (isSyntheticEmail(subjectUser.email) && !isSyntheticEmail(profile.email)) {
          const updated = await client.query<AppUserRow>(
            "UPDATE app_user SET email = $1, last_login_at = now(), updated_at = now() WHERE id = $2 RETURNING *",
            [profile.email, subjectUser.id],
          );
          user = updated.rows[0];
        } else {
          user = subjectUser;
        }
      } else if (emailUser) {
        if (emailUser.okta_subject && emailUser.okta_subject !== subject) {
          throw identityConflict();
        }
        const linked = await client.query<AppUserRow>(
          "UPDATE app_user SET okta_subject = $1, last_login_at = now(), updated_at = now() WHERE id = $2 RETURNING *",
          [subject, emailUser.id],
        );
        user = linked.rows[0];
      } else {
        const created = await client.query<AppUserRow>(
          "INSERT INTO app_user (id, email, okta_subject, display_name, last_login_at) VALUES ($1, $2, $3, $4, now()) RETURNING *",
          [randomUUID(), profile.email, subject, profile.displayName],
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

  private async canDiscardSyntheticUser(client: PoolClient, userId: string) {
    const [uploads, executions] = await Promise.all([
      client.query(
        "SELECT 1 FROM uploads JOIN workspaces ON workspaces.id = uploads.workspace_id WHERE workspaces.user_id = $1 LIMIT 1",
        [userId],
      ),
      client.query(
        "SELECT 1 FROM processing_pipeline_step_function_executions WHERE started_by_user_id = $1 LIMIT 1",
        [userId],
      ),
    ]);
    return !uploads.rows[0] && !executions.rows[0];
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
      if (!user.is_active) {
        throw new AppError(403, "ACCOUNT_INACTIVE", "This portal account is inactive.");
      }
      request.auth = {
        userId: user.id,
        oktaSubject: temporaryAuthSubject,
        email: user.email,
        displayName: user.display_name,
        createdAt: user.created_at,
        isAdmin: user.is_admin,
        tokenExpiresAt: new Date("2999-12-31T23:59:59.999Z"),
      };
      next();
    } catch (error) {
      next(error);
    }
  };

  private async findOrCreateUser() {
    return withTransaction(this.pool, async (client) => {
      const existing = await client.query<AppUserRow>(
        "SELECT * FROM app_user WHERE lower(email) = $1 FOR UPDATE",
        [temporaryAuthEmail],
      );
      const user =
        existing.rows[0] ??
        (
          await client.query<AppUserRow>(
            "INSERT INTO app_user (id, email, password_hash) VALUES ($1, $2, $3) RETURNING *",
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
