import {
  reviewedSourceResources,
  type SourceResources,
} from "./sourceResources.js";

/** Parsing/load contracts read from all twelve deployed extractors on 20 October
 * 2026. These checks do not deploy jobs or make their raw tables financial proof.
 * Re-audit the Python implementation before accepting a contract change.
 */
const common = {
  "--include_date": "dateread",
  "--include_filename": "filename",
  "--include_sequenceId": "sequentialid",
  "--row_number_label": "rownum",
  "--valid_columns": "",
  "--skip_header_lines": "0",
  "--target_sheet": "",
  "--target_headers": "",
  "--sql_filter": "",
  "--date_format": "",
  "--delimiter_regex": "",
  "--fail_safe": "false",
  // These options can silently change the table suffix, permitted files or
  // additional write destinations. The inspected Prepaid jobs do not use them.
  "--passed_parameter": "",
  "--allowed_files": "",
  "--audit_table": "",
};

const parsing: Record<number, Record<string, string>> = {
  1: {
    "--skip_header_lines": "4",
    "--target_sheet": "CALLCARD",
    "--date_format": "%B %Y",
    "--valid_columns":
      "column1,trade,column3,column4,column5,column6,INTERNAL (BASED ON SALES),column8,column9,column10,column11,column12,total,column14",
    "--sql_filter": "column1 IS NOT NULL AND column1 NOT LIKE 'year%'",
  },
  2: {
    "--skip_header_lines": "3",
    "--valid_columns":
      "type,App ID,Wallet ID,Company Name,Dev Email,Top up Amount,TOP UP Date,OR Number,OR Date,Payment Type,Date deposited,Gcash Number,Credit Card Reference,column14",
    "--sql_filter": "type IS NOT NULL AND type NOT LIKE 'Type%'",
  },
  3: {
    "--skip_header_lines": "2",
    "--date_format": "%d-%b-%Y",
    "--valid_columns":
      "type,Transactional Discount,App ID,Wallet ID,Company Name,Dev Email,discard_gross,discard_vat,Top up Amount,TOP UP Date,OR Number,OR Date,Payment Type,Date deposited,Transaction ID,discard_bank,discard_remarks,discard_orremarks",
    "--sql_filter": "type IS NOT NULL AND type != 'Type'",
  },
  4: {},
  5: {
    "--target_headers":
      "Customer Type,Customer Sub Type,Subscriber Type,Adjustment Type,Adjustment Code,Adjustment Reason,Legal Entity,Currency,Amount,Write-Off Activity Indicator",
  },
  6: {
    "--skip_header_lines": "1",
    "--valid_columns":
      "count,CUSTOMER NAME,business,date,Doc#,SO#,BillDoc#,description,GROSS AMOUNT,PREPAID CARDS,simcard,SOA AMOUNT,payment,balance,remarks,column16,column17,column18,column19,column20,column21,column22,column23,column24,column25,column26",
    "--sql_filter": "count IS NOT NULL AND count != 'Company Code'",
  },
  7: {
    "--skip_header_lines": "4",
    "--valid_columns":
      "SFA#,type,Company Name,Merchant Name,Merchant Email,Merchant Mobile,Transaction ID,Transaction Date,Payment Method,amount,log,PAYMENT STATUS,status,remarks,Actual Disc (%),Check,column17,column18",
    "--sql_filter": "`SFA#` IS NOT NULL AND `SFA#` != 'CFU'",
  },
  8: {
    "--skip_header_lines": "4",
    "--valid_columns":
      "type,Company Name,Merchant Name,Merchant Email,Merchant Mobile,Transaction ID,Transaction Date,Payment Method,amount,log,status,remarks,Actual Discount,OR Status,column15,column16,column17,column18",
    "--sql_filter": "type IS NOT NULL AND type != 'CFU'",
  },
  9: {
    "--delimiter_regex": ",",
    "--target_headers":
      "RECHARGE DATE,BRAND,CUSTOMER TYPE,SUBSCRIBER TYPE,RECHARGE METHOD,RECHARGE CHANNEL,CR/DR INDICATOR,RECHARGE AMOUNT,FREE TEXT AWARDED,STATUS",
  },
  10: {
    "--target_headers":
      "Period/Year,Document number,Reference document,Item number,Cost Element,Profit Center,Sub-Product Group B,Created On,CACur,Value TranCurr,Total Quantity,Unit of Measure,Posting date,Sub-Product Group A,Brand,Product-Rev Type",
  },
  11: {},
  12: {
    "--target_headers":
      "Customer Type,Customer SubType,Subscriber Type,Revenue Type,Charge Code/Tax Code,Charge Type/Tax Type,Discount Plan Code,Total Amount,Document Demand Type,Legal Entity,Currency",
  },
};

export function sourceJobScript(
  number: number,
  resources: SourceResources = reviewedSourceResources,
) {
  if (!Object.hasOwn(parsing, number))
    throw Error("Unknown Prepaid extractor.");
  return `s3://${resources.scriptsBucket}/${resources.scriptsPrefix}scripts/${number === 9 ? "GlueCsv.py" : "GlueSpreadsheetWildcard.py"}`;
}

/** Blank source templates use the same ordinal contract as dispatch checks.
 * They supply structure only, never source records or an approved conversion.
 */
export function egSourceTemplateContract(number: 6 | 7) {
  return {
    columns: parsing[number]["--valid_columns"].split(","),
    skippedRows: Number(parsing[number]["--skip_header_lines"]),
  };
}

/** Empty optional values have the same meaning as absence in the audited
 * wrappers. Only skip=0 and fail_safe=false have explicit wrapper defaults.
 * Filter SQL and ordinal casing are deliberately not rewritten here.
 */
export function sourceJobArgumentDrift(
  number: number,
  args: Record<string, string>,
  envPrefix: string,
  resources?: SourceResources,
): string[] {
  if (!Object.hasOwn(parsing, number))
    throw Error("Unknown Prepaid extractor.");
  const expected: Record<string, string> = {
    ...common,
    ...parsing[number],
    "--connection_name":
      resources?.connectionName ?? `${envPrefix}-prep_reclass-glco-postgres`,
  };
  return Object.entries(expected)
    .filter(([key, value]) => {
      let actual = args[key] ?? "";
      if (key === "--skip_header_lines" && !actual) actual = "0";
      if (key === "--fail_safe" && !actual) actual = "false";
      return actual !== value;
    })
    .map(([key]) => key);
}
