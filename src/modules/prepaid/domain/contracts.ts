import { z } from "zod";
import { referenceVersionSchema } from "./referenceVersion.js";
import {
  extractionArtifactSchema,
  sourceExtractionSchema,
  sourceWorkflowSchema,
  sourceWorkflows,
} from "./sourceExtraction.js";

export const regionSchema = z.enum(["eg", "sg"]);
export type Region = z.infer<typeof regionSchema>;
export const moneySchema = z.string().regex(/^-?\d{1,28}(?:\.\d{1,10})?$/);
export const periodSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
  .refine(
    (value) => !value.startsWith("0000-"),
    "Accounting year must be positive",
  );
export const sourceCodes = [
  "ke24",
  "callcard_eg",
  "callcard_sg",
  "load_up_eg",
  "load_up_sg",
  "load_api_eg",
  "load_api_sg",
  "monthly_recharge",
] as const;
export const sourceNames: Record<string, string> = {
  ke24: "KE24.XLSX",
  callcard_eg: "CALLCARD_EG.XLSX",
  callcard_sg: "CALLCARD_SG.XLSX",
  load_up_eg: "LOAD UP_EG.XLSX",
  load_up_sg: "Load UP_SG.XLSX",
  load_api_eg: "LOAD API_EG.XLSX",
  load_api_sg: "Load API_SG.XLSX",
  monthly_recharge: "DL_Monthly_Recharge_summary_report.csv",
};
export const sourceCodeSchema = z
  .string()
  .refine(
    (x) =>
      sourceCodes.includes(x as (typeof sourceCodes)[number]) ||
      /^(308|318)_\d{2}$/.test(x),
    "Unknown Prepaid source code",
  );
export function expectedName(code: string) {
  if (sourceNames[code]) return sourceNames[code];
  const [report, cycle] = code.split("_");
  return report === "308"
    ? `308. Billed Adjustments Monthly Summary Report_G_BC${cycle}.XLSX`
    : `318. Billed Charges Summary Report_G_BC${cycle}.XLSX`;
}

// Confirmed SourceFiles_File rows in restored etl_db_web. These identify the
// same source; they do not authorize a different financial template or mapping.
const legacyFileAliases: Record<string, string[]> = {
  callcard_eg: ["EG CALLCARD.xlsx"],
  callcard_sg: ["SG CALLCARD.xlsx"],
};
export function acceptedSourceNames(code: string) {
  return [expectedName(code), ...(legacyFileAliases[code] ?? [])];
}
export function matchesSourceName(code: string, name: string) {
  return acceptedSourceNames(code).some(
    (accepted) => accepted.toLowerCase() === name.toLowerCase(),
  );
}
export function sourceFileRequirement(code: string) {
  return {
    code,
    fileName: expectedName(code),
    ...(legacyFileAliases[code]
      ? { acceptedFileNames: acceptedSourceNames(code) }
      : {}),
  };
}

const base = { period: periodSchema };
const billingRowSchema = z.object({
  ...base,
  cycle: z.string().regex(/^\d{2}$/),
  customer_type: z.string(),
  code: z.string(),
  amount: moneySchema,
  currency: z.literal("PHP"),
});
export const datasetSchemas = {
  ke24: z.object({
    ...base,
    brand: z.string().min(1),
    cfu: z.string().min(1),
    revenue_type: z.string().min(1),
    cost_element: z.string().regex(/^\d{1,10}$/),
    profit_center: z.string().min(1),
    sub_product: z.string().min(1),
    uom: z.string(),
    reference_document: z.string(),
    amount: moneySchema,
    quantity: moneySchema,
    currency: z.literal("PHP"),
  }),
  callcard: z.object({
    ...base,
    region: regionSchema,
    kind: z.enum(["trade", "internal"]),
    month_no: z.number().int().min(1).max(12),
    amount: moneySchema,
  }),
  loadup: z.object({ ...base, region: regionSchema, amount: moneySchema }),
  loadapi: z.object({ ...base, region: regionSchema, amount: moneySchema }),
  recharge: z.object({
    ...base,
    customer_type: z.enum(["E", "S"]),
    method: z.string(),
    channel: z.string(),
    amount: moneySchema,
  }),
  adjustments: billingRowSchema,
  charges: billingRowSchema,
  reference: z.object({
    ...base,
    client: z.literal("300"),
    company: z.literal("GLOB"),
    // Legacy BRAND category, distinct from allocation WWBRD (canonical brand).
    // Optional for older adapters; absence makes membership reporting unverified.
    source_brand: z.string().trim().min(1).optional(),
    posting_key: z.string().trim().optional(),
    cost_element: z.string().regex(/^\d{1,10}$/),
    brand: z.string(),
    cfu: z.string(),
    revenue_type: z.string(),
    sub_product: z.string(),
    tax_rate: moneySchema.refine((v) => Number(v) >= 0 && Number(v) <= 1),
    average_rate: moneySchema.refine((v) => Number(v) >= 0),
    // Legacy C014 passes DUOM through unchanged. Real dev reference records
    // include blank units; retain them rather than inventing EA or dropping rows.
    uom: z.string(),
  }),
};
export type Dataset = keyof typeof datasetSchemas;
export const descriptorSchema = z.object({
  name: z.enum([
    "ke24",
    "callcard",
    "loadup",
    "loadapi",
    "recharge",
    "adjustments",
    "charges",
    "reference",
  ]),
  key: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  rowCount: z.number().int().nonnegative(),
});
export const manifestSchema = z.object({
  contractVersion: z.literal(1),
  runId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  period: periodSchema,
  ingestionId: z.string().uuid(),
  executionArn: z.string().min(1),
  sourceFiles: z.array(
    z.object({
      id: z.string().uuid(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  ),
  coverage: z
    .array(
      z
        .object({
          cycle: z.string().regex(/^\d{2}$/),
          adjustments: z.boolean(),
          charges: z.boolean(),
        })
        .refine(
          (entry) => entry.adjustments || entry.charges,
          "A covered cycle must include at least one billing report",
        ),
    )
    .min(1),
  datasets: z.array(descriptorSchema).min(1),
});
export const upstreamManifestSchema = z.object({
  contractVersion: z.literal(1),
  period: periodSchema,
  provider: z.string().min(1),
  executionArn: z.string().min(1),
  workspaceId: z.string().uuid(),
  coverage: manifestSchema.shape.coverage,
  datasets: z
    .array(descriptorSchema)
    .refine(
      (ds) =>
        ds.length === 2 &&
        new Set(ds.map((d) => d.name)).size === 2 &&
        ds.every((d) => d.name === "adjustments" || d.name === "charges"),
    ),
});
export const integrationSchema = z.object({
  ingestStateMachine: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,80}$/)
    .refine(
      (value) =>
        !Object.values(sourceWorkflows).some(
          (workflow) => workflow.machine === value,
        ),
      "The supplied source workflows are partial extractors, not a complete V2 adapter. Configure them through sourceExtraction, not ingestStateMachine.",
    ),
  deliveryStateMachine: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  target: z.string().min(1).max(100),
  expectedCycles: z
    .array(z.string().regex(/^\d{2}$/))
    .min(1)
    .refine((xs) => new Set(xs).size === xs.length),
  upstreamPrefix: z
    .string()
    .min(1)
    .refine((x) => !x.includes("..") && x.endsWith("/") && !x.startsWith("/")),
  format: z.object({
    profile: z.string().min(1),
    approved: z.literal(true),
    delimiter: z.enum(["\t", "|", ","]),
    lineEnding: z.enum(["\r\n", "\n"]),
    encoding: z.enum(["utf8", "utf16le"]),
    reversalSupported: z.literal(true),
  }),
});
export type Integration = z.infer<typeof integrationSchema>;
const cycleListSchema = integrationSchema.shape.expectedCycles;
const reportCyclesSchema = z
  .object({
    adjustments: cycleListSchema,
    charges: cycleListSchema,
  })
  .strict();
type BillingConfiguration = {
  expectedCycles: string[];
  reportCycles?: z.infer<typeof reportCyclesSchema>;
};
// Legacy 308 and 318 extraction jobs run independently. Retain the historical
// portal paired default unless native configuration explicitly supplies both lists.
export function expectedReportCycles(
  config: BillingConfiguration,
  report: "adjustments" | "charges",
) {
  return config.reportCycles?.[report] ?? config.expectedCycles;
}
export function expectedBillingCoverage(config: BillingConfiguration) {
  return config.expectedCycles.map((cycle) => ({
    cycle,
    adjustments: expectedReportCycles(config, "adjustments").includes(cycle),
    charges: expectedReportCycles(config, "charges").includes(cycle),
  }));
}
export function billingCoverageMatches(
  config: BillingConfiguration,
  coverage: { cycle: string; adjustments: boolean; charges: boolean }[],
) {
  return (
    coverage.length === config.expectedCycles.length &&
    new Set(coverage.map((entry) => entry.cycle)).size === coverage.length &&
    expectedBillingCoverage(config).every((expected) =>
      coverage.some(
        (actual) =>
          actual.cycle === expected.cycle &&
          actual.adjustments === expected.adjustments &&
          actual.charges === expected.charges,
      ),
    )
  );
}
export function requiredBillingSources(config: BillingConfiguration) {
  return expectedBillingCoverage(config).flatMap((entry) => [
    ...(entry.adjustments ? [`308_${entry.cycle}`] : []),
    ...(entry.charges ? [`318_${entry.cycle}`] : []),
  ]);
}
export const referenceExportSchema = z.object({
  key: z.string().min(1),
  prefix: z
    .string()
    .min(1)
    .refine(
      (s) =>
        s.endsWith("/") &&
        !s.startsWith("/") &&
        !s.includes("..") &&
        !s.includes("\\"),
    ),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  rowCount: z.number().int().positive(),
});
// XLSX is an explicit new manual-report contract. Existing frozen delimited
// configurations retain their original bytes; automatic SAP delivery is unchanged.
export const manualReportFormatSchema = z.union([
  integrationSchema.shape.format.extend({
    fileType: z.literal("delimited").optional(),
    reversalSupported: z.boolean().optional(),
  }),
  z.object({
    fileType: z.literal("xlsx"),
    profile: z.string().min(1),
    approved: z.literal(true),
    reversalSupported: z.boolean().optional(),
  }),
]);
// Manual staging needs ingestion and an approved export format, not SAP dispatch.
export const manualIntegrationSchema = integrationSchema
  .extend({
    accountingProfile: z.enum(["legacy_sql_v1"]).optional(),
    referenceValidationPolicy: z.enum(["legacy_all_matches"]).optional(),
    // Optional native sources: old settings retain four external-adapter children.
    // native_sources explicitly selects all ten and backend final assembly.
    sourceExtraction: sourceExtractionSchema.optional(),
    preparationMode: z.enum(["external_adapter", "native_sources"]).optional(),
    reportCycles: reportCyclesSchema.optional(),
    ingestStateMachine: integrationSchema.shape.ingestStateMachine.optional(),
    referenceExport: referenceExportSchema
      .extend({ approved: z.literal(true) })
      .optional(),
    referenceVersion: referenceVersionSchema.optional(),
    // Explicit opt-in; old configurations retain independent gross edits.
    sourceSplitPolicy: z.enum(["independent", "legacy_eg_total"]).optional(),
    deliveryStateMachine:
      integrationSchema.shape.deliveryStateMachine.optional(),
    target: integrationSchema.shape.target.optional(),
    upstreamPrefix: integrationSchema.shape.upstreamPrefix.optional(),
    format: manualReportFormatSchema,
  })
  .superRefine((config, ctx) => {
    if (
      config.referenceValidationPolicy === "legacy_all_matches" &&
      (config.accountingProfile !== "legacy_sql_v1" ||
        !(config.referenceExport || config.referenceVersion))
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["referenceValidationPolicy"],
        message:
          "Legacy reference handling requires legacy_sql_v1 and an approved immutable reference version or export.",
      });
    if (config.reportCycles) {
      const union = new Set([
        ...config.reportCycles.adjustments,
        ...config.reportCycles.charges,
      ]);
      if (
        config.preparationMode !== "native_sources" ||
        union.size !== config.expectedCycles.length ||
        config.expectedCycles.some((cycle) => !union.has(cycle))
      )
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["reportCycles"],
          message:
            "Per-report coverage requires native_sources and its union must exactly match expectedCycles.",
        });
    }
    if (config.preparationMode === "native_sources") {
      if (
        !config.sourceExtraction ||
        config.sourceExtraction.coverage !== "all_sources"
      )
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["sourceExtraction"],
          message:
            "Native preparation requires explicit all_sources coverage and shared-write approval.",
        });
      if (!config.referenceExport && !config.referenceVersion)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["referenceExport"],
          message:
            "Native preparation requires an approved database reference version or immutable SAP reference export.",
        });
      if (config.referenceExport && config.referenceVersion)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["referenceVersion"],
          message:
            "Select exactly one reference source; database versions never fall back to S3.",
        });
    } else if (!config.ingestStateMachine)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ingestStateMachine"],
        message:
          "Configure a complete external V2 adapter, or choose native_sources with all ten workflows and an approved reference export.",
      });
    if (config.referenceVersion && config.preparationMode !== "native_sources")
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["referenceVersion"],
        message:
          "Database reference versions require native_sources preparation.",
      });
  });
export const sessionManifestSchema = manifestSchema
  .omit({ runId: true, ingestionId: true })
  .extend({
    contractVersion: z.literal(2),
    sessionId: z.string().uuid(),
    preparationId: z.string().uuid(),
    sourceVersion: z.number().int().nonnegative(),
    producer: z.literal("backend").optional(),
    referenceSource: referenceExportSchema
      .extend({ approved: z.literal(true) })
      .optional(),
    referenceVersion: referenceVersionSchema.optional(),
    extractionReceipts: z
      .array(
        z.object({
          workflow: sourceWorkflowSchema,
          executionArn: z.string().min(1),
          receiptKey: z.string().min(1),
          artifacts: z.array(extractionArtifactSchema).min(1),
        }),
      )
      .optional(),
  });
export const editSchema = z.object({
  version: z.number().int().nonnegative(),
  reason: z
    .string()
    .trim()
    .min(1)
    .max(1000)
    .default("Layout saved from Prepaid workspace"),
  changes: z
    .array(
      z.object({
        layoutNumber: z.number().int().min(0).max(27),
        field: z.enum(["gp_mt_gross", "hy_mt_gross", "gp_bb_gross"]),
        value: moneySchema.nullable(),
      }),
    )
    .min(1)
    .max(100),
});
export const commandSchema = z.object({
  version: z.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(1000).optional(),
});

export const jvHeaders = [
  "Batch Number",
  "Doc Date",
  "Posting Date",
  "DocType",
  "Company Code",
  "Currency",
  "Date",
  "Fiscal Period",
  "Reference Document Number",
  "Text",
  "Posting Key",
  "Special G/L indicator",
  "Account or Matchcode for theNext Line Item",
  "Reconciliation G/L account",
  "Amount in local currency",
  "Tax on Sales/Purchases Code",
  "I/O Number",
  "Cost center",
  "Profit center",
  "Pegging flag",
  "Text2",
  "exchange rate",
  "trading partner",
  "Partner profit center",
  "Quantity",
  "UOM",
  "BRAND",
  "CFU",
  "sub-product -B",
  "Franchise Area",
  "Business Centre",
  "Revenue/Sales Type",
  "Event/Segment",
  "Payment Term",
  "Payment Method",
  "MVNO PARTNER",
  "TECHNOLOGY",
  "PLAN TYPE",
  "CORE PRODUCT",
  "REVENUE ITEM CODE",
] as const;
export function encodeDelimited(
  rows: Record<string, unknown>[],
  headers: readonly string[],
  delimiter: string,
  lineEnding: string,
  encoding: "utf8" | "utf16le",
) {
  const cell = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return s.includes(delimiter) || /["\r\n]/.test(s)
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };
  return Buffer.from(
    [
      headers.map(cell).join(delimiter),
      ...rows.map((row) => headers.map((h) => cell(row[h])).join(delimiter)),
    ].join(lineEnding) + lineEnding,
    encoding,
  );
}
