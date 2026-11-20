import { runPrepaidWorker } from "./prepaidRuntime.js";
import { runWithShutdown } from "./app/entrypoint.js";
try {
  await runWithShutdown(runPrepaidWorker);
} catch (error) {
  console.error(
    "Prepaid worker failed:",
    error instanceof Error ? error.message : "Unknown error",
  );
  process.exitCode = 1;
}
