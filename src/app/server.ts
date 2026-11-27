import type { Server } from "node:http";
import type { Pool, QueryConfig } from "pg";
import { loadConfig } from "../config.js";
import { createPool } from "../db.js";
import { getDatabaseErrorDiagnostics } from "../databaseErrors.js";
import { createLogger } from "../platform/logger.js";
import { createApp } from "../routes.js";
import { runMigrations } from "../migrationRunner.js";
import { localPrepaidBatchPrefix, startPrepaidStartup } from "./prepaidStartup.js";

const shutdowns = new WeakMap<Server, () => Promise<void>>();
const prepaidStartup = new WeakMap<Server, Promise<boolean>>();
const prepaidBatchMode = new WeakMap<Server, boolean>();
export async function stopServer(server: Server): Promise<void> {
  await shutdowns.get(server)?.();
}
export function waitForPrepaidStartup(server: Server) {
  return prepaidStartup.get(server) ?? Promise.resolve(true);
}
export function prepaidBatchEnabled(server: Server) {
  return prepaidBatchMode.get(server);
}

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
  let prepaid: ReturnType<typeof startPrepaidStartup> | undefined;
  let prepaidCompletion: Promise<void> | undefined;
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
      await prepaidCompletion;
      try {
        if (pool) await pool.end();
      } finally {
        process.removeListener("SIGTERM", onSignal);
        process.removeListener("SIGINT", onSignal);
        if (server) {
          shutdowns.delete(server);
          prepaidStartup.delete(server);
          prepaidBatchMode.delete(server);
        }
      }
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
    let batchEnabled = true;
    const app = createApp(
      pool,
      config,
      undefined,
      undefined,
      () => ready,
      () => prepaid?.status,
      () => batchEnabled,
    );
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
    batchEnabled = !!(await localPrepaidBatchPrefix(pool, config));
    prepaidBatchMode.set(server, batchEnabled);
    const result = await pool.query({
      text: `SELECT
        (SELECT count(*) = 3 FROM pg_attribute WHERE attrelid=to_regclass('security_audit_events') AND attname IN ('action_outcome','access_port','environment') AND NOT attisdropped)
        AND has_table_privilege(to_regclass('security_audit_events'), 'INSERT') AS ready`,
      query_timeout: 2000,
    } as QueryConfig & { query_timeout: number });
    cancellation.signal.throwIfAborted();
    if (result.rows[0]?.ready !== true)
      throw new Error("Required audit schema or INSERT permission is missing.");
    prepaid = startPrepaidStartup(pool, config, logger, cancellation.signal);
    prepaidCompletion = prepaid.completion.catch((error: unknown) => {
      logger.error("api.prepaid_startup_failed", {
        errorName: error instanceof Error ? error.name : undefined,
      });
    });
    prepaidStartup.set(server, prepaid.baseReady);
    ready = true;
    logger.info("api.ready", {
      port: config.PORT,
    });
    shutdowns.set(server, close);
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
