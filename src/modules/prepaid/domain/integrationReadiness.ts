import { jvHeaders, manualIntegrationSchema } from "./contracts.js";
import { referenceRefreshJob } from "./referenceRefresh.js";
import {
  sourceWorkflows,
  unprovidedExtractionDependencies,
} from "./sourceExtraction.js";

// These are SQL Agent identities from the supplied legacy procedures, NOT
// deployed AWS state-machine names or permission to execute those jobs.
export const prepaidLegacyBasis = {
  ingestion: {
    procedure: "sp_Prepaid1_Extract",
    sqlAgentJob: "Prepaid_Reclass_Preload_P02_Extract_04Mnt",
    jobStepsAvailable: false,
    awsStateMachineDefined: false,
    suppliedChildWorkflows: sourceWorkflows,
    remainingSourceDependencies: unprovidedExtractionDependencies,
    completeV2AdapterDefined: false,
    backendNativePreparationImplemented: true,
    suppliedSourceWorkflowCount: Object.keys(sourceWorkflows).length,
  },
  freeze: {
    egSqlAgentJob: "Prepaid_Reclass_Preload_P10_EG_Only_AdHoc",
    sgSqlAgentJob: "Prepaid_Reclass_Preload_P10_SG_Only_AdHoc",
    currentMode: "manual_staging",
  },
  referenceSupply: {
    legacySource: "dgS4HANA_TDIR1.dbo.ZTF0455S",
    currentSource: `${referenceRefreshJob.schema}.${referenceRefreshJob.table}`,
    refreshGlueJob: referenceRefreshJob.name,
    backendRefreshExportImplemented: true,
    additionalStateMachineRequired: false,
    wholeTableOverwriteRequiresExplicitAuthorization: true,
    exportApi: "/api/workflows/prepaid/reference-exports",
    liveDataAndMappingApprovalVerified: false,
  },
  billingCycles: {
    tables: ["zPARAM_ICCBS_AllBillCycles", "dczPARAM_ICCBS_AllBillCycles"],
    cycleRowsAvailable: false,
    directPrepaidUseOfTablesVerified: false,
    paired308And318CoverageIsPortalContract: true,
    independentNativeReportCyclesSupported: true,
  },
  journal: {
    view: "webPrepaidSystems_JV01",
    headers: [...jvHeaders],
    columnCount: jvHeaders.length,
    contentRulesImplemented: true,
    transportFormatDefined: false,
    manualReportFileType: "xlsx",
    manualReportFileTypeBasis:
      "User-confirmed; not recovered P10 writer settings",
  },
} as const;

export function prepaidConfigurationReadiness(stored: unknown) {
  const parsed = manualIntegrationSchema.safeParse(stored);
  const native = (stored as any)?.preparationMode === "native_sources";
  const messages = {
    ingestStateMachine: {
      configured: native
        ? "Backend-native preparation configured for ten workflows and an approved reference version or export; runtime acceptance remains unverified."
        : "Ingestion name configured; deployment and V2 execution still require verification.",
      required: native
        ? "Configure all_sources coverage, shared-write approval and an approved database reference version or immutable export for backend-native preparation."
        : "Configure the complete Standard V2 adapter, or choose backend-native preparation with the ten source workflows and an approved reference export.",
    },
    expectedCycles: {
      configured:
        "Billing-cycle coverage configured; confirm completeness for the approved source period. Native reportCycles can explicitly separate 308 and 318; omitted lists retain paired coverage.",
      required:
        "Configure actual required billing cycles. The supplied legacy cycle-table definitions contain no cycle rows.",
    },
    format: {
      configured:
        "Manual export format configured; SAP acceptance still requires verification.",
      required:
        'Configure the confirmed XLSX manual report format with fileType="xlsx", profile and approved=true. Existing delimited profiles remain supported for historical compatibility.',
    },
  };
  const checks = Object.entries(messages).map(([code, message]) => {
    const invalid =
      !parsed.success &&
      parsed.error.issues.some(
        (issue) => !issue.path.length || issue.path[0] === code,
      );
    const status =
      stored == null ? "missing" : invalid ? "invalid" : "configured";
    return {
      code,
      status,
      message: status === "configured" ? message.configured : message.required,
    };
  });
  // Invalid optional settings must not leave every visible check green while
  // readyForUploads is false (for example an unknown sourceSplitPolicy).
  if (!parsed.success && stored != null) {
    const additional = [
      ...new Set(
        parsed.error.issues
          .map((issue) => String(issue.path[0] ?? "configuration"))
          .filter((key) => !(key in messages)),
      ),
    ];
    for (const code of additional)
      checks.push({
        code,
        status: "invalid",
        message: `Correct the invalid ${code} setting through the administrator integration API.`,
      });
  }
  return {
    integrationConfigured: parsed.success,
    checks,
    legacyBasis: prepaidLegacyBasis,
  };
}
