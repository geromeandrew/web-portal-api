import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import type { Config } from "./config.js";
import { getDatabaseErrorDiagnostics } from "./databaseErrors.js";
import type { Logger } from "./platform/logger.js";

export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fields?: Record<string, string>,
  ) {
    super(message);
  }
}

export const notFound: RequestHandler = (_request, _response, next) =>
  next(
    new AppError(404, "NOT_FOUND", "The requested API route was not found."),
  );

export const createErrorHandler =
  (logger: Logger, config: Config): ErrorRequestHandler =>
  (error, request, response, _next) => {
    if (error instanceof ZodError) {
      response.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: "The request contains invalid data.",
        },
      });
      return;
    }
    if (error instanceof AppError) {
      response.status(error.status).json({
        error: {
          code: error.code,
          message: error.message,
          ...(error.fields ? { fields: error.fields } : {}),
        },
      });
      return;
    }
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "LIMIT_FILE_SIZE"
    ) {
      response.status(413).json({
        error: {
          code: "FILE_TOO_LARGE",
          message: "The uploaded file exceeds the configured size limit.",
        },
      });
      return;
    }
    const databaseDiagnostics = getDatabaseErrorDiagnostics(error, config);
    logger.error(
      databaseDiagnostics ? "database.request_failed" : "api.request_failed",
      {
        method: request.method,
        path: request.originalUrl.split("?", 1)[0],
        ...(databaseDiagnostics ?? {
          errorName: error instanceof Error ? error.name : undefined,
          errorMessage: error instanceof Error ? error.message : String(error),
          errorStack: error instanceof Error ? error.stack : undefined,
        }),
      },
    );
    if (databaseDiagnostics) {
      response.status(503).json({
        error: {
          code: "DATABASE_UNAVAILABLE",
          message: "The database is temporarily unavailable.",
        },
      });
      return;
    }
    response.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected server error occurred.",
      },
    });
  };
