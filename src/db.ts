import { Pool, type PoolClient } from "pg";
import type { Config } from "./config.js";

export function createPool(config: Config, setSearchPath = true) {
  const connectionUrl = new URL(config.DATABASE_URL);
  for (const parameter of [
    "ssl",
    "sslmode",
    "sslcert",
    "sslkey",
    "sslrootcert",
    "sslca",
  ]) {
    connectionUrl.searchParams.delete(parameter);
  }

  return new Pool({
    connectionString: connectionUrl.toString(),
    max: 10,
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
