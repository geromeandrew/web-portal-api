import { loadConfig } from "./config.js";
import { createPool } from "./db.js";
import { createApp, ensureBootstrapAdmin } from "./routes.js";
import { createLogger } from "./platform/logger.js";

const config = loadConfig();
const pool = createPool(config);
const logger = createLogger();

try {
  await pool.query("SELECT 1");
  const bootstrapAdmin = await ensureBootstrapAdmin(pool, config);
  if (bootstrapAdmin) logger.info("auth.bootstrap_admin_created", { email: bootstrapAdmin.email });
  const app = createApp(pool, config);
  const server = app.listen(config.PORT, "0.0.0.0", () => logger.info("api.listening", { port: config.PORT }));
  const close = async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await pool.end();
  };
  process.on("SIGTERM", () => void close());
  process.on("SIGINT", () => void close());
} catch (error) {
  logger.error("api.startup_failed", { error: error instanceof Error ? error.message : String(error) });
  await pool.end();
  process.exitCode = 1;
}
