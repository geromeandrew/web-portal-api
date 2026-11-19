"""Real workbook/CSV regression fixtures; no AWS or application DB access."""
import csv
import io
import re
import sys
import unittest
import zipfile
from decimal import Decimal
from unittest.mock import patch
from pathlib import Path

import openpyxl

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "infrastructure" / "prepaid"))
from normalize_source import normalize, KE24_HEADERS, CHARGE_HEADERS, RECHARGE_HEADERS
from portal_source_extract import MAX_SOURCE_BYTES, workbook_rows, billing_money, HEADERS


def workbook(rows):
    book = openpyxl.Workbook()
    for row in rows:
        book.active.append(row)
    result = io.BytesIO()
    book.save(result)
    book.close()
    return result.getvalue()


def ke24_row(period="009/2026", currency="PHP"):
    return [period, "DOC", "REF", "1", "0000000123", "P1", "SUB", "", currency,
            "-100.25", "10.50", "EA", "", "EG", "GP", "MT"]


class AllSourceNormalizationTests(unittest.TestCase):
    def test_billing_numeric_cells_match_native_reader_without_rounding_each_row_to_cents(self):
        examples = [("-533.91999999999996", "-533.92"),
                    ("284073.71000000002", "284073.71"),
                    ("62639.839999999997", "62639.84"),
                    ("21921507.670000002", "21921507.67")]
        for raw, expected in examples:
            with self.subTest(raw=raw):
                self.assertEqual(billing_money(Decimal(raw)), expected)
                if Decimal(raw).as_tuple().exponent < -10:
                    with self.assertRaisesRegex(ValueError, "precision"):
                        billing_money(raw)  # A text decimal is not an Excel double.
                else:
                    self.assertEqual(billing_money(raw), raw)
        self.assertEqual(billing_money(Decimal("1.2345678901")), "1.2345678901")
        self.assertEqual(billing_money(Decimal("1.2300000000000")), "1.23")
        self.assertEqual(billing_money("-5.2500"), "-5.2500")
        for raw in ("0.00000000001", "1.12345678901"):
            with self.assertRaisesRegex(ValueError, "precision"):
                billing_money(Decimal(raw))

    def test_streamed_308_and_318_numeric_xml_artifacts_retain_native_totals(self):
        leading = [["Cycle Code:", "BC21"], ["Cycle Year:", "2023"], ["Cycle Instance:", "9"]]
        detail = ["E", "", "PRE", "", "AMAXCEP", "", "GLOB", "PHP", -533.92, ""]
        body = workbook(leading + [HEADERS, detail])
        def numeric_xml(original, old, new):
            result = io.BytesIO()
            with zipfile.ZipFile(io.BytesIO(original)) as source, zipfile.ZipFile(result, "w", zipfile.ZIP_DEFLATED) as target:
                for item in source.infolist():
                    value = source.read(item)
                    if item.filename == "xl/worksheets/sheet1.xml":
                        self.assertIn(old, value)
                        value = value.replace(old, new)
                    target.writestr(item, value)
            return result.getvalue()
        body = numeric_xml(body, b"<v>-533.92</v>", b"<v>-533.91999999999996</v>")
        result = normalize("adjustments_308", "308_21", body)
        self.assertEqual(result["adjustments"][0]["amount"], "-533.92")
        leading[0][1] = "BC27"
        charge = ["E", "", "PRE", "MT", "AMAXCEP", "", "", 284073.71, "", "GLOB", "PHP"]
        body = numeric_xml(workbook(leading + [CHARGE_HEADERS, charge]),
                           b"<v>284073.71</v>", b"<v>284073.71000000002</v>")
        self.assertEqual(normalize("charges_318", "318_27", body)["charges"][0]["amount"], "284073.71")

    def test_inflated_formatting_dimension_is_not_treated_as_financial_data(self):
        original = workbook([KE24_HEADERS, ke24_row()])
        result = io.BytesIO()
        with zipfile.ZipFile(io.BytesIO(original)) as source, zipfile.ZipFile(result, "w", zipfile.ZIP_DEFLATED) as target:
            for item in source.infolist():
                body = source.read(item)
                if item.filename == "xl/worksheets/sheet1.xml":
                    body = re.sub(br'<dimension ref="[^"]+"', b'<dimension ref="A1:XFD1048576"', body)
                target.writestr(item, body)
        self.assertEqual(normalize("ke24", "ke24", result.getvalue())["ke24"][0]["amount"], "-100.25")

    def test_blank_formatted_columns_are_ignored_but_financial_columns_are_not(self):
        for value in (None, "unrecognized financial data"):
            book = openpyxl.Workbook()
            book.active.append(KE24_HEADERS)
            book.active.append(ke24_row())
            book.active.cell(2, 200, value).number_format = "0.00"
            output = io.BytesIO()
            book.save(output)
            book.close()
            if value is None:
                self.assertEqual(len(normalize("ke24", "ke24", output.getvalue())["ke24"]), 1)
            else:
                with self.assertRaisesRegex(ValueError, "columns/cells exceed"):
                    normalize("ke24", "ke24", output.getvalue())

    def test_uncached_formula_in_an_otherwise_empty_tail_is_not_discarded(self):
        with self.assertRaisesRegex(ValueError, "formula without a cached value"):
            workbook_rows(workbook([["title"], [], ["=1+2"]]), "ke24")

    def test_real_xlsx_above_previous_4_5mb_limit_is_supported(self):
        body = io.BytesIO(workbook([KE24_HEADERS, ke24_row()]))
        with zipfile.ZipFile(body, "a", compression=zipfile.ZIP_STORED) as archive:
            archive.writestr("unused-padding.bin", b"x" * 5_000_000)
        self.assertGreater(len(body.getvalue()), 4_500_000)
        self.assertEqual(normalize("ke24", "ke24", body.getvalue())["ke24"][0]["amount"], "-100.25")

    def test_workbook_cell_guard_is_not_removed_by_larger_upload_limit(self):
        self.assertEqual(MAX_SOURCE_BYTES, 104857600)
        with patch("portal_source_extract.MAX_WORKBOOK_CELLS", 2):
            with self.assertRaisesRegex(ValueError, "cells exceed"):
                workbook_rows(workbook([["a", "b", "c"]]), "ke24")

    def test_ke24_headers_and_decimal_classification(self):
        result = normalize("ke24", "ke24", workbook([KE24_HEADERS, ke24_row()]))["ke24"]
        self.assertEqual(result[0]["period"], "2026-09")
        self.assertEqual(result[0]["amount"], "-100.25")
        self.assertEqual(result[0]["quantity"], "10.50")
        self.assertEqual(result[0]["cost_element"], "0000000123")
        self.assertEqual((result[0]["brand"], result[0]["cfu"], result[0]["revenue_type"]), ("GP", "EG", "MT"))

    def test_ke24_rejects_mixed_periods_special_periods_and_other_currencies(self):
        for rows in ([ke24_row(), ke24_row("008/2026")], [ke24_row("013/2026")],
                     [ke24_row("009/0000")], [ke24_row(currency="USD")]):
            with self.subTest(rows=rows), self.assertRaises(ValueError):
                normalize("ke24", "ke24", workbook([KE24_HEADERS] + rows))

    def test_ke24_rejects_missing_and_ambiguous_headers(self):
        for headers in (KE24_HEADERS[:-1], KE24_HEADERS + ["Cost Element"]):
            with self.subTest(headers=headers), self.assertRaises(ValueError):
                normalize("ke24", "ke24", workbook([headers, ke24_row()]))

    def test_callcard_eg_retains_per_row_precision_for_legacy_sql_rounding(self):
        rows = [["title"], [1, "", "EG", "", "", "", "", "", "1.50"],
                [2, "", "EG", "", "", "", "", "", "1.50"],
                [3, "", "SG", "", "", "", "", "", "100.00"]]
        result = normalize("callcard_eg", "callcard_eg", workbook(rows), "2026-09")["callcard"]
        self.assertEqual([r["amount"] for r in result], ["1.50", "1.50"])
        self.assertTrue(all(r["month_no"] == 9 and r["region"] == "eg" for r in result))
        with self.assertRaisesRegex(ValueError, "verified KE24"):
            normalize("callcard_eg", "callcard_eg", workbook(rows))

    def test_loadup_eg_and_sg_use_distinct_verified_ordinals(self):
        leading = [["title"]] * 4
        eg = normalize("load_up_eg", "load_up_eg", workbook(leading + [
            ["SFA", "EG", "", "", "", "", "", "", "", "12.25"],
            ["SFA", "EG", "", "", "", "", "", "", "", "-2.00"],
            ["SFA", "SG", "", "", "", "", "", "", "", "200.00"]]))
        sg = normalize("load_up_sg", "load_up_sg", workbook(leading + [
            ["SG", "", "", "", "", "", "", "", "2.50"]]))
        self.assertEqual(eg["loadup"], [{"region": "eg", "amount": "10.25"}])
        self.assertEqual(sg["loadup"], [{"region": "sg", "amount": "2.50"}])

    def test_recharge_csv_handles_quotes_and_retains_signs_and_filters(self):
        stream = io.StringIO(newline="")
        writer = csv.writer(stream)
        writer.writerow(RECHARGE_HEADERS)
        writer.writerows([
            ["2026-09-01", "GP", "E", "PRE", "PS", "RP", "CR", "-10.25", 'a,"b"', "OK"],
            ["2026-09-01", "GP", "S", "PRE", "PS", "RP", "DR", "3.50", "", "OK"],
            ["2026-09-01", "GP", "E", "PRE", "OTHER", "RP", "CR", "100", "", "OK"],
            ["2026-09-01", "GP", "X", "PRE", "PS", "RP", "CR", "100", "", "OK"]])
        result = normalize("monthly_recharge", "monthly_recharge", stream.getvalue().encode("utf-8-sig"))["recharge"]
        self.assertEqual([r["amount"] for r in result], ["-10.25", "3.50"])
        self.assertEqual([r["customer_type"] for r in result], ["E", "S"])

    def test_recharge_requires_correct_columns_and_strict_amounts(self):
        with self.assertRaises(ValueError):
            normalize("monthly_recharge", "monthly_recharge", b"CUSTOMER TYPE,RECHARGE AMOUNT\nE,5\n")
        stream = io.StringIO(newline="")
        writer = csv.writer(stream)
        writer.writerow(RECHARGE_HEADERS)
        writer.writerow(["date", "GP", "E", "PRE", "PS", "RP", "CR", "invalid", "", "OK"])
        with self.assertRaises(ValueError):
            normalize("monthly_recharge", "monthly_recharge", stream.getvalue().encode())

    def test_318_header_and_detail_preserve_cycle_code_and_sign(self):
        rows = [["Cycle Code:", "BC01"], ["Cycle Year:", "2026"], ["Cycle Instance:", "9"],
                CHARGE_HEADERS, ["E", "", "PRE", "MT", "AMAXCEP", "", "", "-5.25", "", "GLOB", "PHP"],
                ["S", "", "PRE", "MT", "AMAXCEP", "", "", "50", "", "GLOB", "USD"]]
        result = normalize("charges_318", "318_01", workbook(rows))
        self.assertEqual(result["charge_headers"], [{"cycle": "01", "cycleYear": "2026", "cycleInstance": "9"}])
        self.assertEqual(result["charges"], [{"cycle": "01", "customer_type": "E", "code": "AMAXCEP", "amount": "-5.25", "currency": "PHP"}])
        with self.assertRaisesRegex(ValueError, "header cycle"):
            normalize("charges_318", "318_06", workbook(rows))

    def test_source_cannot_be_claimed_by_another_workflow(self):
        with self.assertRaisesRegex(ValueError, "does not belong"):
            normalize("load_up_eg", "load_up_sg", workbook([["title"]]))


if __name__ == "__main__":
    unittest.main()
