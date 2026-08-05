import type { Pool } from "pg";
import type { Config } from "../config.js";
import type { ProcessingPipelineStorage } from "../processingPipelineStorage.js";
import type { GlueJobRunner } from "../glueJobRunner.js";
import type { Logger } from "../platform/logger.js";

/**
 * The application receives its outside-world dependencies here.
 *
 * Keeping this object explicit makes routers easy to test: a test can provide
 * fake storage or job-runner implementations without starting AWS clients.
 */
export type AppDependencies = {
  pool: Pool;
  config: Config;
  processingPipelineStorage: ProcessingPipelineStorage;
  glueJobRunner: GlueJobRunner;
  logger: Logger;
};
