import type { RequestHandler } from "express";
import { z } from "zod";
import { AppError } from "../../../errors.js";
import type { UploadService } from "../application/uploadService.js";

const uploadSchema = z.object({
  workflow: z.enum(["prepaid", "memo", "aprm"]),
  slot: z.string().min(1).max(160).optional(),
});

export function createUploadsController(service: UploadService): {
  create: RequestHandler;
  remove: RequestHandler;
} {
  return {
    create: async (request, response) => {
      if (!request.file) {
        throw new AppError(400, "FILE_REQUIRED", "Choose a file to upload.");
      }
      const input = uploadSchema.parse(request.body);
      response.status(201).json({
        upload: await service.create(request.auth!.userId, request.file, input),
      });
    },
    remove: async (request, response) => {
      await service.remove(
        request.auth!.userId,
        z.string().parse(request.params.id),
      );
      response.status(204).end();
    },
  };
}
