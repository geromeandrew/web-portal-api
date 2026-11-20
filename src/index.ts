import { runPortalRuntime } from "./app/runtime.js";
import { runWithShutdown } from "./app/entrypoint.js";

try {
  await runWithShutdown(runPortalRuntime);
} catch (error) {
  console.error(
    "Portal runtime failed:",
    error instanceof Error ? error.message : "Unknown error",
  );
  process.exitCode = 1;
}
