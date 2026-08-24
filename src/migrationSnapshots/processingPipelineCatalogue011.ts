import {
  bayanBillCycleSuffixes,
  processingPipelineSeedRequirements as baseRequirements,
} from "./processingPipelineCatalog010.js";

type ProcessingPipelineFileRequirement = {
  pipelineCode: string;
  stage: "inbound";
  fileName: string;
  match: "exact" | "glob";
  legacyPackageName: string | null;
  jobName: string | null;
};

export const bayanBillCycleStateMachines = {
  billedAdjustments: {
    code: "bayan_billcycle_308_preload",
    name: "isg-esatp-dv-bss_billcycle_bayn_preload-state_machine_308",
  },
  billedCharges: {
    code: "bayan_billcycle_318_preload",
    name: "isg-esatp-dv-bss_billcycle_bayn_preload-state_machine_318",
  },
  billControlPhp: {
    code: "bayan_billcycle_411_php_preload",
    name: "isg-esatp-dv-bss_billcycle_bayn_preload-state_machine_411PHP",
  },
  billControlUsd: {
    code: "bayan_billcycle_411_usd_preload",
    name: "isg-esatp-dv-bss_billcycle_bayn_preload-state_machine_411USD",
  },
  sapGlbilled: {
    code: "bayan_billcycle_sapglbilled_preload",
    name: "isg-esatp-dv-bss_billcycle_bayn_preload-state_machine_SAP_glbilled",
  },
} as const;

export const globeBillCycleStateMachines = {
  billedAdjustments: {
    code: "globe_billcycle_308_preload",
    name: "isg-esatp-dv-bss_billcycle_glob_preload-state_machine_308",
  },
  billedCharges: {
    code: "globe_billcycle_318_preload",
    name: "isg-esatp-dv-bss_billcycle_glob_preload-state_machine_318",
  },
  billControlPhp: {
    code: "globe_billcycle_411_php_preload",
    name: "isg-esatp-dv-bss_billcycle_glob_preload-state_machine_411G",
  },
  sapGlbilled: {
    code: "globe_billcycle_sapglbilled_preload",
    name: "isg-esatp-dv-bss_billcycle_glob_preload-state_machine_SAPgbilled",
  },
} as const;

const cycles = bayanBillCycleSuffixes;
const billCycleRequirements = (
  pipelineCode: string,
  definitions: readonly [string, string][],
) =>
  definitions.flatMap(([fileName, legacyPackageName]) =>
    cycles.map((cycle) => ({
      pipelineCode,
      stage: "inbound" as const,
      fileName: fileName.replace(/_01(?=\.[^.]+$)/, `_${cycle}`),
      match: "exact" as const,
      legacyPackageName,
      jobName: null,
    })),
  );

export const processingPipelineSeedRequirements: ProcessingPipelineFileRequirement[] =
  [
    ...baseRequirements.filter(
      (item) =>
        ![
          "bss_billcycle_bayn",
          "bss_billcycle_glob",
          "bss_billcycle_inov",
          "memo_sst",
          "iccbs_bayn",
          "prepaid_reclass",
        ].includes(item.pipelineCode),
    ),
    ...billCycleRequirements("bss_billcycle_bayn", [
      [
        "308. Billed Adjustments Monthly Summary Report_G_01.XLSX",
        "MyBss_Bayan_308_Billed_Adjustments.dtsx",
      ],
      [
        "318. Billed Charges Summary Report_G_01.XLSX",
        "MyBss_Bayan_318_Billed_Charges.dtsx",
      ],
      [
        "411. Bill Control_PHP_G_01.XLSX",
        "MyBss_Bayan_411_Bill_Control_PHP.dtsx",
      ],
      [
        "411. Bill Control_USD_G_01.XLSX",
        "MyBss_Bayan_411_Bill_Control_USD.dtsx",
      ],
      ["sap_glbilled_G_01.XLSX", "MyBss_Bayan_sapglbilled.dtsx"],
    ]),
    ...billCycleRequirements("bss_billcycle_glob", [
      [
        "308. Billed Adjustments Monthly Summary Report_G_01.XLSX",
        "MyBss_Globe_308_Billed_Adjustments.dtsx",
      ],
      [
        "318. Billed Charges Summary Report_G_01.XLSX",
        "MyBss_Globe_318_Billed_Charges.dtsx",
      ],
      [
        "411. Bill Control_PHP_G_01.XLSX",
        "MyBss_Globe_411_Bill_Control_PHP.dtsx",
      ],
      ["sap_glbilled_G_01.XLSX", "MyBss_Globe_sapglbilled.dtsx"],
    ]),
    ...billCycleRequirements("bss_billcycle_inov", [
      [
        "308. Billed Adjustments Monthly Summary Report_I_01.XLSX",
        "MyBss_Innove_308_Billed_Adjustments.dtsx",
      ],
      [
        "318. Billed Charges Summary Report_I_01.XLSX",
        "MyBss_Innove_318_Billed_Charges.dtsx",
      ],
      [
        "411. Bill Control_PHP_I_01.XLSX",
        "MyBss_Innove_411_Bill_Control_PHP.dtsx",
      ],
      [
        "411. Bill Control_USD_I_01.XLSX",
        "MyBss_Innove_411_Bill_Control_USD.dtsx",
      ],
      ["sap_glbilled_I_01.XLSX", "MyBss_Innove_sapglbilled.dtsx"],
    ]),
    ...[
      "3PComms",
      "BillsPrinting",
      "Caretakers",
      "CarRental",
      "Dental",
      "Freight",
      "Fuel",
      "Generika",
      "GroupInsurance",
      "Hospital",
      "Insurance",
      "Janitorial",
      "LeasedLinesV1",
      "LeasedLinesV2",
      "Mercury",
      "Messengerial",
      "NewProponent",
      "Optical",
      "UtilUnEndorsed",
      "UtilEndorsed",
      "Travel",
      "TaxesLicenses",
      "Security",
      "PDReimb",
    ].flatMap((name) =>
      ["01", "02", "03"].map((suffix) => ({
        pipelineCode: "memo_sst",
        stage: "inbound" as const,
        fileName: `${name}_${suffix}.xlsx`,
        match: "exact" as const,
        legacyPackageName: "Memo_Format04_38Columns.dtsx",
        jobName: null,
      })),
    ),
    ...["01", "02", "10", "12"].flatMap((month) =>
      ["03", "05", "06", "08", "12", "15", "16", "21", "26", "31"].map(
        (cycle) => ({
          pipelineCode: "iccbs_bayn",
          stage: "inbound" as const,
          fileName: `bl_act_trans_ext_BT_${month}${cycle}.txt`,
          match: "exact" as const,
          legacyPackageName: "ICCBS_bl_act_trans_ext_BT_mmdd.dtsx",
          jobName: null,
        }),
      ),
    ),
    ...[
      "sap_bdef_PHP.txt",
      "sap_bdef_USD.txt",
      "sap_blcb_USD.txt",
      "sap_blcu_PHP.txt",
    ].map((fileName) => ({
      pipelineCode: "iccbs_bayn",
      stage: "inbound" as const,
      fileName,
      match: "exact" as const,
      legacyPackageName: `ICCBS_${fileName.replace(".txt", "")}.dtsx`,
      jobName: null,
    })),
    ...[
      [
        "308. Billed Adjustments Monthly Summary Report_G_BC01.XLSX",
        "Prepaid_308_Billed_Adj.dtsx",
      ],
      [
        "318. Billed Charges Summary Report_G_BC01.XLSX",
        "Prepaid_318_Billed_Charges.dtsx",
      ],
    ].flatMap(([fileName, legacyPackageName]) =>
      cycles.map((cycle) => ({
        pipelineCode: "prepaid_reclass",
        stage: "inbound" as const,
        fileName: fileName.replace("01.XLSX", `${cycle}.XLSX`),
        match: "exact" as const,
        legacyPackageName,
        jobName: null,
      })),
    ),
    ...baseRequirements.filter(
      (item) =>
        item.pipelineCode === "prepaid_reclass" &&
        !item.fileName.startsWith("308.") &&
        !item.fileName.startsWith("318."),
    ),
  ];
