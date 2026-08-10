import type { ProcessingPipelineStage } from "./processingPipelineStorage.js";

export type ProcessingPipelineFileRequirement = {
  id?: number;
  pipelineCode: string;
  stage: ProcessingPipelineStage;
  fileName: string;
  match: "exact" | "glob";
  legacyPackageName: string | null;
  jobName: string | null;
};

export const bayanBillCycleSuffixes = ["01", "06", "08", "10", "11", "13", "16", "18", "21", "24", "27"] as const;
export type BayanBillCycleSuffix = (typeof bayanBillCycleSuffixes)[number];

export const bayanBillCycleStateMachines = {
  billedAdjustments: { code: "bayan_billcycle_308_preload", name: "isg-esatp-dv-bss_billcycle_bayn_308_preload-state_machine" },
  billedCharges: { code: "bayan_billcycle_318_preload", name: "isg-esatp-dv-bss_billcycle_bayn_318_preload-state_machine" },
  billControlPhp: { code: "bayan_billcycle_411_php_preload", name: "isg-esatp-dv-bss_billcycle_bayn_411_PHP_preload-state_machine" },
  billControlUsd: { code: "bayan_billcycle_411_usd_preload", name: "isg-esatp-dv-bss_billcycle_bayn_411_USD_preload-state_machine" },
  sapGlbilled: { code: "bayan_billcycle_sapglbilled_preload", name: "isg-esatp-dv-bss_billcycle_bayn_sapglbilled_preload-state_machine" },
} as const;

export const bayanBillCycleBatchStateMachine = { code: "bayan_billcycle_preload", name: "isg-esatp-dv-bss_billcycle_bayn_preload-state_machine" } as const;

type BayanStateMachineCode = (typeof bayanBillCycleStateMachines)[keyof typeof bayanBillCycleStateMachines]["code"];

export function bayanBillCycleStepFunctionMapping(fileName: string): { stateMachineCode: BayanStateMachineCode; batchCycle: BayanBillCycleSuffix } | null {
  const batchCycle = fileName.match(/_(\d{2})(?=\.[^.]+$)/)?.[1] as BayanBillCycleSuffix | undefined;
  if (!batchCycle || !bayanBillCycleSuffixes.includes(batchCycle)) return null;
  if (fileName.startsWith("308.")) return { stateMachineCode: bayanBillCycleStateMachines.billedAdjustments.code, batchCycle };
  if (fileName.startsWith("318.")) return { stateMachineCode: bayanBillCycleStateMachines.billedCharges.code, batchCycle };
  if (fileName.startsWith("411. Bill Control_PHP")) return { stateMachineCode: bayanBillCycleStateMachines.billControlPhp.code, batchCycle };
  if (fileName.startsWith("411. Bill Control_USD")) return { stateMachineCode: bayanBillCycleStateMachines.billControlUsd.code, batchCycle };
  if (fileName.startsWith("sap_glbilled")) return { stateMachineCode: bayanBillCycleStateMachines.sapGlbilled.code, batchCycle };
  return null;
}

type Definition = readonly [fileName: string, legacySsisPackage: string | null, match?: "glob" | null, etlJobName?: string | null];
const requirements: ProcessingPipelineFileRequirement[] = [];

function add(_pipelineLabel: string, pipelineCode: string, definitions: readonly Definition[]) {
  for (const [fileName, legacySsisPackage, match, etlJobName] of definitions) {
    requirements.push({ pipelineCode, stage: "inbound", fileName, match: match === "glob" ? "glob" : "exact", legacyPackageName: legacySsisPackage, jobName: etlJobName ?? null });
  }
}

add("BSS Bill Cycles - Globe", "bss_billcycle_glob", [
  ["308. Billed Adjustments Monthly Summary Report_G_01.XLSX", "MyBss_Globe_308_Billed_Adjustments.dtsx"], ["318. Billed Charges Summary Report_G_01.XLSX", "MyBss_Globe_318_Billed_Charges.dtsx"], ["411. Bill Control_PHP_G_01.XLSX", "MyBss_Globe_411_Bill_Control_PHP.dtsx"], ["sap_glbilled_G_01.txt", "MyBss_Globe_sapglbilled.dtsx"],
]);
add("BSS Bill Cycles - Innove", "bss_billcycle_inov", [
  ["308. Billed Adjustments Monthly Summary Report_I_01.XLSX", "MyBss_Innove_308_Billed_Adjustments.dtsx"], ["318. Billed Charges Summary Report_I_01.XLSX", "MyBss_Innove_318_Billed_Charges.dtsx"], ["411. Bill Control_PHP_I_01.XLSX", "MyBss_Innove_411_Bill_Control_PHP.dtsx"], ["411. Bill Control_USD_I_01.xlsx", "MyBss_Innove_411_Bill_Control_USD.dtsx"], ["sap_glbilled_I_01.txt", "MyBss_Innove_sapglbilled.dtsx"],
]);
const bayanBillCycleFiles = [
  ["308. Billed Adjustments Monthly Summary Report_B_01.xlsx", "MyBss_Bayan_308_Billed_Adjustments.dtsx"],
  ["318. Billed Charges Summary Report_B_01.XLSX", "MyBss_Bayan_318_Billed_Charges.dtsx"],
  ["411. Bill Control_PHP_B_01.xlsx", "MyBss_Bayan_411_Bill_Control_PHP.dtsx"],
  ["411. Bill Control_USD_B_01.xlsx", "MyBss_Bayan_411_Bill_Control_USD.dtsx"],
  ["sap_glbilled_b_01.txt", "MyBss_Bayan_sapglbilled.dtsx"],
] as const;
add("BSS Bill Cycles - Bayan", "bss_billcycle_bayn", bayanBillCycleFiles.flatMap(([baseFileName, legacySsisPackage]) => bayanBillCycleSuffixes.map((suffix) => [
  baseFileName.replace(/_01(?=\.[^.]+$)/, `_${suffix}`),
  legacySsisPackage,
  null,
] as Definition)));
add("BSS EOM - Globe", "bss_eom_glob", [
  ["307. Unbilled Adjustments Report_G.xlsx", "MyBss_Globe_307_Unbilled_Adjustments.dtsx"], ["317. Unbilled Charges Summary Report_G.xlsx", "MyBss_Globe_317_Unbilled_Charges_Summary.dtsx"], ["Unearned MSF Summary Report_G.xlsx", "MyBss_Globe_324_Unearned_MSF.dtsx"], ["Unconfirmed Advanced MSF Charges Summary Report - Monthly.xlsx", "MyBss_Globe_Unconfirmed_Advance_MSF.dtsx"], ["sap_airc_G.txt", "MyBss_Globe_sap_airc.dtsx"], ["sap_aiuc_G.txt", "MyBss_Globe_sap_aiuc.dtsx"], ["sap_glunbilled_G.txt", "MyBss_Globe_glunbilled.dtsx"], ["sap_glunbilled_unconf_G.txt", "MyBss_Globe_glunbilled_unconf.dtsx"],
]);
add("BSS EOM - Innove", "bss_eom_inov", [
  ["307. Unbilled Adjustments Report_I.xlsx", "MyBss_Innove_307_Unbilled_Adjustments_Report.dtsx"], ["317. Unbilled Charges Summary Report_I.xlsx", "MyBss_Innove_317_Unbilled_Charges_Summary_Report.dtsx"], ["324. Unearned MSF Summary Report_I.xlsx", "MyBss_Innove_324_Unearned_MSF_Summary_Report.dtsx"], ["sap_airc_I.txt", "MyBss_Innove_sap_airc.dtsx"], ["sap_aiuc_I.txt", "MyBss_Innove_sap_aiuc.dtsx"], ["sap_glunbilled_I.txt", "MyBss_Innove_sap_glunbilled.dtsx"], ["sap_glunbilled_unconf_I.txt", "MyBss_Innove_sap_glunbilled_unconf.dtsx"],
]);
add("BSS EOM - Bayan", "bss_eom_bayn", [
  ["307. Unbilled Adjustments Report_B.xlsx", "MyBss_Bayan_307_Unbilled_Adjustments_Report.dtsx"], ["317. Unbilled Charges Summary Report_B.xlsx", "MyBss_Bayan_317_Unbilled_Charges_Summary_Report_V2.dtsx"], ["324. Unearned MSF Summary Report_B.xlsx", "MyBss_Bayan_324_Unearned_MSF_Summary_Report.dtsx"], ["sap_airc_B.txt", "MyBss_Bayan_sap_airc.dtsx"], ["sap_aiuc_B.txt", "MyBss_Bayan_sap_aiuc.dtsx"], ["sap_glunbilled_B.txt", "MyBss_Bayan_sap_glunbilled.dtsx"], ["sap_glunbilled_unconf_B.txt", "MyBss_Bayan_sap_glunbilled_unconf.dtsx"],
]);

const memoFiles = ["3PComms", "BillsPrinting", "Caretakers", "CarRental", "Dental", "Freight", "Fuel", "Generika", "GroupInsurance", "Hospital", "Insurance", "Janitorial", "LeasedLinesV1", "LeasedLinesV2", "Mercury", "Messengerial", "NewProponent", "Optical", "UtilUnEndorsed", "UtilEndorsed", "Travel", "TaxesLicenses", "Security", "PDReimb"];
add("Memo Standard Template", "memo_sst", memoFiles.map((name) => [`${name}_01.xlsx`, "Memo_Format04_38Columns.dtsx", null]));
add("ICCBS - Innove", "iccbs_inov", [
  ["sap_falcon_billed_volvo_for.txt", "ICCBS_sap_falcon_billed_volvo_for.dtsx"], ["sap_falcon_billed_volvo_oss.txt", "ICCBS_sap_falcon_billed_volvo_oss.dtsx"], ["sap_fdef_PHP.txt", "ICCBS_sap_fdef_PHP.dtsx"], ["sap_fdef_USD.txt", "ICCBS_sap_fdef_USD.dtsx"], ["sap_flcb_PHP.txt", "ICCBS_sap_flcb_PHP.dtsx"], ["sap_flcb_USD.txt", "ICCBS_sap_flcb_USD.dtsx"], ["sap_flcu_PHP.txt", "ICCBS_sap_flcu_PHP.dtsx"],
]);
add("ICCBS - Bayan", "iccbs_bayn", [
  ...["1003", "1005", "1006", "1008", "1012", "1015", "1016", "1021", "1026", "1031"].map((value) => [`bl_act_trans_ext_BT_${value}.txt`, "ICCBS_bl_act_trans_ext_BT_mmdd.dtsx", null] as Definition),
  ["sap_bdef_PHP.txt", "ICCBS_sap_bdef_PHP.dtsx"], ["sap_bdef_USD.txt", "ICCBS_sap_bdef_USD.dtsx"], ["sap_blcb_USD.txt", "ICCBS_sap_blcb_USD.dtsx"], ["sap_blcu_PHP.txt", "ICCBS_sap_blcu_PHP.dtsx"],
]);
add("APRM Voice - Accrual", "aprm_voice_accrual", [
  ["AUR Extract FINAL_BILLING.xlsx", "APRM_AUR_Extract_FinalBilling.dtsx"], ["ICEXT_BYN_A_VOICE.TXT", "APRM_ICEXT_BYN_A_VOICE.dtsx"], ["ICEXT_GLB_A_VOICE.TXT", "APRM_ICEXT_GLB_A_VOICE.dtsx"], ["ICEXT_INV_A_VOICE.TXT", "APRM_ICEXT_INV_A_VOICE.dtsx"], ["Prime_Accumulated_Usage.csv", "APRM_Prime_Accumulated_Usage.dtsx"], ["SAP_REPORT_BYN_ACCRUAL.CSV", "APRM_SAP_REPORT_BYN_ACCRUAL.dtsx"], ["SAP_REPORT_GLB_ACCRUAL.CSV", "APRM_SAP_REPORT_GLB_ACCRUAL.dtsx"], ["SAP_REPORT_INV_ACCRUAL.CSV", "APRM_SAP_REPORT_INV_ACCRUAL.dtsx"], ["ICEXT_BYN_A_VOICE_*.TXT", "APRM_ICEXT_BYN_A_VOICE_output.dtsx", "glob"], ["ICEXT_INV_A_VOICE_*.TXT", "APRM_ICEXT_INV_A_VOICE_output.dtsx", "glob"], ["ICEXT_GLB_A_VOICE_*.TXT", "APRM_ICEXT_GLB_A_VOICE_output.dtsx", "glob"],
]);
add("APRM Voice - Delta", "aprm_voice_delta", [
  ["ICEXT_BYN_I_VOICE.TXT", "APRM_SAP_BYN_DELTA_VOICE.dtsx"], ["ICEXT_GLB_I_VOICE.TXT", "APRM_SAP_GLB_DELTA_VOICE.dtsx"], ["ICEXT_INV_I_VOICE.TXT", "APRM_SAP_INV_DELTA_VOICE.dtsx"], ["SAP_REPORT_BYN_DELTA.CSV", "APRM_SAP_REPORT_BYN_DELTA_VOICE.dtsx"], ["SAP_REPORT_BYN_FINAL.CSV", "APRM_SAP_BYN_FINAL_VOICE.dtsx"], ["SAP_REPORT_GLB_DELTA.CSV", "APRM_SAP_REPORT_GLB_DELTA_VOICE.dtsx"], ["SAP_REPORT_GLB_FINAL.CSV", "APRM_SAP_REPORT_GLB_FINAL_VOICE.dtsx"], ["SAP_REPORT_INV_DELTA.CSV", "APRM_SAP_REPORT_INV_DELTA_VOICE.dtsx"], ["SAP_REPORT_INV_FINAL.CSV", "APRM_SAP_REPORT_INV_FINAL_VOICE.dtsx"],
  ["ICEXT_GLB_I_VOICE_*_P1_OUTPUT.TXT", "APRM_ICEXT_GLB_I_VOICE_P1_success.dtsx", "glob"], ["ICEXT_GLB_I_VOICE_*_P2_OUTPUT.TXT", "APRM_ICEXT_GLB_I_VOICE_P2_success.dtsx", "glob"], ["ICEXT_INV_I_VOICE_*_P1_OUTPUT.TXT", "APRM_ICEXT_INV_I_VOICE_P1_success.dtsx", "glob"], ["ICEXT_INV_I_VOICE_*_P2_OUTPUT.TXT", "APRM_ICEXT_INV_I_VOICE_P2_success.dtsx", "glob"], ["ICEXT_BYN_I_VOICE_*_P1_OUTPUT.TXT", "APRM_ICEXT_BYN_I_VOICE_P1_success.dtsx", "glob"], ["ICEXT_BYN_I_VOICE_*_P2_OUTPUT.TXT", "APRM_ICEXT_BYN_I_VOICE_P2_success.dtsx", "glob"],
]);
add("ISMS IBOB Actualization", "isms_ibob_actzn", [["ACT_ISMS_IB_OB_01.xlsx", "ACT_ISMS_IB_OB_01.dtsx"], ["ACT_ISMS_IB_OB_02.xlsx", "ACT_ISMS_IB_OB_02.dtsx"]]);
add("ISMS IOT Discount", "isms_iot_da", [
  ...["Airtel", "DTAG_via_Bridge", "Hutchison", "Orange", "Salt", "Tele2", "Telenor", "Telia_Sonera", "TO2_Telefonica", "Veon_Vimpelcom", "Vodafone"].map((name) => [`${name}.xlsx`, "IOT_DA_Details.dtsx", null] as Definition),
  ...Array.from({ length: 25 }, (_, index) => [`Non_Group_${index + 1}.xlsx`, "IOT_DA_Details.dtsx", null] as Definition),
]);
add("North", "north", [["NV?????.txt", null, "glob"], ["SLS????????.txt", null, "glob"], ["TRF????????.txt", null, "glob"], ["ORD+counter.txt", null]]);
add("Prepaid Reclass", "prepaid_reclass", [
  ["308. Billed Adjustments Monthly Summary Report_G_BC21.XLSX", "Prepaid_308_Billed_Adj.dtsx"], ["CALLCARD_SG.xlsx", "Prepaid_CallCard_SG.dtsx"], ["CALLCARD_EG.xlsx", "Prepaid_CallCard_EG.dtsx"], ["LOAD API_EG.xlsx", "Prepaid_Load_API_EG.dtsx"], ["Load API_SG.xlsx", "Prepaid_Load_API_SG.dtsx"], ["LOAD UP_EG.xlsx", "Prepaid_Load_UP_EG.dtsx"], ["Load UP_SG.xlsx", "Prepaid_Load_UP_SG.dtsx"], ["DL_Monthly_Recharge_summary_report.csv", "Prepaid_DL_Monthly_Recharge.dtsx"], ["KE24.xlsx", "Prepaid_KE24.dtsx"], ["318. Billed Charges Summary Report_G_BC27.xlsx", "Prepaid_318_Billed_Charges.dtsx"],
]);

export const processingPipelineSeedRequirements = requirements;

export function matchesProcessingPipelineRequirement(requirement: ProcessingPipelineFileRequirement, fileName: string) {
  if (requirement.match === "exact") return requirement.fileName.localeCompare(fileName, undefined, { sensitivity: "accent" }) === 0;
  const expression = requirement.fileName.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${expression}$`, "i").test(fileName);
}
