import ExcelJS from "exceljs";
import { unzipSync, zipSync } from "fflate";
import { AppError } from "../../../errors.js";

export interface ReportSheet {
  name: string;
  headers: readonly string[];
  rows: Record<string, unknown>[];
}

const maximumCells = 250_000;
const maximumTextBytes = 32 * 1024 * 1024;
const epoch = new Date("1980-01-01T00:00:00Z");
const monetaryHeaders: Record<string, ReadonlySet<string>> = {
  Layout: new Set([
    "gp_mt_gross", "hy_mt_gross", "gp_bb_gross", "total_gross",
    "gp_mt_net", "hy_mt_net", "gp_bb_net", "total_net",
  ]),
  Allocation: new Set(["amount", "denominator", "gross", "amount2"]),
  Reconciliation: new Set(["gross", "amount", "tax_amount", "total_gross", "difference"]),
  JV: new Set(["Amount in local currency"]),
  AMAXEE: new Set(["Amount"]),
};
const tooLarge = () =>
  new AppError(
    413,
    "PREPAID_REPORT_TOO_LARGE",
    "This workbook exceeds synchronous export limits; no rows or cells were truncated.",
  );

/** Actual OOXML. Monetary strings remain exact and use grouped display. */
export async function reportWorkbook(sheets: ReportSheet[]): Promise<Buffer> {
  if (
    !sheets.length ||
    new Set(sheets.map((sheet) => sheet.name)).size !== sheets.length ||
    sheets.some(
      (sheet) =>
        !sheet.name ||
        sheet.name.length > 31 ||
        /[\\/?*\[\]:]/.test(sheet.name),
    )
  )
    throw Error("Invalid workbook worksheet names.");
  if (
    sheets.reduce(
      (count, sheet) => count + (sheet.rows.length + 1) * sheet.headers.length,
      0,
    ) > maximumCells
  )
    throw tooLarge();
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "ES-ATP";
  workbook.lastModifiedBy = "ES-ATP";
  workbook.created = epoch;
  workbook.modified = epoch;
  let textBytes = 0;
  const value = (input: unknown): string | null => {
    if (input == null) return null;
    const text =
      input instanceof Date
        ? input.toISOString()
        : typeof input === "object"
          ? JSON.stringify(input)
          : String(input);
    textBytes += Buffer.byteLength(text);
    if (text.length > 32767 || textBytes > maximumTextBytes) throw tooLarge();
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text))
      throw Error("A report cell contains unsupported XML control characters.");
    return text;
  };
  for (const input of sheets) {
    const sheet = workbook.addWorksheet(input.name, {
      views: [{ state: "frozen", ySplit: 1 }],
    });
    // Strings are never interpreted as formulas, hyperlinks or JS floating point.
    sheet.addRow(input.headers.map(value));
    sheet.getRow(1).font = { bold: true };
    for (const row of input.rows)
      sheet.addRow(input.headers.map((header) => {
        const text = value(row[header]);
        if (text === null || !monetaryHeaders[input.name]?.has(header) ||
            !/^-?\d+(?:\.\d+)?$/.test(text)) return text;
        const [integer, fraction] = text.split(".");
        return integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",") +
          (fraction === undefined ? "" : `.${fraction}`);
      }));
  }
  const bytes = await workbook.xlsx.writeBuffer();
  // Pin inner ZIP timestamps too, so re-downloading a frozen report is stable.
  const parts = unzipSync(new Uint8Array(bytes));
  return Buffer.from(
    zipSync(
      Object.fromEntries(
        Object.keys(parts)
          .sort()
          .map((name) => [name, parts[name]]),
      ),
      { level: 6, mtime: new Date(1980, 0, 1) },
    ),
  );
}
