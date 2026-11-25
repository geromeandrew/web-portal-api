import { loadConfig } from "./config.js";
import { createPool, withTransaction } from "./db.js";
import { runMigrations } from "./migrationRunner.js";
import { migratePrepaid } from "./modules/prepaid/infrastructure/migrationRunner.js";
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
  const schema = config.DATABASE_SCHEMA;
  cancellation.signal.throwIfAborted();
  const applied = await withTransaction(pool, async (client) => {
    const migrations = await migratePrepaid(client, schema, undefined, true);
    cancellation.signal.throwIfAborted();
    return migrations;
  });
  logger.info("database.prepaid_migrations_current", {
    databaseName: config.DATABASE_NAME,
    databaseSchema: schema,
    applied,
  });
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
