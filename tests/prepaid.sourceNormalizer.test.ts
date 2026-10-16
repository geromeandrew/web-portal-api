import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { BackendSourceNormalizer } from "../src/modules/prepaid/infrastructure/sourceNormalizer.js";

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
          Object.fromEntries(
            Object.entries(files).map(([key, value]) => [key, strToU8(value)]),
          ),
        ),
      );
      const normalizer = new BackendSourceNormalizer();
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
