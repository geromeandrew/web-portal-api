import express, { type Express, type RequestHandler } from "express";
import multer from "multer";
import swaggerUi from "swagger-ui-express";
import type { AppDependencies } from "./dependencies.js";
import { errorHandler, notFound } from "../errors.js";
import { createOpenApiDocument } from "../openapi.js";
import { createAuthRouter } from "../modules/auth/api/router.js";
import { createAdminRouter } from "../modules/auth/api/adminRouter.js";
import { createPrepaidRouter } from "../modules/prepaid/api/router.js";
import { createProcessingPipelinesRouter } from "../modules/processing-pipelines/api/router.js";
import {
  clientIpKey,
  createRateLimitMiddleware,
  createSecurityHeaders,
  publicApiPolicy,
} from "./security.js";
/** Build the Express app without opening a network port. */
export function createApplication(dependencies: AppDependencies): Express {
  const app = express();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: dependencies.config.MAX_UPLOAD_BYTES, files: 1 },
  });
  const singleFileUpload = upload.single("file");

  app.disable("x-powered-by");
  app.set("trust proxy", dependencies.config.TRUST_PROXY_HOPS);
  app.use(createSecurityHeaders(dependencies.config));
  app.use(express.json({ limit: "128kb" }));
  app.get("/api/healthz", (_request, response) => {
    response.status(200).json("The pod is healthy");
  });
  app.use(
    "/api",
    createRateLimitMiddleware(
      dependencies.rateLimiter,
      publicApiPolicy,
      clientIpKey,
    ),
  );

  registerPublicRoutes(app, dependencies);
  registerFeatureRoutes(app, dependencies, singleFileUpload);

  app.use(notFound);
  app.use(errorHandler);
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
      swaggerOptions: { persistAuthorization: false },
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
