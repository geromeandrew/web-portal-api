import { classifyAuditRoute } from "./auditRoutes.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, randomUUID } from "node:crypto";
import type { RequestHandler } from "express";
import type { Pool, PoolClient } from "pg";
import type { Config } from "../config.js";
import type { Logger } from "./logger.js";

type Context = {
  requestId: string;
  sourceIp: string;
  method: string;
  port: number | undefined;
  sessionId?: string;
  sessionCorrelationType?: "token" | "okta-session";
  environment?: string;
  userId?: string;
  reason?: string;
  events: Record<string, unknown>[];
  completedAudit?: (event: Record<string, unknown>) => void;
  logger: Logger;
  auditSecret?: string;
};
export const requestContext = new AsyncLocalStorage<Context>();
// Keep uncommitted facts private to their DB connection, including on disconnect.
export const transactionAuditEvents = new WeakMap<
  object,
  Record<string, unknown>[]
>();
export function publishAuditEvent(event: Record<string, unknown>) {
  const context = requestContext.getStore();
  if (!context) return;
  if (context.completedAudit) context.completedAudit(event);
  else context.events.push(event);
}

export function fingerprint(value: string, secret: string) {
  return createHmac("sha256", secret)
    .update(`security-audit:${value}`)
    .digest("hex");
}
export function requestAudit(logger: Logger, config: Config): RequestHandler {
  return (request, response, next) => {
    const token = request.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
    const context: Context = {
      requestId: randomUUID(),
      sourceIp: request.ip ?? request.socket.remoteAddress ?? "unknown",
      method: request.method,
      port: request.socket.localPort,
      events: [],
      logger,
      auditSecret: config.RATE_LIMIT_HMAC_SECRET,
      sessionCorrelationType: token ? "token" : undefined,
      ...(token
        ? { sessionId: fingerprint(token, config.RATE_LIMIT_HMAC_SECRET) }
        : {}),
    };
    response.set("X-Request-ID", context.requestId);
    const route = classifyAuditRoute(request.method, request.path);
    const started = performance.now();
    let recorded = false;
    const complete = (aborted: boolean) => {
      if (recorded) return;
      recorded = true;
      let referrer: string | undefined;
      try {
        const url = new URL(request.get("referer") ?? "");
        if (["https:", "http:"].includes(url.protocol)) referrer = url.origin;
      } catch {
        /* No valid referrer. */
      }
      const fields = {
        requestId: context.requestId,
        sourceIp: context.sourceIp,
        method: context.method,
        port: context.port,
        userId: request.auth?.userId ?? context.userId,
        sessionId: context.sessionId,
        sessionCorrelationType: context.sessionCorrelationType,
        environment: context.environment,
        route: route?.path ?? request.route?.path ?? "unmatched",
        status: aborted ? undefined : response.statusCode,
        outcome: aborted
          ? "aborted"
          : response.statusCode === 207
            ? "partial"
            : response.statusCode === 401 || response.statusCode === 403
              ? "denied"
              : response.statusCode >= 400
                ? "failure"
                : "success",
        reason: context.reason,
        durationMs: Math.round(performance.now() - started),
        userAgent:
          request
            .get("user-agent")
            ?.match(
              /(?:Edg|Chrome|Firefox|Version|curl|node)[\/ ]?[0-9.]*/i,
            )?.[0] ?? "other",
        referrer,
        resourceId:
          typeof request.query.key === "string"
            ? fingerprint(request.query.key, config.RATE_LIMIT_HMAC_SECRET)
            : undefined,
      };
      logger.info("http.access", fields);
      if (context.reason || response.statusCode === 429)
        logger.info("security.rejection", {
          ...fields,
          reason: context.reason ?? "RATE_LIMITED",
        });
      if (route)
        logger.info("security.action", {
          ...fields,
          eventId: randomUUID(),
          action: route.action,
          phase: "result",
          ...(route.action.endsWith(".transfer")
            ? {
                actionOutcome: aborted
                  ? "aborted"
                  : response.statusCode >= 400
                    ? "failure"
                    : "server_completed",
              }
            : {}),
        });
      context.completedAudit = (event) =>
        logger.info("security.audit", {
          ...fields,
          userId: context.userId ?? fields.userId,
          sessionId: context.sessionId,
          sessionCorrelationType: context.sessionCorrelationType,
          ...event,
        });
      for (const event of context.events) context.completedAudit(event);
      context.events.length = 0;
    };
    response.once("finish", () => complete(false));
    response.once("close", () => complete(!response.writableFinished));
    requestContext.run(context, next);
  };
}

/** Only explicit identifiers/flags are copied; never mirror transaction bodies. */
export async function securityAudit(
  db: Pool | PoolClient,
  action: string,
  metadata: Record<string, unknown> = {},
  strict = false,
) {
  const context = requestContext.getStore();
  if (!context) {
    if (strict) throw new Error("Mandatory audit context is unavailable.");
    return;
  }
  const detail = Object.fromEntries(
    Object.entries(metadata).filter(
      ([key, value]) =>
        [
          "resourceId",
          "actionOutcome",
          "changedFields",
          "actorUserId",
          "targetUserId",
          "moduleId",
          "pipelineCode",
          "runId",
          "region",
          "frozen",
          "replaced",
          "removedCount",
          "isActive",
          "isAdmin",
        ].includes(key) &&
        ["string", "boolean", "number"].includes(typeof value),
    ),
  );
  if (typeof metadata.objectKey === "string")
    detail.resourceId = fingerprint(
      metadata.objectKey,
      context.auditSecret ?? context.requestId,
    );
  const actionOutcome =
    typeof detail.actionOutcome === "string"
      ? detail.actionOutcome
      : action === "file.read"
        ? "attempt"
        : "success";
  const event = { eventId: randomUUID(), action, ...detail, actionOutcome };
  try {
    await db.query(
      `INSERT INTO security_audit_events (id, request_id, actor_user_id, source_ip, method, session_id, action, detail, action_outcome, access_port, environment)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        event.eventId,
        context.requestId,
        context.userId ?? null,
        context.sourceIp,
        context.method,
        context.sessionId ?? null,
        action,
        JSON.stringify(detail),
        actionOutcome,
        context.port ?? null,
        context.environment ?? "unknown",
      ],
    );
    const pending = transactionAuditEvents.get(db);
    if (pending) pending.push(event);
    else publishAuditEvent(event);
  } catch (error) {
    context.logger.error("security.audit_write_failed", {
      requestId: context.requestId,
      action,
      userId: context.userId,
    });
    if (strict) throw error;
    publishAuditEvent({ ...event, persistence: "failed" });
  }
}

/** Record an irreversible remote effect before later bookkeeping can fail.
 * This stream event does not claim delivery to Splunk or client receipt. */
export function recordSecurityEffect(
  action: string,
  metadata: {
    pipelineCode: string;
    runId?: string;
    objectKey?: string;
  },
) {
  const context = requestContext.getStore();
  if (!context) return;
  context.logger.info("security.effect", {
    eventId: randomUUID(),
    requestId: context.requestId,
    userId: context.userId,
    sourceIp: context.sourceIp,
    method: context.method,
    port: context.port,
    sessionId: context.sessionId,
    sessionCorrelationType: context.sessionCorrelationType,
    environment: context.environment,
    action,
    actionOutcome: "success",
    phase: "effect",
    pipelineCode: metadata.pipelineCode,
    runId: metadata.runId,
    resourceId: metadata.objectKey
      ? fingerprint(
          metadata.objectKey,
          context.auditSecret ?? context.requestId,
        )
      : undefined,
  });
}
