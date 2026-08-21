import type { RequestHandler } from "express";
import { z } from "zod";
import type { AuthService } from "../application/authService.js";

const passwordSchema = z.string().min(12).max(256);

export function createAuthController(service: AuthService): {
  login: RequestHandler;
  logout: RequestHandler;
  me: RequestHandler;
  changePassword: RequestHandler;
} {
  return {
    login: async (request, response) => {
      const body = z
        .object({ email: z.string().email(), password: z.string().min(1) })
        .parse(request.body);
      response.json(await service.login(body.email, body.password));
    },
    logout: (_request, response) => response.status(204).end(),
    me: async (request, response) => {
      response.json({
        user: await service.getCurrentUser(request.auth!.userId),
      });
    },
    changePassword: async (request, response) => {
      const body = z
        .object({
          currentPassword: z.string().min(1),
          newPassword: passwordSchema,
        })
        .parse(request.body);
      response.json(
        await service.changePassword(
          request.auth!.userId,
          body.currentPassword,
          body.newPassword,
        ),
      );
    },
  };
}
