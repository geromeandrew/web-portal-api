import {
  bayanBillCycleSuffixes,
  processingPipelineSeedRequirements as baseRequirements,
} from "./processingPipelineCatalog010.js";

export type ProcessingPipelineFileRequirement = {
  pipelineCode: string;
  fileName: string;
  match: "exact" | "glob";
  legacyPackageName: string | null;
  jobName: string | null;
};

type Definition = readonly [string, string | null, "glob"?];

const normalizedBaseRequirements: ProcessingPipelineFileRequirement[] =
  baseRequirements
    .filter(
      (requirement) =>
        ![
          "bss_billcycle_bayn",
          "bss_billcycle_glob",
          "bss_billcycle_inov",
          "iccbs_bayn",
          "aprm_voice_accrual",
          "aprm_voice_delta",
          "prepaid_reclass",
        ].includes(requirement.pipelineCode),
    )
    .map((requirement) => ({
      pipelineCode: requirement.pipelineCode,
      fileName: requirement.fileName.replace(/\.xlsx$/i, ".XLSX"),
      match: requirement.match,
      legacyPackageName: requirement.legacyPackageName,
      jobName: requirement.jobName,
    }));

const requirements: ProcessingPipelineFileRequirement[] = [
  ...normalizedBaseRequirements,
];

function add(pipelineCode: string, definitions: readonly Definition[]) {
  for (const [fileName, legacyPackageName, match] of definitions) {
    requirements.push({
      pipelineCode,
      fileName,
      match: match === "glob" ? "glob" : "exact",
      legacyPackageName,
      jobName: null,
    });
  }
}

function addBillCycle(
  pipelineCode: string,
  definitions: readonly (readonly [string, string])[],
) {
  add(
    pipelineCode,
    definitions.flatMap(([fileName, packageName]) =>
      bayanBillCycleSuffixes.map(
        (cycle) =>
          [
            fileName.replace(/_01(?=\.[^.]+$)/, `_${cycle}`),
            packageName,
          ] as Definition,
      ),
    ),
  );
}

addBillCycle("bss_billcycle_bayn", [
  [
    "308. Billed Adjustments Monthly Summary Report_B_01.XLSX",
    "MyBss_Bayan_308_Billed_Adjustments.dtsx",
  ],
  [
    "318. Billed Charges Summary Report_B_01.XLSX",
    "MyBss_Bayan_318_Billed_Charges.dtsx",
  ],
  ["411. Bill Control_PHP_B_01.XLSX", "MyBss_Bayan_411_Bill_Control_PHP.dtsx"],
  ["411. Bill Control_USD_B_01.XLSX", "MyBss_Bayan_411_Bill_Control_USD.dtsx"],
  ["sap_glbilled_B_01.XLSX", "MyBss_Bayan_sapglbilled.dtsx"],
]);
addBillCycle("bss_billcycle_glob", [
  [
    "318. Billed Charges Summary Report_G_01.XLSX",
    "MyBss_Globe_318_Billed_Charges.dtsx",
  ],
  ["411. Bill Control_PHP_G_01.XLSX", "MyBss_Globe_411_Bill_Control_PHP.dtsx"],
  ["sap_glbilled_G_01.XLSX", "MyBss_Globe_sapglbilled.dtsx"],
]);
addBillCycle("bss_billcycle_inov", [
  [
    "308. Billed Adjustments Monthly Summary Report_I_01.XLSX",
    "MyBss_Innove_308_Billed_Adjustments.dtsx",
  ],
  [
    "318. Billed Charges Summary Report_I_01.XLSX",
    "MyBss_Innove_318_Billed_Charges.dtsx",
  ],
  ["411. Bill Control_PHP_I_01.XLSX", "MyBss_Innove_411_Bill_Control_PHP.dtsx"],
  ["411. Bill Control_USD_I_01.XLSX", "MyBss_Innove_411_Bill_Control_USD.dtsx"],
  ["sap_glbilled_I_01.XLSX", "MyBss_Innove_sapglbilled.dtsx"],
]);

add("iccbs_bayn", [
  ...["01", "02", "10", "12"].flatMap((month) =>
    ["03", "05", "06", "08", "12", "15", "16", "21", "26", "31"].map(
      (cycle) =>
        [
          `bl_act_trans_ext_BT_${month}${cycle}.txt`,
          "ICCBS_bl_act_trans_ext_BT_mmdd.dtsx",
        ] as Definition,
    ),
  ),
  ["sap_bdef_PHP.txt", "ICCBS_sap_bdef_PHP.dtsx"],
  ["sap_bdef_USD.txt", "ICCBS_sap_bdef_USD.dtsx"],
  ["sap_blcb_USD.txt", "ICCBS_sap_blcb_USD.dtsx"],
  ["sap_blcu_PHP.txt", "ICCBS_sap_blcu_PHP.dtsx"],
]);

add("aprm_voice_accrual", [
  ["AUR Extract FINAL_BILLING.XLSX", "APRM_AUR_Extract_FinalBilling.dtsx"],
  ["ICEXT_BYN_A_VOICE.TXT", "APRM_ICEXT_BYN_A_VOICE.dtsx"],
  ["ICEXT_GLB_A_VOICE.TXT", "APRM_ICEXT_GLB_A_VOICE.dtsx"],
  ["ICEXT_INV_A_VOICE.TXT", "APRM_ICEXT_INV_A_VOICE.dtsx"],
  ["Prime_Accumulated_Usage.csv", "APRM_Prime_Accumulated_Usage.dtsx"],
  ["SAP_REPORT_BYN_ACCRUAL.CSV", "APRM_SAP_REPORT_BYN_ACCRUAL.dtsx"],
  ["SAP_REPORT_GLB_ACCRUAL.CSV", "APRM_SAP_REPORT_GLB_ACCRUAL.dtsx"],
  ["SAP_REPORT_INV_ACCRUAL.CSV", "APRM_SAP_REPORT_INV_ACCRUAL.dtsx"],
  ["ICEXT_BYN_A_VOICE_output.TXT", "APRM_ICEXT_BYN_A_VOICE_output.dtsx"],
  ["ICEXT_INV_A_VOICE_output.TXT", "APRM_ICEXT_INV_A_VOICE_output.dtsx"],
  ["ICEXT_GLB_A_VOICE_output.TXT", "APRM_ICEXT_GLB_A_VOICE_output.dtsx"],
]);
add("aprm_voice_delta", [
  ["ICEXT_BYN_I_VOICE.TXT", "APRM_SAP_BYN_DELTA_VOICE.dtsx"],
  ["ICEXT_GLB_I_VOICE.TXT", "APRM_SAP_GLB_DELTA_VOICE.dtsx"],
  ["ICEXT_INV_I_VOICE.TXT", "APRM_SAP_INV_DELTA_VOICE.dtsx"],
  ["SAP_REPORT_BYN_DELTA.CSV", "APRM_SAP_REPORT_BYN_DELTA_VOICE.dtsx"],
  ["SAP_REPORT_BYN_FINAL.CSV", "APRM_SAP_BYN_FINAL_VOICE.dtsx"],
  ["SAP_REPORT_GLB_DELTA.CSV", "APRM_SAP_REPORT_GLB_DELTA_VOICE.dtsx"],
  ["SAP_REPORT_GLB_FINAL.CSV", "APRM_SAP_REPORT_GLB_FINAL_VOICE.dtsx"],
  ["SAP_REPORT_INV_DELTA.CSV", "APRM_SAP_REPORT_INV_DELTA_VOICE.dtsx"],
  ["SAP_REPORT_INV_FINAL.CSV", "APRM_SAP_REPORT_INV_FINAL_VOICE.dtsx"],
  ["ICEXT_GLB_I_VOICE_P1_OUTPUT.TXT", "APRM_ICEXT_GLB_I_VOICE_P1_success.dtsx"],
  ["ICEXT_GLB_I_VOICE_P2_OUTPUT.TXT", "APRM_ICEXT_GLB_I_VOICE_P2_success.dtsx"],
  ["ICEXT_INV_I_VOICE_P1_OUTPUT.TXT", "APRM_ICEXT_INV_I_VOICE_P1_success.dtsx"],
  ["ICEXT_INV_I_VOICE_P2_OUTPUT.TXT", "APRM_ICEXT_INV_I_VOICE_P2_success.dtsx"],
  ["ICEXT_BYN_I_VOICE_P1_OUTPUT.TXT", "APRM_ICEXT_BYN_I_VOICE_P1_success.dtsx"],
  ["ICEXT_BYN_I_VOICE_P2_OUTPUT.TXT", "APRM_ICEXT_BYN_I_VOICE_P2_success.dtsx"],
]);

add("prepaid_reclass", [
  ...[
    [
      "308. Billed Adjustments Monthly Summary Report_G_BC01.XLSX",
      "Prepaid_308_Billed_Adj.dtsx",
    ],
    [
      "318. Billed Charges Summary Report_G_BC01.XLSX",
      "Prepaid_318_Billed_Charges.dtsx",
    ],
  ].flatMap(([fileName, packageName]) =>
    bayanBillCycleSuffixes.map(
      (cycle) =>
        [
          fileName.replace("01.XLSX", `${cycle}.XLSX`),
          packageName,
        ] as Definition,
    ),
  ),
  ["CALLCARD_SG.XLSX", "Prepaid_CallCard_SG.dtsx"],
  ["CALLCARD_EG.XLSX", "Prepaid_CallCard_EG.dtsx"],
  ["LOAD API_EG.XLSX", "Prepaid_Load_API_EG.dtsx"],
  ["Load API_SG.XLSX", "Prepaid_Load_API_SG.dtsx"],
  ["LOAD UP_EG.XLSX", "Prepaid_Load_UP_EG.dtsx"],
  ["Load UP_SG.XLSX", "Prepaid_Load_UP_SG.dtsx"],
  [
    "DL_Monthly_Recharge_summary_report.csv",
    "Prepaid_DL_Monthly_Recharge.dtsx",
  ],
  ["KE24.XLSX", "Prepaid_KE24.dtsx"],
]);

export const processingPipelineSeedRequirements = requirements;
