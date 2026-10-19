import ExcelJS from "exceljs";
import { unzipSync, strFromU8 } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { reportWorkbook } from "../src/modules/prepaid/infrastructure/reportWorkbook.js";
import { frozenReports } from "../src/modules/prepaid/application/reportService.js";
import {
  jvHeaders,
  manualIntegrationSchema,
} from "../src/modules/prepaid/domain/contracts.js";
import { prepaidConfigurationReadiness } from "../src/modules/prepaid/domain/integrationReadiness.js";

describe("Native XLSX manual Prepaid reports", () => {
  const format = {
    fileType: "xlsx",
    profile: "prepaid-manual-xlsx-v1",
    approved: true,
  } as const;
  it("accepts XLSX without text-transport settings and still requires explicit approval", () => {
    const config = {
      ingestStateMachine: "approved-adapter",
      expectedCycles: ["01"],
      format,
    };
    expect(manualIntegrationSchema.parse(config).format).toEqual(format);
    expect(prepaidConfigurationReadiness(config).integrationConfigured).toBe(
      true,
    );
    for (const invalid of [
      { ...format, approved: false },
      { ...format, fileType: "csv" },
      { fileType: "xlsx", approved: true },
    ])
      expect(
        manualIntegrationSchema.safeParse({ ...config, format: invalid })
          .success,
      ).toBe(false);
  });
  it("creates a real workbook preserving all 40 JV headers, exact decimals, leading zeros and literal text", async () => {
    const precise = "-12345678901234567890.0000000001";
    const bytes = await reportWorkbook([
      {
        name: "JV",
        headers: jvHeaders,
        rows: [
          {
            "Account or Matchcode for theNext Line Item": "0000000123",
            "Amount in local currency": precise,
            Text: '=HYPERLINK("https://invalid.example","not executed")',
            Text2: "Unicode ₱ & <test>\nnext line",
          },
        ],
      },
    ]);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(bytes as any);
    const sheet = book.getWorksheet("JV")!;
    expect(sheet.getRow(1).values).toEqual([undefined, ...jvHeaders]);
    expect(sheet.getCell("M2").value).toBe("0000000123");
    expect(sheet.getCell("O2").value).toBe(precise);
    expect(sheet.getCell("J2").type).toBe(ExcelJS.ValueType.String);
    expect(sheet.getCell("U2").value).toBe("Unicode ₱ & <test>\nnext line");
    const parts = unzipSync(bytes);
    expect(parts["[Content_Types].xml"]).toBeDefined();
    expect(strFromU8(parts["xl/worksheets/sheet1.xml"])).not.toContain("<f>");
  });
  it("keeps bytes deterministic and preserves empty JV headers", async () => {
    const input = [{ name: "JV", headers: jvHeaders, rows: [] }];
    expect(await reportWorkbook(input)).toEqual(await reportWorkbook(input));
  });
  it("rejects oversized cells and workbooks instead of silently truncating", async () => {
    await expect(
      reportWorkbook([
        { name: "JV", headers: ["Text"], rows: [{ Text: "a".repeat(32768) }] },
      ]),
    ).rejects.toMatchObject({ status: 413 });
    await expect(
      reportWorkbook([
        {
          name: "JV",
          headers: ["Text"],
          rows: Array(250000).fill({ Text: "x" }),
        },
      ]),
    ).rejects.toMatchObject({ status: 413 });
  });
  it("puts a four-sheet workbook per XLSX revision in History and leaves historical text profiles untouched", async () => {
    const query = vi.fn(async (sql: string, args?: string[]) => {
      if (sql.includes('FROM "test".prepaid_region_revisions'))
        return {
          rows: [
            { id: "new", region: "eg", revision: 2, format },
            {
              id: "old",
              region: "sg",
              revision: 1,
              format: {
                profile: "old",
                approved: true,
                delimiter: "\t",
                lineEnding: "\r\n",
                encoding: "utf8",
              },
            },
          ],
        };
      if (sql.includes('FROM "test".prepaid_jv_lines'))
        return {
          rows: [
            { fields: { Text: args![0], "Amount in local currency": "1.00" } },
          ],
        };
      if (sql.includes('FROM "test".prepaid_'))
        return {
          rows: [
            {
              id: "excluded",
              revision_id: "excluded",
              label: "source",
              amount: "1.00",
            },
          ],
        };
      return { rows: [] };
    });
    const runs = {
      repo: {
        transaction: async (fn: any) => fn({ query }),
        own: async () => ({ configuration: {} }),
        table: (table: string) => `"test".prepaid_${table}`,
      },
    } as any;
    const zip = await frozenReports(runs, "actor", "run", "snapshot");
    const files = unzipSync(zip);
    expect(Object.keys(files)).toEqual([
      "eg-r2-reports.xlsx",
      "sg-r1-layout_rows.csv",
      "sg-r1-allocations.csv",
      "sg-r1-reconciliation_rows.csv",
      "sg-r1-jv.txt",
    ]);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(Buffer.from(files["eg-r2-reports.xlsx"]) as any);
    expect(book.worksheets.map((sheet) => sheet.name)).toEqual([
      "Layout",
      "Allocation",
      "Reconciliation",
      "JV",
    ]);
    expect(strFromU8(files["sg-r1-jv.txt"])).toContain("\t");
    expect(await frozenReports(runs, "actor", "run", "snapshot")).toEqual(zip);
  });
});
