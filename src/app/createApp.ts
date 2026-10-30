import {
  requestAudit,
  requestContext,
  securityAudit,
} from "../platform/requestAudit.js";
import { AppError } from "../errors.js";
import { MAX_UPLOAD_BYTES } from "../uploadLimits.js";
import express, { type Express, type RequestHandler } from "express";
import multer from "multer";
import swaggerUi from "swagger-ui-express";
import type { AppDependencies } from "./dependencies.js";
import { createErrorHandler, notFound } from "../errors.js";
import { createOpenApiDocument } from "../openapi.js";
import { createAuthRouter } from "../modules/auth/api/router.js";
import { createAdminRouter } from "../modules/auth/api/adminRouter.js";
import { createPrepaidRouter } from "../modules/prepaid/api/router.js";
import { createProcessingPipelinesRouter } from "../modules/processing-pipelines/api/router.js";
import {
  clientIpKey,
  createRateLimitMiddleware,
  publicApiPolicy,
} from "./security.js";
import {
  createSecurityHeaders,
  createCorsMiddleware,
  createGlobalRateLimiter,
  completeCorsPreflight,
  createHppMiddleware,
} from "./httpSecurity.js";
/** Build the Express app without opening a network port. */
export function createApplication(dependencies: AppDependencies): Express {
  const app = express();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_BYTES + 1, files: 1 },
  });
  const parseSingleFile = upload.single("file");
  const singleFileUpload: RequestHandler = (request, response, next) => {
    parseSingleFile(request, response, (error) => {
      if (error) return next(error);
      if (request.file && request.file.size > MAX_UPLOAD_BYTES)
        return next(
          Object.assign(new Error("File too large"), {
            code: "LIMIT_FILE_SIZE",
          }),
        );
      next();
    });
  };

  if (
    dependencies.config.NODE_ENV === "production" &&
    /--inspect|--debug/.test(
      [...process.execArgv, process.env.NODE_OPTIONS ?? ""].join(" "),
    )
  )
    throw new Error("Debug startup is disabled in production.");
  const originalAuthenticate = dependencies.authenticate;
  dependencies = {
    ...dependencies,
    authenticate: (request, response, next) => {
      originalAuthenticate(request, response, (error?: unknown) => {
        if (error) return next(error);
        const context = requestContext.getStore();
        if (context) context.userId = request.auth?.userId;
        if (/^\/api\/auth\/me\/?$/i.test(request.originalUrl.split("?")[0])) {
          void securityAudit(dependencies.pool, "auth.session_validated").then(
            () => next(),
            next,
          );
        } else next();
      });
    },
  };
  app.disable("x-powered-by");
  app.set("trust proxy", dependencies.config.TRUST_PROXY_HOPS);
  app.set("query parser", "simple");
  app.use(requestAudit(dependencies.logger, dependencies.config));
  app.use(createSecurityHeaders(dependencies.config));
  app.use((request, response, next) => {
    if (
      ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(
        request.method,
      )
    )
      return next();
    response.set("Allow", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS");
    next(
      new AppError(
        405,
        "METHOD_NOT_ALLOWED",
        "This request method is not supported.",
      ),
    );
  });
  app.use(createCorsMiddleware());
  app.use(createGlobalRateLimiter());
  app.use(completeCorsPreflight);
  app.use(express.json({ limit: "128kb" }));
  app.use(
    express.urlencoded({
      extended: false,
      limit: "128kb",
      parameterLimit: 100,
    }),
  );
  app.use(createHppMiddleware());
  app.get("/api/healthz", (_request, response) => {
    response.status(200).json("The pod is healthy");
  });

  app.get("/api/readyz", async (_request, response) => {
    try {
      if (dependencies.startupReady && !dependencies.startupReady()) {
        response.status(503).json({ ready: false });
        return;
      }
      const result = await dependencies.pool.query<{ ready: boolean }>({
        text: `SELECT
        (SELECT count(*) = 3 FROM pg_attribute WHERE attrelid = to_regclass('security_audit_events') AND attname IN ('action_outcome','access_port','environment') AND NOT attisdropped)
        AND has_table_privilege(to_regclass('security_audit_events'), 'INSERT') AS ready`,
        query_timeout: 2000,
      } as import("pg").QueryConfig & { query_timeout: number });
      response
        .status(result.rows[0]?.ready === true ? 200 : 503)
        .json({ ready: result.rows[0]?.ready === true });
    } catch {
      response.status(503).json({ ready: false });
    }
  });

  // Keep operational documentation available while PostgreSQL is unavailable.
  // Database-backed feature routes remain behind the PostgreSQL rate limiter.
  registerPublicRoutes(app, dependencies);

  app.use("/api", (_request, response, next) => {
    if (!dependencies.startupReady || dependencies.startupReady())
      return next();
    response
      .status(503)
      .json({
        error: {
          code: "DATABASE_NOT_READY",
          message: "The service is initializing. Please try again shortly.",
        },
      });
  });

  app.use(
    "/api",
    createRateLimitMiddleware(
      dependencies.rateLimiter,
      publicApiPolicy,
      clientIpKey,
    ),
  );

  registerFeatureRoutes(app, dependencies, singleFileUpload);

  app.use(notFound);
  app.use(createErrorHandler(dependencies.logger, dependencies.config));
  return app;
}

function registerPublicRoutes(app: Express, { config }: AppDependencies) {
  const openApiDocument = createOpenApiDocument(
    config.OPENAPI_INCLUDE_NON_ESSENTIAL_ENDPOINTS,
  );
  app.get("/", (_request, response) => response.redirect("/api/docs/"));
  app.get("/api/openapi.json", (_request, response) =>
    response.json(openApiDocument),
  );
  app.use(
    "/api/docs",
    swaggerUi.serve,
    swaggerUi.setup(openApiDocument, {
      customSiteTitle: "Web Portal API Documentation",
      swaggerOptions: { persistAuthorization: false, validatorUrl: null },
    }),
  );
}

function registerFeatureRoutes(
  app: Express,
  dependencies: AppDependencies,
  singleFileUpload: RequestHandler,
) {
  app.use("/api/auth", createAuthRouter(dependencies));
  app.use("/api/admin", createAdminRouter(dependencies));
  app.use("/api/workflows/prepaid", createPrepaidRouter(dependencies));
  app.use(
    "/api/processing-pipelines",
    createProcessingPipelinesRouter(dependencies, singleFileUpload),
  );
}
