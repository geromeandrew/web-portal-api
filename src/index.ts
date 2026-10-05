import { startServer } from "./app/server.js";

try {
  await startServer();
} catch {
  process.exitCode = 1;
}
