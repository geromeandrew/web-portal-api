import type { Server } from "node:http";
import type { Pool, QueryConfig } from "pg";
import { loadConfig } from "../config.js";
import { createPool } from "../db.js";
import { getDatabaseErrorDiagnostics } from "../databaseErrors.js";
import { createLogger } from "../platform/logger.js";
import { createApp } from "../routes.js";
import { runMigrations } from "../migrationRunner.js";

/** Expose probes while migrating, but never serve business traffic on a partial schema. */
export async function startServer(): Promise<Server> {
  const logger = createLogger();
  let config: ReturnType<typeof loadConfig> | undefined;
  let pool: Pool | undefined;
  let server: Server | undefined;
  let ready = false;
  const cancellation = new AbortController();
  let cleanup: Promise<void> | undefined;
  let migrationInFlight: Promise<void> | undefined;
  const close = () => {
    ready = false;
    cancellation.abort();
    return (cleanup ??= (async () => {
      if (server)
        await new Promise<void>((resolve) => {
          server!.close(() => resolve());
          server!.closeIdleConnections?.();
        });
      if (migrationInFlight) await migrationInFlight.catch(() => {});
      if (pool) await pool.end();
    })());
  };
  const onSignal = () => {
    void close().catch(() => {
      process.exitCode = 1;
    });
  };
  try {
    config = loadConfig();
    pool = createPool(config, true, logger);
    const app = createApp(pool, config, undefined, undefined, () => ready);
    server = await new Promise<Server>((resolve, reject) => {
      const listener = app.listen(config!.PORT, "0.0.0.0", () =>
        resolve(listener),
      );
      listener.once("error", reject);
    });
    process.once("SIGTERM", onSignal);
    process.once("SIGINT", onSignal);
    server.once("close", () => {
      process.removeListener("SIGTERM", onSignal);
      process.removeListener("SIGINT", onSignal);
    });
    logger.info("api.listening", { port: config.PORT });
    migrationInFlight = runMigrations(
      pool,
      config,
      logger,
      cancellation.signal,
    );
    await migrationInFlight;
    cancellation.signal.throwIfAborted();
    const result = await pool.query({
      text: `SELECT
        (SELECT count(*) = 3 FROM pg_attribute WHERE attrelid=to_regclass('security_audit_events') AND attname IN ('action_outcome','access_port','environment') AND NOT attisdropped)
        AND has_table_privilege(to_regclass('security_audit_events'), 'INSERT') AS ready`,
      query_timeout: 2000,
    } as QueryConfig & { query_timeout: number });
    cancellation.signal.throwIfAborted();
    if (result.rows[0]?.ready !== true)
      throw new Error("Required audit schema or INSERT permission is missing.");
    ready = true;
    logger.info("api.ready", {
      port: config.PORT,
    });
    return server;
  } catch (error) {
    logger.error("api.startup_failed", {
      startupPhase: "database_migrations",
      ...(config ? (getDatabaseErrorDiagnostics(error, config) ?? {}) : {}),
      errorName: error instanceof Error ? error.name : undefined,
    });
    server?.closeAllConnections?.();
    await close().catch(() => {});
    throw error;
  }
}
