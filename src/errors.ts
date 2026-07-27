import type { ErrorRequestHandler, RequestHandler } from "express";

export class AppError extends Error {
  constructor(public status: number, public code: string, message: string, public fields?: Record<string, string>) {
    super(message);
  }
}

export const notFound: RequestHandler = (_request, _response, next) => next(new AppError(404, "NOT_FOUND", "The requested API route was not found."));

export const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  if (error instanceof AppError) {
    response.status(error.status).json({ error: { code: error.code, message: error.message, ...(error.fields ? { fields: error.fields } : {}) } });
    return;
  }
  if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "LIMIT_FILE_SIZE") {
    response.status(413).json({ error: { code: "FILE_TOO_LARGE", message: "The uploaded file exceeds the configured size limit." } });
    return;
  }
  console.error(error);
  response.status(500).json({ error: { code: "INTERNAL_ERROR", message: "An unexpected server error occurred." } });
};
