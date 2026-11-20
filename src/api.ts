// API-only entrypoint for deployments with a separately managed worker.
import { startServer } from "./app/server.js";
try {
  await startServer();
} catch {
  process.exitCode = 1;
}
