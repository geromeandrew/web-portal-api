import express, { type Express, type RequestHandler } from "express";
import multer from "multer";
import swaggerUi from "swagger-ui-express";
import type { AppDependencies } from "./dependencies.js";
import { errorHandler, notFound } from "../errors.js";
import { createOpenApiDocument } from "../openapi.js";
import { createAuthRouter } from "../modules/auth/api/router.js";
import { createUsersRouter } from "../modules/users/api/router.js";
import { createUploadsRouter } from "../modules/uploads/api/router.js";
import { createPrepaidRouter } from "../modules/prepaid/api/router.js";
import { createMemoRouter } from "../modules/memo/api/router.js";
import { createProcessingPipelinesRouter } from "../modules/processing-pipelines/api/router.js";
/** Build the Express app without opening a network port. */
export function createApplication(dependencies: AppDependencies): Express {
  const app = express();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: dependencies.config.MAX_UPLOAD_BYTES, files: 1 },
  });
  const singleFileUpload = upload.single("file");

  app.disable("x-powered-by");
  app.use(express.json({ limit: "128kb" }));

  registerPublicRoutes(app, dependencies);
  registerFeatureRoutes(app, dependencies, singleFileUpload);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

function registerPublicRoutes(app: Express, { pool, config }: AppDependencies) {
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
  app.get("/api/healthz", async (_request, response) => {
    await pool.query("SELECT 1");
    response.json({ status: "ok" });
  });
}

function registerFeatureRoutes(
  app: Express,
  dependencies: AppDependencies,
  singleFileUpload: RequestHandler,
) {
  app.use("/api/auth", createAuthRouter(dependencies));
  app.use("/api/admin/users", createUsersRouter(dependencies));
  app.use("/api/uploads", createUploadsRouter(dependencies, singleFileUpload));
  app.use("/api/workflows/prepaid", createPrepaidRouter(dependencies));
  app.use("/api/workflows/memo", createMemoRouter(dependencies));
  app.use(
    "/api/processing-pipelines",
    createProcessingPipelinesRouter(dependencies, singleFileUpload),
  );
}
