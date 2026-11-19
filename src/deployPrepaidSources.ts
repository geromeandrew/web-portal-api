/** Compatibility CLI: read-only verification only. AWS definitions and scripts
 * are owned externally. The former --apply deployment path is intentionally gone.
 */
import { loadConfig } from "./config.js";
import { createAwsClientOptions } from "./aws.js";
import { createStepFunctionsRunner } from "./stepFunctionsRunner.js";
import { GlueClient } from "@aws-sdk/client-glue";
import { SFNClient } from "@aws-sdk/client-sfn";
import { S3Client } from "@aws-sdk/client-s3";
import { PrepaidStorage } from "./modules/prepaid/infrastructure/prepaidStorage.js";
import {
  sourceWorkflows,
  validateLegacySourceDefinition,
  type SourceWorkflow,
} from "./modules/prepaid/domain/sourceExtraction.js";
import { AwsSourceJobInspector } from "./modules/prepaid/infrastructure/sourceJobInspector.js";
import { readFileSync } from "node:fs";
import { builtinPrepaidConfiguration } from "./modules/prepaid/domain/builtinConfiguration.js";
import { manualIntegrationSchema } from "./modules/prepaid/domain/contracts.js";
import {
  sourceMachineName,
  reviewedSourceResources,
} from "./modules/prepaid/domain/sourceResources.js";

if (process.argv.includes("--apply")) {
  console.error(
    "Deployment is disabled. This backend does not edit Step Functions, Glue jobs or AWS scripts. Use verify:prepaid:sources for read-only inspection.",
  );
  process.exitCode = 1;
} else {
  const config = loadConfig(),
    options = createAwsClientOptions(config);
  const glue = new GlueClient(options),
    sfn = new SFNClient(options),
    s3 = new S3Client(options);
  const parallel = process.argv.includes("--parallel");
  const configIndex = process.argv.indexOf("--configuration");
  const integration =
    configIndex >= 0
      ? manualIntegrationSchema.parse(
          JSON.parse(readFileSync(process.argv[configIndex + 1], "utf8")),
        )
      : builtinPrepaidConfiguration(config);
  const settings = integration?.sourceExtraction;
  if (!settings)
    throw Error(
      "Supply the target configuration through --configuration <JSON file> or PREPAID_CONFIGURATION_JSON; this command does not invent AWS resources.",
    );
  const resources = settings.resources ?? reviewedSourceResources;
  const scripts = new PrepaidStorage(s3, resources.scriptsBucket);
  const runner = createStepFunctionsRunner(config),
    inspector = new AwsSourceJobInspector(glue, sfn, (key) =>
      scripts.bytes(key, resources.scriptsPrefix, 2 * 1024 * 1024),
    );
  let failed = false;
  try {
    if (parallel || settings.resources) {
      await inspector.verifyIsolation(resources);
      console.log(
        JSON.stringify({
          mode: "read-only",
          sharedImplementation: "verified",
          parallelism: 3,
        }),
      );
    }
    for (const workflow of Object.keys(sourceWorkflows) as SourceWorkflow[]) {
      try {
        const definition = await runner.describeStateMachineDefinition(
          sourceMachineName(
            workflow,
            settings,
            sourceWorkflows[workflow].machine,
          ),
        );
        if (definition.type !== "STANDARD" || definition.status !== "ACTIVE")
          throw Error("Workflow is not active Standard.");
        validateLegacySourceDefinition(
          workflow,
          definition.definition,
          settings.envPrefix,
          resources,
        );
        await inspector.verify(
          workflow,
          settings.envPrefix,
          config.S3_BUCKET,
          parallel,
          resources,
        );
        console.log(
          JSON.stringify({
            workflow,
            status: "compatible",
            input: { env_prefix: settings.envPrefix },
            mode: "read-only",
          }),
        );
      } catch (error) {
        failed = true;
        console.error(
          JSON.stringify({
            workflow,
            status: "incompatible",
            reason: (error as Error).message,
            mode: "read-only",
          }),
        );
      }
    }
  } finally {
    glue.destroy();
    sfn.destroy();
    s3.destroy();
  }
  if (failed) process.exitCode = 1;
}
