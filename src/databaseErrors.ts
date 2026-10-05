import type { Config } from "./config.js";

type ErrorLike = {
  name?: unknown;
  message?: unknown;
  stack?: unknown;
  code?: unknown;
  syscall?: unknown;
  address?: unknown;
  port?: unknown;
  severity?: unknown;
  detail?: unknown;
  hint?: unknown;
  routine?: unknown;
};

const networkErrorCodes = new Set([
  "ETIMEDOUT",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNRESET",
]);

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function diagnosisFor(code: string | undefined, message: string) {
  const normalizedMessage = message.toLowerCase();
  if (code === "ETIMEDOUT")
    return "Timed out opening a TCP connection to PostgreSQL. Check pod egress, Kubernetes NetworkPolicy, firewall or security-group rules, and routes to the database subnet.";
  if (code === "ECONNREFUSED")
    return "The database host was reachable but rejected the TCP connection. Confirm the PostgreSQL listener and configured port.";
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH")
    return "No network route to the database is available. Check VPC, subnet, peering, transit-gateway, and return-route configuration.";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN")
    return "The database hostname could not be resolved. Check DNS and DATABASE_HOST.";
  if (code === "ECONNRESET")
    return "The database connection was reset. Check the database listener, network devices, and TLS policy.";
  if (code === "28P01")
    return "PostgreSQL rejected the supplied username or password.";
  if (code === "28000" || normalizedMessage.includes("pg_hba.conf"))
    return normalizedMessage.includes("no encryption")
      ? "PostgreSQL pg_hba.conf rejected an unencrypted connection. Enable DATABASE_SSL or add an approved non-TLS host rule."
      : "PostgreSQL pg_hba.conf rejected this client, user, database, or connection mode. Review the server access rule.";
  if (
    normalizedMessage.includes("certificate") ||
    normalizedMessage.includes("ssl") ||
    normalizedMessage.includes("tls")
  )
    return "PostgreSQL TLS negotiation failed. Check DATABASE_SSL and the server certificate or TLS policy.";
  return "PostgreSQL returned an error. Use the error code, severity, detail, and hint to identify the server-side cause.";
}

export type DatabaseErrorDiagnostics = Record<string, unknown> & {
  databaseError: true;
  diagnosis: string;
};

function hasDatabaseErrorSignature(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as ErrorLike;
  const code = stringField(candidate.code);
  const stack = stringField(candidate.stack) ?? "";
  return (
    /(?:pg-pool|node_modules[\\/]pg|postgres)/i.test(stack) ||
    typeof candidate.severity === "string" ||
    typeof candidate.routine === "string" ||
    (code !== undefined && /^[0-9A-Z]{5}$/.test(code))
  );
}

/**
 * Returns sanitized PostgreSQL diagnostics when an error can be confidently
 * associated with the configured database. Passwords are never included.
 */
export function getDatabaseErrorDiagnostics(
  error: unknown,
  config: Config,
): DatabaseErrorDiagnostics | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as ErrorLike;
  const code = stringField(candidate.code);
  const message = stringField(candidate.message) ?? String(error);
  const stack = stringField(candidate.stack);
  const port = numberField(candidate.port);
  const isPostgresStack = stack
    ? /(?:pg-pool|node_modules[\\/]pg|postgres)/i.test(stack)
    : false;
  const isPostgresServerError = hasDatabaseErrorSignature(error);
  const isConfiguredConnectionError =
    code !== undefined &&
    networkErrorCodes.has(code) &&
    (isPostgresStack || port === config.DATABASE_PORT);

  if (
    !isPostgresStack &&
    !isPostgresServerError &&
    !isConfiguredConnectionError
  )
    return undefined;

  return {
    databaseError: true,
    diagnosis: diagnosisFor(code, message),
    errorName: stringField(candidate.name),
    errorCode: code,
    errorMessage: message,
    errorStack: stack,
    syscall: stringField(candidate.syscall),
    remoteAddress: stringField(candidate.address) ?? config.DATABASE_HOST,
    remotePort: port ?? config.DATABASE_PORT,
    databaseHost: config.DATABASE_HOST,
    databasePort: config.DATABASE_PORT,
    databaseName: config.DATABASE_NAME,
    databaseUser: config.DATABASE_USER,
    databaseSsl: config.DATABASE_SSL,
    severity: stringField(candidate.severity),
    detail: stringField(candidate.detail),
    hint: stringField(candidate.hint),
    routine: stringField(candidate.routine),
  };
}
