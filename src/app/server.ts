import type { Server } from "node:http";
import type { Pool } from "pg";
import type { Config } from "../config.js";
import { loadConfig } from "../config.js";
import { getDatabaseErrorDiagnostics } from "../databaseErrors.js";
import { createPool } from "../db.js";
import { createLogger } from "../platform/logger.js";
import { createApp } from "../routes.js";

/** Starts the HTTP server and wires process shutdown to database cleanup. */
export async function startServer(): Promise<Server> {
  const logger = createLogger();
  let config: Config | undefined;
  let pool: Pool | undefined;
  let startupPhase = "configuration";

  try {
    config = loadConfig();
    startupPhase = "database_connection";
    pool = createPool(config, true, logger);
    logger.info("database.connection_attempt", {
      databaseHost: config.DATABASE_HOST,
      databasePort: config.DATABASE_PORT,
      databaseName: config.DATABASE_NAME,
      databaseUser: config.DATABASE_USER,
      databaseSsl: config.DATABASE_SSL,
      connectionTimeoutMs: 10_000,
    });
    const connectionStartedAt = Date.now();
    try {
      await pool.query("SELECT 1");
      logger.info("database.connection_succeeded", {
        databaseHost: config.DATABASE_HOST,
        databasePort: config.DATABASE_PORT,
        databaseName: config.DATABASE_NAME,
        databaseUser: config.DATABASE_USER,
        databaseSsl: config.DATABASE_SSL,
        durationMs: Date.now() - connectionStartedAt,
      });
    } catch (error) {
      logger.error("database.connection_failed", {
        startupPhase,
        ...(getDatabaseErrorDiagnostics(error, config) ?? {}),
        errorName: error instanceof Error ? error.name : undefined,
        errorMessage: error instanceof Error ? error.message : String(error),
        errorStack: error instanceof Error ? error.stack : undefined,
        apiStartupContinues: true,
      });
    }

    startupPhase = "http_listener";
    const activeConfig = config;
    const activePool = pool;
    const server = await new Promise<Server>((resolve, reject) => {
      const httpServer = createApp(activePool, activeConfig).listen(
        activeConfig.PORT,
        "0.0.0.0",
        () => {
          logger.info("api.listening", { port: activeConfig.PORT });
          resolve(httpServer);
        },
      );
      httpServer.once("error", reject);
    });
    let closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await pool!.end();
    };
    process.on("SIGTERM", () => void close());
    process.on("SIGINT", () => void close());
    return server;
  } catch (error) {
    logger.error(
      startupPhase === "database_connection"
        ? "database.connection_failed"
        : "api.startup_failed",
      {
        startupPhase,
        ...(config ? (getDatabaseErrorDiagnostics(error, config) ?? {}) : {}),
        errorName: error instanceof Error ? error.name : undefined,
        errorMessage: error instanceof Error ? error.message : String(error),
        errorStack: error instanceof Error ? error.stack : undefined,
      },
    );
    if (pool) {
      try {
        await pool.end();
      } catch (closeError) {
        logger.error("database.pool_close_failed", {
          ...(config
            ? (getDatabaseErrorDiagnostics(closeError, config) ?? {})
            : {}),
          errorName: closeError instanceof Error ? closeError.name : undefined,
          errorMessage:
            closeError instanceof Error
              ? closeError.message
              : String(closeError),
          errorStack:
            closeError instanceof Error ? closeError.stack : undefined,
        });
      }
    }
    throw error;
  }
}
