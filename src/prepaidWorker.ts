import { setTimeout as wait } from "node:timers/promises";
import { loadConfig } from "./config.js";
import { createPool } from "./db.js";
import { createStepFunctionsRunner } from "./stepFunctionsRunner.js";
import { createLogger } from "./platform/logger.js";
import { PrepaidRepository } from "./modules/prepaid/infrastructure/repository.js";
import { createPrepaidStorage } from "./modules/prepaid/infrastructure/prepaidStorage.js";
import { PrepaidWorker } from "./modules/prepaid/application/worker.js";
import { PrepaidPreparationWorker } from "./modules/prepaid/application/preparationWorker.js";
import { GlueClient } from "@aws-sdk/client-glue";
import { SFNClient } from "@aws-sdk/client-sfn";
import { S3Client } from "@aws-sdk/client-s3";
import { createAwsClientOptions } from "./aws.js";
import { PrepaidStorage } from "./modules/prepaid/infrastructure/prepaidStorage.js";
import { PrepaidReferenceRefreshWorker } from "./modules/prepaid/application/referenceRefreshWorker.js";
import { AwsReferenceRefreshRunner } from "./modules/prepaid/infrastructure/referenceRefreshRunner.js";
import { PostgresReferenceSource } from "./modules/prepaid/infrastructure/referenceSource.js";
import { AwsSourceJobInspector } from "./modules/prepaid/infrastructure/sourceJobInspector.js";
import { referenceRefreshJob } from "./modules/prepaid/domain/referenceRefresh.js";
import { sourceWorkflows } from "./modules/prepaid/domain/sourceExtraction.js";

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
// Glue StartJobRun has no idempotency token: disable SDK write retries.
const aws = {
  ...createAwsClientOptions(config),
  maxAttempts: 1,
  requestHandler: { connectionTimeout: 10000, requestTimeout: 30000 },
};
const glue = new GlueClient(aws),
  sfn = new SFNClient(aws),
  s3 = new S3Client(aws);
const referenceInspector = new AwsSourceJobInspector(glue, sfn);
const references = new PrepaidReferenceRefreshWorker(
  worker.repo,
  worker.storage,
  new AwsReferenceRefreshRunner(
    glue,
    new PrepaidStorage(s3, referenceRefreshJob.scriptBucket),
  ),
  new PostgresReferenceSource(pool),
  worker.storage.legacyLanding(),
  async () => {
    const machines: string[] = [];
    for (const mapping of Object.values(sourceWorkflows))
      machines.push(
        (await worker.runner.describeStateMachineDefinition(mapping.machine))
          .arn,
      );
    await referenceInspector.idle(machines, "isg-esatp-dv");
  },
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
    "SELECT to_regclass($1) present,to_regclass($2) legacy,to_regclass($3) extractions,EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass($3) AND attname='context' AND NOT attisdropped) backend_context, EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass($3) AND conname='prepaid_source_extractions_workflow_check' AND pg_get_constraintdef(oid) LIKE '%charges_318%') all_sources",
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
    !installed.rows[0]?.backend_context ||
    !installed.rows[0]?.all_sources
  )
    throw new Error(
      "Install Prepaid migrations through 008 before starting the worker.",
    );
  const referenceSchema = await pool.query("SELECT to_regclass($1) present", [
    worker.repo.table("reference_refreshes"),
  ]);
  const referenceExportsAvailable = !!referenceSchema.rows[0]?.present;
  if (!referenceExportsAvailable)
    logger.info("prepaid.reference.disabled", {
      message:
        "Install additive migration 009 to enable reference operations; existing preparation remains enabled.",
    });
  while (!stopping) {
    try {
      // Do not short-circuit: an active preparation must not starve admin reference work.
      const referenced = referenceExportsAvailable && (await references.tick());
      const prepared = await preparation.tick();
      const worked = (await worker.tick()) || referenced || prepared;
      if (!worked) await wait(2000);
    } catch (error) {
      logger.error("prepaid.worker.unavailable", {
        message: error instanceof Error ? error.message : "Worker unavailable",
      });
      await wait(5000);
    }
  }
} finally {
  glue.destroy();
  sfn.destroy();
  s3.destroy();
  await pool.end();
}
