import type { Express } from "express";
import type { Pool } from "pg";
import type { Config } from "./config.js";
import { createProcessingPipelineStorage, type ProcessingPipelineStorage } from "./processingPipelineStorage.js";
import { createStepFunctionsRunner, type StepFunctionsRunner } from "./stepFunctionsRunner.js";
import { createApplication } from "./app/createApp.js";
import { createLogger } from "./platform/logger.js";
export { ensureBootstrapAdmin } from "./modules/auth/application/bootstrapAdmin.js";

/**
 * Compatibility entry point used by existing tests and scripts.
 * New code should prefer createApplication when it needs custom dependencies.
 */
export function createApp(
  pool: Pool,
  config: Config,
  processingPipelineStorage: ProcessingPipelineStorage = createProcessingPipelineStorage(config),
  stepFunctionsRunner: StepFunctionsRunner = createStepFunctionsRunner(config),
): Express {
  return createApplication({
    pool,
    config,
    processingPipelineStorage,
    stepFunctionsRunner,
    logger: createLogger(),
  });
}
