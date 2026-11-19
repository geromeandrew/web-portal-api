import { z } from "zod";
import {
  sourceResourcesSchema,
  sourceGlueJobName,
  type SourceResources,
} from "./sourceResources.js";

/** Verified read-only against the ten supplied native workflows on 18 October 2026.
 * No portal states, script overrides or AWS definition changes are required. */
export const sourceWorkflows = {
  ke24: {
    machine: "isg-esatp-dv-prcl_ke24-sf",
    jobs: [10],
    sources: ["ke24"],
    inputPattern: "KE24.xlsx",
    targets: ["dcKE24"],
    artifacts: ["ke24"],
    format: "xlsx",
  },
  callcard_eg: {
    machine: "isg-esatp-dv-prcl_cc_eg-sf",
    jobs: [6],
    sources: ["callcard_eg"],
    inputPattern: "CALLCARD_EG.xlsx",
    targets: ["dcmanualcallcard"],
    artifacts: ["callcard"],
    format: "xlsx",
  },
  callcard_sg: {
    machine: "isg-esatp-dv-prcl_cc_sg-sf",
    jobs: [1],
    sources: ["callcard_sg"],
    inputPattern: "CALLCARD_SG.xlsx",
    targets: ["dccallcard_sg"],
    artifacts: ["callcard"],
    format: "xlsx",
  },
  load_up_eg: {
    machine: "isg-esatp-dv-prcl_lu_eg-sf",
    jobs: [7],
    sources: ["load_up_eg"],
    inputPattern: "LOAD UP_EG.xlsx",
    targets: ["dcload_up"],
    artifacts: ["loadup"],
    format: "xlsx",
  },
  load_up_sg: {
    machine: "isg-esatp-dv-prcl_lu_sg-sf",
    jobs: [8],
    sources: ["load_up_sg"],
    inputPattern: "LOAD UP_SG.xlsx",
    targets: ["dcload_up_sg"],
    artifacts: ["loadup"],
    format: "xlsx",
  },
  load_api_eg: {
    machine: "isg-esatp-dv-prcl_la_eg-sf",
    jobs: [2],
    sources: ["load_api_eg"],
    inputPattern: "LOAD API_EG.xlsx",
    targets: ["dcload_api"],
    artifacts: ["loadapi"],
    format: "xlsx",
  },
  load_api_sg: {
    machine: "isg-esatp-dv-prcl_la_sg-sf",
    jobs: [3],
    sources: ["load_api_sg"],
    inputPattern: "LOAD API_SG.xlsx",
    targets: ["dcload_api_sg"],
    artifacts: ["loadapi"],
    format: "xlsx",
  },
  monthly_recharge: {
    machine: "isg-esatp-dv-prcl_dl_mr-sf",
    jobs: [9],
    sources: ["monthly_recharge"],
    inputPattern: "DL_Monthly_Recharge_summary_report.csv",
    targets: ["dcmonthlyrechargesummary"],
    artifacts: ["recharge"],
    format: "csv",
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
    artifacts: ["adjustment_headers", "adjustments"],
    format: "xlsx",
    headerResultPath: "$.extract_4_output",
  },
  charges_318: {
    machine: "isg-esatp-dv-prcl_318_bc-sf",
    jobs: [11, 12],
    sources: ["318_*"],
    inputPattern: "318. Billed Charges Summary Report_G_BC**.xlsx",
    targets: ["billed_charges_header_cycles", "billed_charges_lineitem_cycles"],
    artifacts: ["charge_headers", "charges"],
    format: "xlsx",
    headerResultPath: "$.extract_11_output",
  },
} as const;
export type SourceWorkflow = keyof typeof sourceWorkflows;
export const sourceWorkflowSchema = z.enum([
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
]);
export const legacyFourWorkflows: SourceWorkflow[] = [
  "callcard_sg",
  "load_api_eg",
  "load_api_sg",
  "adjustments_308",
];
export const egReportMappingSchema = z
  .object({
    profile: z.literal("provided-eg-reports-v1"),
    approved: z.literal(true),
    callcardScope: z.literal("eg_report").optional(),
    loadupAmount: z.enum(["gross", "net_top_up"]).optional(),
  })
  .strict();
export type EgReportMapping = z.infer<typeof egReportMappingSchema>;
export const sourceExtractionSchema = z
  .object({
    envPrefix: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{1,49}$/),
    resources: sourceResourcesSchema.optional(),
    sharedWritesApproved: z.literal(true),
    // Preserve earlier four-source configuration; expanding shared writes requires
    // an explicit administrator choice, not an automatic upgrade of old sessions.
    coverage: z.enum(["legacy_four", "all_sources"]).default("legacy_four"),
    egReportMapping: egReportMappingSchema.optional(),
    // Omitted preserves existing serial sessions. New reviewed sessions can run
    // disjoint workflows in bounded waves under ONE preparation-owned lock.
    parallelism: z.number().int().min(1).max(3).optional(),
  })
  .strict()
  .superRefine((settings, ctx) => {
    if (settings.envPrefix !== "isg-esatp-dv" && !settings.resources)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["resources"],
        message:
          "A new extraction environment must supply its script bucket and prefix explicitly.",
      });
    const names = Object.values(settings.resources?.stateMachines ?? {});
    if (new Set(names).size !== names.length)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["resources", "stateMachines"],
        message: "Source workflow names must be distinct.",
      });
  });
export function selectedSourceWorkflows(settings: {
  coverage?: string;
}): SourceWorkflow[] {
  return settings.coverage === "all_sources"
    ? (Object.keys(sourceWorkflows) as SourceWorkflow[])
    : [...legacyFourWorkflows];
}
export function sourceBelongsTo(workflow: SourceWorkflow, code: string) {
  const mapping = sourceWorkflows[workflow];
  return mapping.sources.some(
    (pattern) =>
      pattern === code ||
      (pattern.endsWith("_*") &&
        new RegExp("^" + pattern.slice(0, -1) + "[0-9]{2}$").test(code)),
  );
}
export function sourceLandingName(workflow: SourceWorkflow, code: string) {
  if (workflow === "adjustments_308")
    return `308. Billed Adjustments Monthly Summary Report_G_BC${code.slice(4)}.xlsx`;
  if (workflow === "charges_318")
    return `318. Billed Charges Summary Report_G_BC${code.slice(4)}.xlsx`;
  return sourceWorkflows[workflow].inputPattern;
}
export const extractedSourceSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  key: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const extractionArtifactSchema = z.object({
  sourceId: z.string().uuid(),
  sourceCode: z.string(),
  name: z.enum([
    "ke24",
    "callcard",
    "loadup",
    "loadapi",
    "recharge",
    "adjustments",
    "adjustment_headers",
    "charges",
    "charge_headers",
  ]),
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
  financialSource: z.literal("glue_raw_v1").optional(),
  rawCapture: z
    .object({ key: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })
    .strict()
    .optional(),
  egReportMapping: egReportMappingSchema.optional(),
  nativeInputs: z
    .array(
      z
        .object({
          sourceId: z.string().uuid(),
          sourceCode: z.enum(["callcard_eg", "load_up_eg"]),
          key: z.string(),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          size: z
            .number()
            .int()
            .positive()
            .max(100 * 1024 * 1024),
        })
        .strict(),
    )
    .max(2)
    .optional(),
  accountingPeriod: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .optional(),
  sources: z.array(extractedSourceSchema).min(1),
  artifacts: z.array(extractionArtifactSchema).min(1),
});
export const unprovidedExtractionDependencies = [
  "Live reference refresh authorization/data approval, required-cycle policy and real-file accounting acceptance",
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
  resources?: SourceResources,
) {
  const input = { env_prefix: envPrefix },
    actual = JSON.parse(definition);
  const expected = sourceWorkflows[workflow].jobs.map((job) =>
    sourceGlueJobName(job, envPrefix, resources),
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
    const headerPath =
      "headerResultPath" in sourceWorkflows[workflow]
        ? sourceWorkflows[workflow].headerResultPath
        : undefined;
    if (
      expected.length > 1 &&
      jobs.length === 0 &&
      state.ResultPath !== headerPath
    )
      throw Error(
        "Billing header output must be preserved before the sequential detail task.",
      );
    if (
      Object.keys(args).length &&
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
