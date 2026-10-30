import { requestContext } from "./requestAudit.js";
export type Logger = {
  info(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
};
// Structured allowlist prevents arbitrary error objects, SQL rows, credentials,
// payloads and URLs from reaching container collectors.
const allowed = new Set([
  "migrationId",
  "environment",
  "sessionCorrelationType",
  "phase",
  "actionOutcome",
  "changedFields",
  "resourceId",
  "requestId",
  "sourceIp",
  "method",
  "port",
  "userId",
  "actorUserId",
  "targetUserId",
  "sessionId",
  "route",
  "status",
  "outcome",
  "reason",
  "durationMs",
  "userAgent",
  "referrer",
  "eventId",
  "action",
  "moduleId",
  "pipelineCode",
  "runId",
  "region",
  "frozen",
  "replaced",
  "removedCount",
  "isActive",
  "isAdmin",
  "persistence",
  "errorCode",
  "errorName",
  "databaseError",
  "databaseHost",
  "databasePort",
  "databaseName",
  "databaseSchema",
  "databaseUser",
  "databaseSsl",
  "remoteAddress",
  "remotePort",
  "syscall",
  "severity",
  "routine",
  "startupPhase",
  "connectionTimeoutMs",
  "apiStartupContinues",
]);
export function sanitizeLogFields(fields: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(fields)
      .filter(
        ([key, value]) =>
          allowed.has(key) &&
          value !== undefined &&
          ["string", "number", "boolean"].includes(typeof value),
      )
      .map(([key, value]) => [
        key,
        typeof value === "string"
          ? value
              .slice(0, 512)
              .replace(/[\r\n\u0000-\u001f]/g, " ")
              .replace(
                /Bearer\s+\S+|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
                "[redacted]",
              )
          : value,
      ]),
  );
}
function write(
  level: "info" | "error",
  event: string,
  fields: Record<string, unknown> = {},
) {
  const context = requestContext.getStore();
  try {
    const entry = JSON.stringify({
      ...sanitizeLogFields({
        ...fields,
        ...(context ? { environment: context.environment } : {}),
      }),
      ...(context ? { requestId: context.requestId } : {}),
      level,
      event: event.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 128),
      timestamp: new Date().toISOString(),
    });
    if (level === "error") console.error(entry);
    else console.log(entry);
  } catch {
    /* Logging cannot replace a business response with another error. */
  }
}
export function createLogger(): Logger {
  return {
    info: (event, fields) => write("info", event, fields),
    error: (event, fields) => write("error", event, fields),
  };
}
