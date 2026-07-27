import { loadConfig } from "./config.js";
import { createPool } from "./db.js";
import { migrations } from "./migrations.js";

const config = loadConfig();
const pool = createPool(config);

try {
  await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  for (const migration of migrations) {
    const result = await pool.query("SELECT 1 FROM schema_migrations WHERE id = $1", [migration.id]);
    if (result.rowCount) continue;
    await pool.query("BEGIN");
    try {
      await pool.query(migration.sql);
      await pool.query("INSERT INTO schema_migrations (id) VALUES ($1)", [migration.id]);
      await pool.query("COMMIT");
    } catch (error) {
      await pool.query("ROLLBACK");
      throw error;
    }
  }
  console.log("Database migrations are current.");
} finally {
  await pool.end();
}
