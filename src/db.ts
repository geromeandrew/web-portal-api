import { Pool, type PoolClient } from "pg";
import type { Config } from "./config.js";
import { getDatabaseErrorDiagnostics } from "./databaseErrors.js";
import type { Logger } from "./platform/logger.js";

export function createPool(
  config: Config,
  setSearchPath = true,
  logger?: Logger,
) {
  const pool = new Pool({
    host: config.DATABASE_HOST,
    port: config.DATABASE_PORT,
    database: config.DATABASE_NAME,
    user: config.DATABASE_USER,
    password: config.DATABASE_PASSWORD,
    max: 10,
    connectionTimeoutMillis: 10_000,
    ...(setSearchPath
      ? { options: `-c search_path=${config.DATABASE_SCHEMA},public` }
      : {}),
    ssl: config.DATABASE_SSL
      ? {
          // Match PostgreSQL's `sslmode=require`: encrypt traffic, but do not
          // require a locally supplied RDS CA certificate.
          rejectUnauthorized: false,
        }
      : false,
  });
  if (logger && typeof pool.on === "function") {
    pool.on("error", (error) => {
      logger.error("database.idle_client_error", {
        ...(getDatabaseErrorDiagnostics(error, config) ?? {
          errorName: error.name,
          errorMessage: error.message,
          errorStack: error.stack,
        }),
      });
    });
  }
  return pool;
}

export async function withTransaction<T>(
  pool: Pool,
  callback: (client: PoolClient) => Promise<T>,
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
