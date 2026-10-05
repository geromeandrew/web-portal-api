import { EventEmitter } from "node:events";
import type { Server } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  createPool: vi.fn(),
  createApp: vi.fn(),
  logger: { info: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/config.js", () => ({ loadConfig: mocks.loadConfig }));
vi.mock("../src/db.js", () => ({ createPool: mocks.createPool }));
vi.mock("../src/routes.js", () => ({ createApp: mocks.createApp }));
vi.mock("../src/platform/logger.js", () => ({
  createLogger: () => mocks.logger,
}));

import { startServer } from "../src/app/server.js";

const config = {
  NODE_ENV: "production",
  PORT: 3001,
  DATABASE_HOST: "10.220.179.25",
  DATABASE_PORT: 1769,
  DATABASE_NAME: "isgesatpdv",
  DATABASE_USER: "esatp_adm",
  DATABASE_PASSWORD: "must-never-appear-in-logs",
  DATABASE_SSL: true,
  DATABASE_SCHEMA: "web_portal",
} as Config;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadConfig.mockReturnValue(config);
});

describe("API startup diagnostics", () => {
  function mockHttpServer() {
    const server = new EventEmitter() as Server;
    const listen = vi.fn(
      (_port: number, _host: string, callback: () => void) => {
        queueMicrotask(callback);
        return server;
      },
    );
    mocks.createApp.mockReturnValue({ listen });
    return { server, listen };
  }

  it("continues listening and logs actionable database timeout details", async () => {
    const error = Object.assign(
      new Error("connect ETIMEDOUT 10.220.179.25:1769"),
      {
        code: "ETIMEDOUT",
        syscall: "connect",
        address: "10.220.179.25",
        port: 1769,
      },
    );
    error.stack = `${error.stack}\n/app/node_modules/pg-pool/index.js:45`;
    const pool = {
      query: vi.fn().mockRejectedValue(error),
      end: vi.fn().mockResolvedValue(undefined),
    };
    mocks.createPool.mockReturnValue(pool);
    const { server, listen } = mockHttpServer();

    await expect(startServer()).resolves.toBe(server);

    expect(mocks.logger.info).toHaveBeenCalledWith(
      "database.connection_attempt",
      expect.objectContaining({
        databaseHost: "10.220.179.25",
        databasePort: 1769,
        databaseSsl: true,
        connectionTimeoutMs: 10_000,
      }),
    );
    expect(mocks.logger.error).toHaveBeenCalledWith(
      "database.connection_failed",
      expect.objectContaining({
        startupPhase: "database_connection",
        errorCode: "ETIMEDOUT",
        diagnosis: expect.stringContaining("NetworkPolicy"),
        apiStartupContinues: true,
      }),
    );
    expect(JSON.stringify(mocks.logger.error.mock.calls)).not.toContain(
      config.DATABASE_PASSWORD,
    );
    expect(mocks.createApp).toHaveBeenCalledWith(pool, config);
    expect(listen).toHaveBeenCalledWith(3001, "0.0.0.0", expect.any(Function));
    expect(pool.end).not.toHaveBeenCalled();
    expect(mocks.logger.info).toHaveBeenCalledWith("api.listening", {
      port: 3001,
    });
  });

  it("verifies a successful database connection before listening", async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [{ "?column?": 1 }] }),
      end: vi.fn().mockResolvedValue(undefined),
    };
    mocks.createPool.mockReturnValue(pool);
    const { server, listen } = mockHttpServer();

    await expect(startServer()).resolves.toBe(server);

    expect(pool.query).toHaveBeenCalledWith("SELECT 1");
    expect(mocks.logger.info).toHaveBeenCalledWith(
      "database.connection_succeeded",
      expect.objectContaining({
        databaseHost: "10.220.179.25",
        databasePort: 1769,
        databaseSsl: true,
      }),
    );
    expect(mocks.logger.error).not.toHaveBeenCalled();
    expect(listen).toHaveBeenCalledOnce();
  });
});
