/**
 * Immutable input for historical migration 006.
 *
 * Migration 007 removes this short-lived taxonomy.  Keep this snapshot only
 * so a brand-new database can replay the already-released migration exactly.
 */
export const processingPipelineDomains = [
  ["billing", "Billing", "Recurring billing-cycle processing."], ["end-of-month", "End of Month", "Month-end billing and financial processing."],
  ["memo", "Memo", "Memo standard-template processing."], ["iccbs", "ICCBS", "ICCBS financial and transaction processing."],
  ["aprm", "APRM", "APRM voice revenue processing."], ["isms", "ISMS", "ISMS actualization and discount processing."],
  ["north", "North", "North operational source-file processing."], ["prepaid-reclassification", "Prepaid Reclassification", "Prepaid reclassification processing."],
] as const;

export const processingPipelineSourceSystems = [
  ["bss", "BSS", "Billing support system."], ["memo", "Memo", "Memo template source."], ["iccbs", "ICCBS", "ICCBS source."], ["aprm", "APRM", "APRM source."], ["isms", "ISMS", "ISMS source."], ["north", "North", "North source."], ["prepaid", "Prepaid", "Prepaid source."],
] as const;

export const processingPipelineFilePurposes = [
  ["billed-adjustments", "Billed Adjustments", "Billed adjustment reports."], ["billed-charges", "Billed Charges", "Billed charge reports."], ["bill-control", "Bill Control", "Billing control reports."], ["financial-interface", "Financial Interface", "Financial and SAP interface files."],
  ["unbilled-adjustments", "Unbilled Adjustments", "Unbilled adjustment reports."], ["unbilled-charges", "Unbilled Charges", "Unbilled charge reports."], ["unearned-msf", "Unearned MSF", "Unearned MSF reports."], ["unconfirmed-advanced-msf", "Unconfirmed Advanced MSF", "Unconfirmed advanced MSF reports."],
  ["memo-standard-template", "Memo Standard Template", "Memo template inputs."], ["iccbs-transaction", "ICCBS Transaction", "ICCBS transaction extracts."], ["voice-accrual", "Voice Accrual", "APRM voice accrual files."], ["voice-delta", "Voice Delta", "APRM voice delta files."],
  ["ibob-actualization", "IBOB Actualization", "ISMS IBOB actualization files."], ["iot-discount", "IOT Discount", "ISMS IOT discount files."], ["north-source-file", "North Source File", "North operational source files."], ["prepaid-callcard", "Prepaid CallCard", "Prepaid CallCard inputs."],
  ["prepaid-load-api", "Prepaid Load API", "Prepaid Load API inputs."], ["prepaid-load-up", "Prepaid Load UP", "Prepaid Load UP inputs."], ["prepaid-monthly-recharge", "Prepaid Monthly Recharge", "Prepaid recharge reports."], ["prepaid-ke24", "Prepaid KE24", "Prepaid KE24 inputs."],
] as const;

export const processingPipelineMetadata = {
  bss_billcycle_glob: { code: "bss_billcycle_glob", label: "BSS Bill Cycles - Globe", description: "Globe billing-cycle inputs.", domainCode: "billing", sourceSystemCode: "bss" }, bss_billcycle_inov: { code: "bss_billcycle_inov", label: "BSS Bill Cycles - Innove", description: "Innove billing-cycle inputs.", domainCode: "billing", sourceSystemCode: "bss" }, bss_billcycle_bayn: { code: "bss_billcycle_bayn", label: "BSS Bill Cycles - Bayan", description: "Bayan billing-cycle inputs.", domainCode: "billing", sourceSystemCode: "bss" },
  bss_eom_glob: { code: "bss_eom_glob", label: "BSS EOM - Globe", description: "Globe end-of-month inputs.", domainCode: "end-of-month", sourceSystemCode: "bss" }, bss_eom_inov: { code: "bss_eom_inov", label: "BSS EOM - Innove", description: "Innove end-of-month inputs.", domainCode: "end-of-month", sourceSystemCode: "bss" }, bss_eom_bayn: { code: "bss_eom_bayn", label: "BSS EOM - Bayan", description: "Bayan end-of-month inputs.", domainCode: "end-of-month", sourceSystemCode: "bss" },
  memo_sst: { code: "memo_sst", label: "Memo Standard Template", description: "Memo standard-template inputs.", domainCode: "memo", sourceSystemCode: "memo" }, iccbs_inov: { code: "iccbs_inov", label: "ICCBS - Innove", description: "Innove ICCBS financial interfaces.", domainCode: "iccbs", sourceSystemCode: "iccbs" }, iccbs_bayn: { code: "iccbs_bayn", label: "ICCBS - Bayan", description: "Bayan ICCBS transactions and financial interfaces.", domainCode: "iccbs", sourceSystemCode: "iccbs" },
  aprm_voice_accrual: { code: "aprm_voice_accrual", label: "APRM Voice - Accrual", description: "APRM voice accrual inputs.", domainCode: "aprm", sourceSystemCode: "aprm" }, aprm_voice_delta: { code: "aprm_voice_delta", label: "APRM Voice - Delta", description: "APRM voice delta inputs.", domainCode: "aprm", sourceSystemCode: "aprm" }, isms_ibob_actzn: { code: "isms_ibob_actzn", label: "ISMS IBOB Actualization", description: "ISMS IBOB actualization inputs.", domainCode: "isms", sourceSystemCode: "isms" }, isms_iot_da: { code: "isms_iot_da", label: "ISMS IOT Discount", description: "ISMS IOT discount inputs.", domainCode: "isms", sourceSystemCode: "isms" }, north: { code: "north", label: "North", description: "North operational source inputs.", domainCode: "north", sourceSystemCode: "north" }, prepaid_reclass: { code: "prepaid_reclass", label: "Prepaid Reclass", description: "Prepaid reclassification inputs.", domainCode: "prepaid-reclassification", sourceSystemCode: "prepaid" },
} as const;

export function processingPipelineFilePurpose(pipelineCode: string, fileName: string) {
  if (pipelineCode.startsWith("bss_billcycle_")) return fileName.startsWith("308.") ? "billed-adjustments" : fileName.startsWith("318.") ? "billed-charges" : fileName.startsWith("411.") ? "bill-control" : "financial-interface";
  if (pipelineCode.startsWith("bss_eom_")) return fileName.startsWith("307.") ? "unbilled-adjustments" : fileName.startsWith("317.") ? "unbilled-charges" : fileName.startsWith("324.") || fileName.startsWith("Unearned") ? "unearned-msf" : fileName.startsWith("Unconfirmed") ? "unconfirmed-advanced-msf" : "financial-interface";
  if (pipelineCode === "memo_sst") return "memo-standard-template"; if (pipelineCode === "iccbs_bayn") return fileName.startsWith("bl_act_trans") ? "iccbs-transaction" : "financial-interface"; if (pipelineCode === "iccbs_inov") return "financial-interface"; if (pipelineCode === "aprm_voice_accrual") return "voice-accrual"; if (pipelineCode === "aprm_voice_delta") return "voice-delta"; if (pipelineCode === "isms_ibob_actzn") return "ibob-actualization"; if (pipelineCode === "isms_iot_da") return "iot-discount"; if (pipelineCode === "north") return "north-source-file";
  if (fileName.startsWith("308.")) return "billed-adjustments"; if (fileName.startsWith("318.")) return "billed-charges"; if (fileName.startsWith("CALLCARD")) return "prepaid-callcard"; if (fileName.startsWith("LOAD API") || fileName.startsWith("Load API")) return "prepaid-load-api"; if (fileName.startsWith("LOAD UP") || fileName.startsWith("Load UP")) return "prepaid-load-up"; if (fileName.startsWith("DL_Monthly")) return "prepaid-monthly-recharge"; return "prepaid-ke24";
}
