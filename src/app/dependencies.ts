import type { Pool } from "pg";
import type { Config } from "../config.js";
import type { ProcessingPipelineStorage } from "../processingPipelineStorage.js";
import type { StepFunctionsRunner } from "../stepFunctionsRunner.js";
import type { Logger } from "../platform/logger.js";
import type { PostgresRateLimiter } from "./security.js";
import type { RequestHandler } from "express";
import type { PrepaidStorage } from "../modules/prepaid/infrastructure/prepaidStorage.js";
import type { PrepaidStartupStatus } from "./prepaidStartup.js";

/**
 * The application receives its outside-world dependencies here.
 *
 * Keeping this object explicit makes routers easy to test: a test can provide
 * fake storage or job-runner implementations without starting AWS clients.
 */
export type AppDependencies = {
  startupReady?: () => boolean;
  prepaidStartupStatus?: () => PrepaidStartupStatus | undefined;
  prepaidBatchEnabled?: () => boolean;
  pool: Pool;
  config: Config;
  processingPipelineStorage: ProcessingPipelineStorage;
  stepFunctionsRunner: StepFunctionsRunner;
  logger: Logger;
  rateLimiter: PostgresRateLimiter;
  authenticate: RequestHandler;
  prepaidStorage?: PrepaidStorage;
};
