import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { strToU8, strFromU8, zipSync, unzipSync } from "fflate";
import ExcelJS from "exceljs";
import { BackendSourceNormalizer } from "../src/modules/prepaid/infrastructure/sourceNormalizer.js";
import { datasetSchemas } from "../src/modules/prepaid/domain/contracts.js";

const runtime =
  process.env.PREPAID_PYTHON_EXECUTABLE ||
  (process.platform === "win32"
    ? ".venv-prepaid/Scripts/python.exe"
    : ".venv-prepaid/bin/python");
// This is a real local subprocess/XLSX test, not an AWS/Glue invocation. Python
// requirements are an explicit worker runtime dependency documented in the guide.
describe.skipIf(!existsSync(runtime))(
  "Local backend source normalizer runtime",
  () => {
    it.each([
      {
        workflow: "adjustments_308" as const,
        code: "308_21",
        cycle: "21",
        dataset: "adjustments" as const,
        amount: -533.92,
        xmlValue: "-533.91999999999996",
        headers: [
          "Customer Type",
          "Customer Sub Type",
          "Subscriber Type",
          "Adjustment Type",
          "Adjustment Code",
          "Adjustment Reason",
          "Legal Entity",
          "Currency",
          "Amount",
          "Write-Off Activity Indicator",
        ],
        detail: ["E", "", "PRE", "", "AMAXCEP", "", "GLOB", "PHP", -533.92, ""],
      },
      {
        workflow: "charges_318" as const,
        code: "318_27",
        cycle: "27",
        dataset: "charges" as const,
        amount: 284073.71,
        xmlValue: "284073.71000000002",
        headers: [
          "Customer Type",
          "Customer SubType",
          "Subscriber Type",
          "Revenue Type",
          "Charge Code/Tax Code",
          "Charge Type/Tax Type",
          "Discount Plan Code",
          "Total Amount",
          "Document Demand Type",
          "Legal Entity",
          "Currency",
        ],
        detail: [
          "E",
          "",
          "PRE",
          "MT",
          "AMAXCEP",
          "",
          "",
          284073.71,
          "",
          "GLOB",
          "PHP",
        ],
      },
    ])(
      "normalizes real numeric XML artifacts through the runtime boundary: $workflow",
      async (sample) => {
        const book = new ExcelJS.Workbook();
        const sheet = book.addWorksheet("Page1_1");
        sheet.addRows([
          ["Cycle Code:", "BC" + sample.cycle],
          ["Cycle Year:", "2023"],
          ["Cycle Instance:", "9"],
          sample.headers,
          sample.detail,
        ]);
        const parts = unzipSync(new Uint8Array(await book.xlsx.writeBuffer()));
        const key = "xl/worksheets/sheet1.xml";
        const xml = strFromU8(parts[key]);
        expect(xml).toContain(`<v>${sample.amount}</v>`);
        parts[key] = strToU8(
          xml.replace(`<v>${sample.amount}</v>`, `<v>${sample.xmlValue}</v>`),
        );
        const result = await new BackendSourceNormalizer().normalize(
          sample.workflow,
          sample.code,
          Buffer.from(zipSync(parts)),
        );
        expect(result[sample.dataset]).toHaveLength(1);
        expect(
          datasetSchemas[sample.dataset].parse({
            ...(result[sample.dataset][0] as object),
            period: "2023-09",
          }),
        ).toMatchObject({
          cycle: sample.cycle,
          amount: String(sample.amount),
          code: "AMAXCEP",
          customer_type: "E",
          currency: "PHP",
        });
      },
    );
    it("parses real XLSX bytes locally and sums exact Load API EG amounts", async () => {
      const files = {
        "[Content_Types].xml":
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
        "_rels/.rels":
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
        "xl/workbook.xml":
          '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
        "xl/_rels/workbook.xml.rels":
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
        "xl/worksheets/sheet1.xml":
          '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:F5"/><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>header</t></is></c></row><row r="4"><c r="A4" t="inlineStr"><is><t>EG</t></is></c><c r="F4"><v>0.1</v></c></row><row r="5"><c r="A5" t="inlineStr"><is><t>EG</t></is></c><c r="F5"><v>0.2</v></c></row></sheetData></worksheet>',
      };
      const bytes = Buffer.from(
        zipSync(
          Object.fromEntries([
            ...Object.entries(files).map(([key, value]) => [
              key,
              strToU8(value),
            ]),
            ["unused-padding.bin", new Uint8Array(5_000_000)],
          ]),
          { level: 0 },
        ),
      );
      const normalizer = new BackendSourceNormalizer();
      expect(bytes.length).toBeGreaterThan(4_500_000);
      expect(await normalizer.revision()).toMatch(/^[a-f0-9]{64}$/);
      expect(
        await normalizer.normalize("load_api_eg", "load_api_eg", bytes),
      ).toEqual({ loadapi: [{ region: "eg", amount: "0.30" }] });
    });
    it("rejects invalid workbooks without falling back to empty/zero accounting data", async () => {
      await expect(
        new BackendSourceNormalizer().normalize(
          "load_api_eg",
          "load_api_eg",
          Buffer.from("not XLSX"),
        ),
      ).rejects.toThrow("Source normalization failed");
    });
  },
);
