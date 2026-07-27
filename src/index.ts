import { loadConfig } from "./config.js";
import { createPool } from "./db.js";
import { createApp, ensureBootstrapAdmin } from "./routes.js";

const config = loadConfig();
const pool = createPool(config);

try {
  await pool.query("SELECT 1");
  await ensureBootstrapAdmin(pool, config);
  const app = createApp(pool, config);
  const server = app.listen(config.PORT, "0.0.0.0", () => console.log(`API listening on port ${config.PORT}`));
  const close = async () => {
    server.close();
    await pool.end();
  };
  process.on("SIGTERM", () => void close());
  process.on("SIGINT", () => void close());
} catch (error) {
  console.error("API startup failed", error);
  await pool.end();
  process.exitCode = 1;
}
