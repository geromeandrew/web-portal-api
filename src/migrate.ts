import { loadConfig } from "./config.js";
import type { Config } from "./config.js";
import { getDatabaseErrorDiagnostics } from "./databaseErrors.js";
import { createPool } from "./db.js";
import { migrations } from "./migrations.js";
import { createLogger } from "./platform/logger.js";
import type { Pool } from "pg";

const logger = createLogger();
const quoteIdentifier = (identifier: string) =>
  `"${identifier.replace(/"/g, '""')}"`;
let config: Config | undefined;
let pool: Pool | undefined;

function errorDetails(error: unknown) {
  return {
    ...(config ? (getDatabaseErrorDiagnostics(error, config) ?? {}) : {}),
    errorName: error instanceof Error ? error.name : undefined,
    errorMessage: error instanceof Error ? error.message : String(error),
    errorStack: error instanceof Error ? error.stack : undefined,
  };
}

try {
  config = loadConfig();
  // Bootstrap without a schema-specific search path: the configured schema
  // may not exist yet, and PostgreSQL rejects that option in that case.
  pool = createPool(config, false, logger);
  logger.info("database.connection_attempt", {
    operation: "migration",
    databaseHost: config.DATABASE_HOST,
    databasePort: config.DATABASE_PORT,
    databaseName: config.DATABASE_NAME,
    databaseUser: config.DATABASE_USER,
    databaseSsl: config.DATABASE_SSL,
    connectionTimeoutMs: 10_000,
  });
  const connectionStartedAt = Date.now();
  await pool.query("SELECT 1");
  logger.info("database.connection_succeeded", {
    operation: "migration",
    databaseHost: config.DATABASE_HOST,
    databasePort: config.DATABASE_PORT,
    databaseName: config.DATABASE_NAME,
    databaseUser: config.DATABASE_USER,
    databaseSsl: config.DATABASE_SSL,
    durationMs: Date.now() - connectionStartedAt,
  });
  await pool.query(
    `CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(config.DATABASE_SCHEMA)}`,
  );
  await pool.query(
    `SET search_path TO ${quoteIdentifier(config.DATABASE_SCHEMA)}, public`,
  );
  await pool.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  for (const migration of migrations) {
    const result = await pool.query(
      "SELECT 1 FROM schema_migrations WHERE id = $1",
      [migration.id],
    );
    if (result.rowCount) continue;
    await pool.query("BEGIN");
    try {
      await pool.query(migration.sql);
      await pool.query("INSERT INTO schema_migrations (id) VALUES ($1)", [
        migration.id,
      ]);
      await pool.query("COMMIT");
    } catch (error) {
      await pool.query("ROLLBACK");
      throw error;
    }
  }
  logger.info("database.migrations_current");
} catch (error) {
  logger.error("database.migration_failed", errorDetails(error));
  process.exitCode = 1;
} finally {
  if (pool) {
    try {
      await pool.end();
    } catch (error) {
      logger.error("database.pool_close_failed", errorDetails(error));
      process.exitCode = 1;
    }
  }
}
