import { z } from "zod";
import type { SourceWorkflow } from "./sourceExtraction.js";

const workflowKeys = [
  "ke24",
  "callcard_eg",
  "callcard_sg",
  "load_up_eg",
  "load_up_sg",
  "load_api_eg",
  "load_api_sg",
  "monthly_recharge",
  "adjustments_308",
  "charges_318",
];
const name = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
export const sourceResourcesSchema = z
  .object({
    scriptsBucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
    scriptsPrefix: z
      .string()
      .min(1)
      .refine(
        (x) =>
          x.endsWith("/") &&
          !x.startsWith("/") &&
          !x.includes("..") &&
          !x.includes("\\"),
      ),
    stateMachines: z
      .record(z.string(), name)
      .refine(
        (x) => Object.keys(x).every((k) => workflowKeys.includes(k)),
        "Unknown source workflow",
      )
      .optional(),
    jobNamePrefix: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,150}$/)
      .optional(),
    connectionName: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,255}$/)
      .optional(),
  })
  .strict();
export type SourceResources = z.infer<typeof sourceResourcesSchema>;
export const reviewedSourceResources: SourceResources = {
  scriptsBucket: "isg-esatp-rcc-scripts-os",
  scriptsPrefix: "glue/dv-v0.0.1/core/commons/",
};
export function sourceGlueJobName(
  number: number,
  envPrefix: string,
  resources?: SourceResources,
) {
  return `${resources?.jobNamePrefix ?? `${envPrefix}-prep_reclass-gljo-extract_`}${number}`;
}
export function sourceMachineName(
  workflow: SourceWorkflow,
  settings: { envPrefix: string; resources?: SourceResources },
  reviewedName: string,
) {
  return (
    settings.resources?.stateMachines?.[workflow] ??
    reviewedName.replace(/^isg-esatp-dv/, settings.envPrefix)
  );
}
