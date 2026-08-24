import type { Server } from "node:http";
import { loadConfig } from "../config.js";
import { createPool } from "../db.js";
import { createLogger } from "../platform/logger.js";
import { createApp, ensureBootstrapAdmin } from "../routes.js";

/** Starts the HTTP server and wires process shutdown to database cleanup. */
export async function startServer(): Promise<Server> {
  const config = loadConfig();
  const pool = createPool(config);
  const logger = createLogger();

  try {
    await pool.query("SELECT 1");
    const bootstrapAdmin = await ensureBootstrapAdmin(pool, config);
    if (bootstrapAdmin) {
      logger.info("auth.bootstrap_admin_created", {
        email: bootstrapAdmin.email,
      });
    }

    const server = await new Promise<Server>((resolve) => {
      const httpServer = createApp(pool, config).listen(
        config.PORT,
        "0.0.0.0",
        () => {
          logger.info("api.listening", { port: config.PORT });
          resolve(httpServer);
        },
      );
    });
    let closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await pool.end();
    };
    process.on("SIGTERM", () => void close());
    process.on("SIGINT", () => void close());
    return server;
  } catch (error) {
    logger.error("api.startup_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    await pool.end();
    throw error;
  }
}
