/** Compatibility CLI: read-only verification only. AWS definitions and scripts
 * are owned externally. The former --apply deployment path is intentionally gone.
 */
import { loadConfig } from "./config.js";
import { createAwsClientOptions } from "./aws.js";
import { createStepFunctionsRunner } from "./stepFunctionsRunner.js";
import { GlueClient } from "@aws-sdk/client-glue";
import { SFNClient } from "@aws-sdk/client-sfn";
import {
  sourceWorkflows,
  validateLegacySourceDefinition,
  type SourceWorkflow,
} from "./modules/prepaid/domain/sourceExtraction.js";
import { AwsSourceJobInspector } from "./modules/prepaid/infrastructure/sourceJobInspector.js";

if (process.argv.includes("--apply")) {
  console.error(
    "Deployment is disabled. This backend does not edit Step Functions, Glue jobs or AWS scripts. Use verify:prepaid:sources for read-only inspection.",
  );
  process.exitCode = 1;
} else {
  const config = loadConfig(),
    options = createAwsClientOptions(config);
  const glue = new GlueClient(options),
    sfn = new SFNClient(options);
  const runner = createStepFunctionsRunner(config),
    inspector = new AwsSourceJobInspector(glue, sfn);
  let failed = false;
  try {
    for (const workflow of Object.keys(sourceWorkflows) as SourceWorkflow[]) {
      try {
        const definition = await runner.describeStateMachineDefinition(
          sourceWorkflows[workflow].machine,
        );
        if (definition.type !== "STANDARD" || definition.status !== "ACTIVE")
          throw Error("Workflow is not active Standard.");
        validateLegacySourceDefinition(
          workflow,
          definition.definition,
          "isg-esatp-dv",
        );
        await inspector.verify(workflow, "isg-esatp-dv", config.S3_BUCKET);
        console.log(
          JSON.stringify({
            workflow,
            status: "compatible",
            input: { env_prefix: "isg-esatp-dv" },
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
  }
  if (failed) process.exitCode = 1;
}
