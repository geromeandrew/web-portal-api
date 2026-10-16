import { z } from "zod";

/** The four existing AWS workflows are called unchanged with {env_prefix}. */
export const sourceWorkflows = {
  callcard_sg: {
    machine: "isg-esatp-dv-prcl_cc_sg-sf",
    jobs: [1],
    sources: ["callcard_sg"],
    inputPattern: "CALLCARD_SG.xlsx",
    targets: ["dccallcard_sg"],
  },
  load_api_eg: {
    machine: "isg-esatp-dv-prcl_la_eg-sf",
    jobs: [2],
    sources: ["load_api_eg"],
    inputPattern: "LOAD API_EG.xlsx",
    targets: ["dcload_api"],
  },
  load_api_sg: {
    machine: "isg-esatp-dv-prcl_la_sg-sf",
    jobs: [3],
    sources: ["load_api_sg"],
    inputPattern: "LOAD API_SG.xlsx",
    targets: ["dcload_api_sg"],
  },
  adjustments_308: {
    machine: "isg-esatp-dv-prcl_308_ba-sf",
    jobs: [4, 5],
    sources: ["308_*"],
    inputPattern: "308. Billed Adjustments Monthly Summary Report_G_B**.xlsx",
    targets: [
      "billed_adjustments_header_cycles",
      "billed_adjustments_lineitem_cycles",
    ],
  },
} as const;
export type SourceWorkflow = keyof typeof sourceWorkflows;
export const sourceWorkflowSchema = z.enum([
  "callcard_sg",
  "load_api_eg",
  "load_api_sg",
  "adjustments_308",
]);
export const sourceExtractionSchema = z
  .object({
    envPrefix: z.literal("isg-esatp-dv"),
    // The unchanged Glue jobs replace shared legacy raw rows. Never silently opt
    // an existing configuration into those side effects.
    sharedWritesApproved: z.literal(true),
  })
  .strict();
export const extractedSourceSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  key: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const extractionArtifactSchema = z.object({
  sourceId: z.string().uuid(),
  sourceCode: z.string(),
  name: z.enum(["callcard", "loadapi", "adjustments", "adjustment_headers"]),
  key: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  rowCount: z.number().int().nonnegative(),
});
export const extractionReceiptSchema = z.object({
  contractVersion: z.literal(1),
  phase: z.literal("complete"),
  workflow: sourceWorkflowSchema,
  sessionId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  preparationId: z.string().uuid(),
  sourceVersion: z.number().int().nonnegative(),
  executionArn: z.string().min(1),
  // Preserve readability of historical receipts; new receipts are backend-owned.
  scriptSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  normalizerRevision: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  producer: z.literal("backend").optional(),
  sources: z.array(extractedSourceSchema).min(1),
  artifacts: z.array(extractionArtifactSchema).min(1),
});
export const unprovidedExtractionDependencies = [
  "KE24 extraction and accounting-period discovery",
  "Call Card EG extraction",
  "Load Up EG/SG extraction",
  "Monthly Recharge extraction",
  "318 billing-charge extraction",
  "Approved SAP reference refresh",
] as const;

function choiceMatches(
  condition: any,
  input: Record<string, unknown>,
): boolean {
  if (condition.And)
    return condition.And.every((c: any) => choiceMatches(c, input));
  if (condition.Or)
    return condition.Or.some((c: any) => choiceMatches(c, input));
  if (condition.Not) return !choiceMatches(condition.Not, input);
  if (
    typeof condition.Variable !== "string" ||
    !/^\$\.[A-Za-z0-9_.]+$/.test(condition.Variable)
  )
    throw Error("Unsupported extraction Choice expression.");
  let value: any = input;
  for (const key of condition.Variable.slice(2).split("."))
    value = value?.[key];
  if ("IsPresent" in condition)
    return (value !== undefined) === condition.IsPresent;
  if ("StringEquals" in condition) return value === condition.StringEquals;
  if ("NumericEquals" in condition)
    return typeof value === "number" && value === condition.NumericEquals;
  throw Error("Unsupported extraction Choice operator.");
}

/** Read-only contract inspection. No Portal* state names/parameters are required,
 * and this function never modifies the supplied definition.
 */
export function validateLegacySourceDefinition(
  workflow: SourceWorkflow,
  definition: string,
  envPrefix: string,
) {
  const input = { env_prefix: envPrefix },
    actual = JSON.parse(definition);
  const expected = sourceWorkflows[workflow].jobs.map(
    (job) => `${envPrefix}-prep_reclass-gljo-extract_${job}`,
  );
  let next = actual.StartAt;
  const jobs: string[] = [],
    visited = new Set<string>();
  while (next) {
    if (visited.has(next) || visited.size > 30)
      throw Error("Extraction workflow contains an unsupported loop.");
    visited.add(next);
    const state = actual.States?.[next];
    if (!state) throw Error("Extraction workflow references a missing state.");
    if (state.Type === "Choice") {
      next =
        state.Choices?.find((c: any) => choiceMatches(c, input))?.Next ??
        state.Default;
      if (!next)
        throw Error("Execution input does not select an extraction branch.");
      continue;
    }
    if (state.Type === "Succeed") {
      next = undefined;
      break;
    }
    if (
      state.Type !== "Task" ||
      state.Resource !== "arn:aws:states:::glue:startJobRun.sync"
    )
      throw Error("Expected a supported synchronous Glue extraction task.");
    const parameters = state.Parameters ?? {};
    if (
      (state.InputPath !== undefined && state.InputPath !== "$") ||
      (state.OutputPath !== undefined && state.OutputPath !== "$") ||
      state.ResultSelector ||
      state.Catch ||
      Object.keys(parameters).some(
        (key) => !["JobName", "JobName.$", "Arguments"].includes(key),
      )
    )
      throw Error(
        "Unsupported extraction input/output shaping or task overrides.",
      );
    const expression = parameters["JobName.$"];
    const dynamic =
      typeof expression === "string"
        ? expression.match(
            /^States\.Format\('\{\}-prep_reclass-gljo-extract_(\d+)'\s*,\s*\$\.env_prefix\s*\)$/,
          )
        : undefined;
    const name =
      parameters.JobName ??
      (dynamic
        ? `${envPrefix}-prep_reclass-gljo-extract_${dynamic[1]}`
        : undefined);
    if (!name || name !== expected[jobs.length])
      throw Error(
        "Extraction workflow calls unexpected Glue jobs or job order.",
      );
    const args = parameters.Arguments ?? {};
    for (const [key, value] of Object.entries(args)) {
      if (
        key === "--previous_job_run_id.$" &&
        typeof value === "string" &&
        value.endsWith(".JobRunId")
      )
        throw Error(
          "The 308 workflow has an internal JobRunId handoff incompatible with the observed Glue Id result. Its owner must correct the workflow; the backend will not edit it.",
        );
      if (!(
        workflow === "adjustments_308" &&
        jobs.length === 1 &&
        ["--previous_job_run_id.$", "--previous_job_state.$"].includes(key)
      ))
        throw Error(
          "Unexpected Glue argument override in the extraction workflow.",
        );
    }
    if (
      workflow === "adjustments_308" &&
      jobs.length === 0 &&
      state.ResultPath !== "$.extract_4_output"
    )
      throw Error(
        "308 header output must be preserved for the existing detail handoff.",
      );
    if (
      workflow === "adjustments_308" &&
      jobs.length === 1 &&
      (args["--previous_job_run_id.$"] !== "$.extract_4_output.Id" ||
        args["--previous_job_state.$"] !== "$.extract_4_output.JobRunState")
    )
      throw Error(
        "Unsupported 308 header/detail handoff; request review from the workflow owner.",
      );
    if (
      jobs.length === expected.length - 1 &&
      state.ResultPath !== undefined &&
      state.ResultPath !== "$"
    )
      throw Error("The workflow must return its native final Glue job result.");
    jobs.push(name);
    if (state.End) {
      next = undefined;
      break;
    }
    next = state.Next;
    if (!next)
      throw Error("Extraction task has no terminal state or next task.");
  }
  if (jobs.length !== expected.length)
    throw Error("Extraction workflow does not cover all expected Glue tasks.");
  return { input, jobs };
}
