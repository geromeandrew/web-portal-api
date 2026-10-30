import { loadConfig } from "./config.js";
import { createPool } from "./db.js";
import { runMigrations } from "./migrationRunner.js";
import { createLogger } from "./platform/logger.js";
import { getDatabaseErrorDiagnostics } from "./databaseErrors.js";
import type { Pool } from "pg";
const logger = createLogger();
let pool: Pool | undefined;
let config: ReturnType<typeof loadConfig> | undefined;
const cancellation = new AbortController();
const stop = () => cancellation.abort();
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
try {
  config = loadConfig();
  pool = createPool(config, false, logger);
  await runMigrations(pool, config, logger, cancellation.signal);
} catch (error) {
  logger.error("database.migration_failed", {
    ...(config ? (getDatabaseErrorDiagnostics(error, config) ?? {}) : {}),
    errorName: error instanceof Error ? error.name : undefined,
  });
  process.exitCode = 1;
} finally {
  process.removeListener("SIGTERM", stop);
  process.removeListener("SIGINT", stop);
  if (pool)
    await pool.end().catch(() => {
      process.exitCode = 1;
    });
}
