import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import type { Config } from "./config.js";

export function createPool(config: Config, setSearchPath = true) {
  return new Pool({
    connectionString: config.DATABASE_URL,
    max: 10,
    ...(setSearchPath
      ? { options: `-c search_path=${config.DATABASE_SCHEMA},public` }
      : {}),
    ssl: config.DATABASE_SSL
      ? {
          ca: readFileSync(
            new URL("../certs/rds-ap-southeast-1-rsa2048-g1.pem", import.meta.url),
            "utf8",
          ),
          rejectUnauthorized: true,
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
