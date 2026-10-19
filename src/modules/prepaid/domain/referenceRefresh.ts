import { z } from "zod";
import { periodSchema } from "./contracts.js";

/** Inspected 19 October 2026. This is a reference refresh, not a SAP posting job. */
export const referenceRefreshJob = {
  name: "isg-esatp-dv-sap_to_pg-gljo-ztf0455s",
  scriptBucket: "isg-esatp-rcc-scripts-os",
  scriptKey: "glue/dv-v0.0.1/core/commons/scripts/GlueSapToPg.py",
  scriptSha256:
    "4f0c92d829f7c4f74db9b44e9335b3e38b6cb9105f647e20890919de18d51506",
  connection: "isg-esatp-dv-sap_to_pg-glco-postgres",
  sourceConnection: "isg-esatp-dv-sap_to_pg-glco-sapdb",
  schema: "dgs4hana_tdir1_dbo",
  table: "ztf0455s",
  marker: "--prepaid_reference_request_id",
} as const;

export const legacyReferenceFields = [
  "MANDT",
  "BUKRS",
  "HKONT",
  "BRAND",
  "WWSPA",
  "WWBRD",
  "SPB",
  "WWST",
  "PSTKY",
  "GLDEF",
  "INTLIND",
  "TAXRATE",
  "DUOM",
  "EXSPB",
  "AVERATE",
  "ULI",
  "SUBSER",
] as const;

export const referenceRefreshRequestSchema = z
  .object({
    idempotencyKey: z.string().uuid(),
    period: periodSchema,
    mode: z.enum(["export_existing", "refresh_and_export"]),
    // Legacy specifies client 300, but GLOB is the current portal's narrower scope.
    // Requiring this acknowledgment avoids silently treating it as a legacy rule.
    scopeApproved: z.literal(true),
    sharedWritesApproved: z.literal(true).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.mode === "refresh_and_export" && !value.sharedWritesApproved)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sharedWritesApproved"],
        message:
          "Explicit authorization is required: the existing Glue job overwrites the entire shared ZTF0455S table, not just client 300/GLOB.",
      });
  });

export type ReferenceRefreshRequest = z.infer<
  typeof referenceRefreshRequestSchema
>;
export const referenceTerminalStates = new Set([
  "SUCCEEDED",
  "FAILED",
  "TIMEOUT",
  "STOPPED",
  "ERROR",
  "EXPIRED",
]);
