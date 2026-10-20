import type { Request, RequestHandler } from "express";
import cors from "cors";
import helmet from "helmet";
import hpp from "hpp";
import permissionsPolicy from "permissions-policy";
import { rateLimit } from "express-rate-limit";
import { type Config, corsAllowedOrigins } from "../config.js";
import { AppError } from "../errors.js";

const allowedOrigins = new Set(corsAllowedOrigins);

const globalRateLimitPolicy = {
  limit: 20_000,
  windowSeconds: 60,
};

export function createCorsMiddleware(): RequestHandler {
  return cors<Request>((request, callback) => {
    const origin = request.get("Origin");
    let ownOrigin: string | undefined;
    try {
      // Use the actual Host, not X-Forwarded-Host. Browser clients cannot forge Host.
      // This permits same-origin Swagger POSTs without opening cross-origin access.
      const host = request.get("Host");
      if (host) ownOrigin = new URL(`${request.protocol}://${host}`).origin;
    } catch {
      /* Invalid Host never grants an origin exception. */
    }
    if (
      origin !== undefined &&
      !allowedOrigins.has(origin) &&
      origin !== ownOrigin
    ) {
      return callback(
        new AppError(
          403,
          "CORS_ORIGIN_DENIED",
          "This browser origin is not allowed.",
        ),
      );
    }
    // curl/probes may have no Origin. CORS is not authentication.
    callback(null, {
      origin: origin ?? true,
      credentials: true,
      methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: [
        "Authorization",
        "Content-Type",
        "Accept",
        "X-Requested-With",
      ],
      maxAge: 600,
      // Continue so preflight receives rate-limit headers as well; terminate before auth/DB.
      preflightContinue: true,
    });
  });
}

/** Per-process outer guard for all routes, including DB-independent probes/docs.
 * Existing PostgreSQL-backed feature quotas remain the stricter shared guard.
 */
export function createGlobalRateLimiter(
  policy = globalRateLimitPolicy,
): RequestHandler {
  return rateLimit({
    windowMs: policy.windowSeconds * 1000,
    limit: policy.limit,
    standardHeaders: "draft-6",
    legacyHeaders: true,
    message: {
      error: {
        code: "RATE_LIMITED",
        message: "Too many requests. Please try again later.",
      },
    },
  });
}

export const completeCorsPreflight: RequestHandler = (
  request,
  response,
  next,
) => {
  if (request.method !== "OPTIONS") return next();
  response.status(204).end();
};

export function createSecurityHeaders(config: Config): RequestHandler {
  const production = config.NODE_ENV === "production";
  const headers = helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        scriptSrcAttr: ["'none'"],
        // Swagger's static template and UI use inline CSS, not inline scripts.
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        fontSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        frameAncestors: ["'self'"],
        upgradeInsecureRequests: production ? [] : null,
      },
    },
    xFrameOptions: { action: "sameorigin" },
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    strictTransportSecurity: production
      ? {
          maxAge: 31_536_000,
          includeSubDomains: true,
          // Preloading is a site-owner commitment. Keep it code-reviewed and off
          // until every subdomain is permanently served over HTTPS.
          preload: false,
        }
      : false,
  });
  const permissions = permissionsPolicy({
    features: {
      geolocation: [],
      camera: [],
      microphone: [],
      fullscreen: ["self"],
    },
  });
  return (request, response, next) =>
    headers(request, response, (error?: unknown) => {
      if (error) return next(error);
      permissions(request, response, () => {
        // Explicit legacy ISDP compatibility requirement from the supplied example.
        // Modern browsers rely on CSP; this is not a replacement for XSS prevention.
        response.set("X-XSS-Protection", "1; mode=block");
        next();
      });
    });
}

/** Express 5 query is a getter returning a fresh parsed object. Materialize it
 * once before HPP, then reject ambiguity rather than silently choosing a value.
 * JSON arrays are not form pollution; multipart scalar fields retain Zod validation.
 */
export function createHppMiddleware(): RequestHandler {
  const protect = hpp();
  return (request, response, next) => {
    const query = request.query;
    Object.defineProperty(request, "query", {
      value: query,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    const repeatedQuery = Object.values(query).some(Array.isArray);
    const repeatedForm =
      request.is("application/x-www-form-urlencoded") &&
      request.body &&
      typeof request.body === "object" &&
      Object.values(request.body).some(Array.isArray);
    protect(request, response, (error?: unknown) => {
      if (error) return next(error);
      if (repeatedQuery || repeatedForm)
        return next(
          new AppError(
            400,
            "HTTP_PARAMETER_POLLUTION",
            "Repeated query or form parameters are not allowed.",
          ),
        );
      next();
    });
  };
}
