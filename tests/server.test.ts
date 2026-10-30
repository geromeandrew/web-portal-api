import { EventEmitter } from "node:events";
import type { Server } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  createPool: vi.fn(),
  createApp: vi.fn(),
  migrate: vi.fn(),
  logger: { info: vi.fn(), error: vi.fn() },
}));
vi.mock("../src/config.js", () => ({ loadConfig: mocks.loadConfig }));
vi.mock("../src/db.js", () => ({ createPool: mocks.createPool }));
vi.mock("../src/routes.js", () => ({ createApp: mocks.createApp }));
vi.mock("../src/migrationRunner.js", () => ({ runMigrations: mocks.migrate }));
vi.mock("../src/platform/logger.js", () => ({
  createLogger: () => mocks.logger,
}));
import { startServer } from "../src/app/server.js";
let server: Server;
let pool: { query: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.loadConfig.mockReturnValue({
    PORT: 3001,
    DATABASE_SCHEMA: "test",
    DATABASE_PASSWORD: "private-password",
  });
  pool = {
    query: vi.fn().mockResolvedValue({ rows: [{ ready: true }] }),
    end: vi.fn().mockResolvedValue(undefined),
  };
  mocks.createPool.mockReturnValue(pool);
  server = new EventEmitter() as Server;
  server.close = vi.fn((callback) => {
    server.emit("close");
    callback?.();
    return server;
  });
  server.closeAllConnections = vi.fn();
  mocks.createApp.mockReturnValue({
    listen: (_port: number, _host: string, callback: () => void) => {
      queueMicrotask(callback);
      return server;
    },
  });
});
describe("automatic startup migrations", () => {
  it("holds business readiness false until migrations and audit permission checks succeed", async () => {
    mocks.migrate.mockImplementation(async () => {
      expect(mocks.createApp.mock.calls[0][4]()).toBe(false);
    });
    expect(await startServer()).toBe(server);
    expect(mocks.migrate).toHaveBeenCalledOnce();
    expect(mocks.createApp.mock.calls[0][4]()).toBe(true);
    expect(pool.end).not.toHaveBeenCalled();
    server.emit("close");
  });
  it("closes the listener and DB on migration failure without logging private errors", async () => {
    mocks.migrate.mockRejectedValue(Error("private-password private-sql"));
    await expect(startServer()).rejects.toThrow("private-password");
    expect(server.close).toHaveBeenCalledOnce();
    expect(pool.end).toHaveBeenCalledOnce();
    expect(mocks.createApp.mock.calls[0][4]()).toBe(false);
    expect(JSON.stringify(mocks.logger.error.mock.calls)).not.toMatch(
      /private-password|private-sql/,
    );
  });
  it("does not mark a stopped API ready if shutdown arrives during the final database check", async () => {
    pool.query.mockImplementation(async () => {
      process.emit("SIGTERM");
      return { rows: [{ ready: true }] };
    });
    await expect(startServer()).rejects.toThrow();
    expect(mocks.createApp.mock.calls[0][4]()).toBe(false);
    expect(pool.end).toHaveBeenCalledOnce();
    expect(
      mocks.logger.info.mock.calls.some(([event]) => event === "api.ready"),
    ).toBe(false);
  });
  it("refuses readiness when audit INSERT permission is missing", async () => {
    pool.query.mockResolvedValue({ rows: [{ ready: false }] });
    await expect(startServer()).rejects.toThrow("INSERT permission");
    expect(pool.end).toHaveBeenCalledOnce();
  });
});
