import { jvHeaders, manualIntegrationSchema } from "./contracts.js";
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
  },
  freeze: {
    egSqlAgentJob: "Prepaid_Reclass_Preload_P10_EG_Only_AdHoc",
    sgSqlAgentJob: "Prepaid_Reclass_Preload_P10_SG_Only_AdHoc",
    currentMode: "manual_staging",
  },
  billingCycles: {
    tables: ["zPARAM_ICCBS_AllBillCycles", "dczPARAM_ICCBS_AllBillCycles"],
    cycleRowsAvailable: false,
  },
  journal: {
    view: "webPrepaidSystems_JV01",
    headers: [...jvHeaders],
    columnCount: jvHeaders.length,
    contentRulesImplemented: true,
    transportFormatDefined: false,
  },
} as const;

export function prepaidConfigurationReadiness(stored: unknown) {
  const parsed = manualIntegrationSchema.safeParse(stored);
  const messages = {
    ingestStateMachine: {
      configured:
        "Ingestion name configured; deployment and V2 execution still require verification.",
      required:
        "Configure the deployed Standard V2 ingestion adapter. The legacy SQL Agent job name is not an AWS configuration.",
    },
    expectedCycles: {
      configured:
        "Billing-cycle coverage configured; confirm it against the approved source period.",
      required:
        "Configure actual required billing cycles. The supplied legacy cycle-table definitions contain no cycle rows.",
    },
    format: {
      configured:
        "Manual export format configured; SAP acceptance still requires verification.",
      required:
        "Configure an approved delimiter, line ending and encoding. Legacy JV content is implemented, but its export job format is not supplied.",
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
