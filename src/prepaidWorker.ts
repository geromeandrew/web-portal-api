import { setTimeout as wait } from "node:timers/promises";
import { loadConfig } from "./config.js";
import { createPool } from "./db.js";
import { createStepFunctionsRunner } from "./stepFunctionsRunner.js";
import { createLogger } from "./platform/logger.js";
import { PrepaidRepository } from "./modules/prepaid/infrastructure/repository.js";
import { createPrepaidStorage } from "./modules/prepaid/infrastructure/prepaidStorage.js";
import { PrepaidWorker } from "./modules/prepaid/application/worker.js";
import { PrepaidPreparationWorker } from "./modules/prepaid/application/preparationWorker.js";

const config = loadConfig(),
  logger = createLogger(),
  pool = createPool(config);
const worker = new PrepaidWorker(
  new PrepaidRepository(pool, config.DATABASE_SCHEMA),
  createPrepaidStorage(config),
  createStepFunctionsRunner(config),
  logger,
);
const preparation = new PrepaidPreparationWorker(
  worker.repo,
  worker.storage,
  worker.runner,
  logger,
);
let stopping = false;
process.on("SIGTERM", () => {
  stopping = true;
});
process.on("SIGINT", () => {
  stopping = true;
});
try {
  const installed = await pool.query(
    "SELECT to_regclass($1) present,to_regclass($2) legacy,to_regclass($3) extractions,EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass($3) AND attname='context' AND NOT attisdropped) backend_context",
    [
      `${worker.repo.schema}.prepaid_snapshot_context`,
      `${worker.repo.schema}.prepaid_source_totals`,
      `${worker.repo.schema}.prepaid_source_extractions`,
    ],
  );
  if (
    !installed.rows[0]?.present ||
    !installed.rows[0]?.legacy ||
    !installed.rows[0]?.extractions ||
    !installed.rows[0]?.backend_context
  )
    throw new Error(
      "Install Prepaid migrations through 007 before starting the worker.",
    );
  while (!stopping) {
    try {
      const worked = (await preparation.tick()) || (await worker.tick());
      if (!worked) await wait(2000);
    } catch (error) {
      logger.error("prepaid.worker.unavailable", {
        message: error instanceof Error ? error.message : "Worker unavailable",
      });
      await wait(5000);
    }
  }
} finally {
  await pool.end();
}
