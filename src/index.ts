import { startServer } from "./app/server.js";

try {
  await startServer();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
