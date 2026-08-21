import type { RequestHandler } from "express";
import { z } from "zod";
import type { UserService } from "../application/userService.js";

const passwordSchema = z.string().min(12).max(256);

export function createUsersController(service: UserService): {
  list: RequestHandler;
  create: RequestHandler;
  update: RequestHandler;
} {
  return {
    list: async (_request, response) => {
      response.json({ users: await service.list() });
    },
    create: async (request, response) => {
      const body = z
        .object({
          email: z.string().email(),
          temporaryPassword: passwordSchema,
        })
        .parse(request.body);
      response.status(201).json({
        user: await service.create(body.email, body.temporaryPassword),
      });
    },
    update: async (request, response) => {
      const body = z
        .object({
          isActive: z.boolean().optional(),
          temporaryPassword: passwordSchema.optional(),
        })
        .refine(
          (value) =>
            value.isActive !== undefined ||
            value.temporaryPassword !== undefined,
        )
        .parse(request.body);
      response.json({
        user: await service.update(
          z.string().parse(request.params.id),
          request.auth!.userId,
          body,
        ),
      });
    },
  };
}
