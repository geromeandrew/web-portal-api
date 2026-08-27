import type { RequestHandler } from "express";
import { z } from "zod";
import type { AuthService } from "../application/authService.js";
import type { Config } from "../../../config.js";
import { AppError } from "../../../errors.js";

const passwordSchema = z.string().min(12).max(256);

export function createAuthController(
  service: AuthService,
  config: Config,
): {
  login: RequestHandler;
  refresh: RequestHandler;
  logout: RequestHandler;
  me: RequestHandler;
  changePassword: RequestHandler;
} {
  return {
    login: async (request, response) => {
      const body = z
        .object({ email: z.string().email(), password: z.string().min(1) })
        .parse(request.body);
      const result = await service.login(body.email, body.password);
      setRefreshCookie(response, result.refreshToken, config);
      response.json({ accessToken: result.accessToken, user: result.user });
    },
    refresh: async (request, response) => {
      const refreshToken = request.cookies?.portal_refresh;
      if (typeof refreshToken !== "string")
        throw new AppError(401, "UNAUTHENTICATED", "Sign in is required.");
      const result = await service.refresh(refreshToken);
      setRefreshCookie(response, result.refreshToken, config);
      response.json({ accessToken: result.accessToken, user: result.user });
    },
    logout: async (request, response) => {
      await service.logout(request.auth!);
      response.clearCookie("portal_refresh", refreshCookieOptions(config));
      response.status(204).end();
    },
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
      const result = await service.changePassword(
        request.auth!.userId,
        body.currentPassword,
        body.newPassword,
      );
      setRefreshCookie(response, result.refreshToken, config);
      response.json({ accessToken: result.accessToken, user: result.user });
    },
  };
}

function refreshCookieOptions(config: Config) {
  return {
    httpOnly: true,
    sameSite: "strict" as const,
    secure: config.NODE_ENV === "production",
    path: "/api/auth",
  };
}

function setRefreshCookie(
  response: Parameters<RequestHandler>[1],
  refreshToken: string,
  config: Config,
) {
  response.cookie("portal_refresh", refreshToken, {
    ...refreshCookieOptions(config),
    maxAge: config.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1_000,
  });
}
