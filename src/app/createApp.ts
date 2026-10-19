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

  app.disable("x-powered-by");
  app.set("trust proxy", dependencies.config.TRUST_PROXY_HOPS);
  app.set("query parser", "simple");
  app.use(createSecurityHeaders(dependencies.config));
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

  // Keep operational documentation available while PostgreSQL is unavailable.
  // Database-backed feature routes remain behind the PostgreSQL rate limiter.
  registerPublicRoutes(app, dependencies);

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
