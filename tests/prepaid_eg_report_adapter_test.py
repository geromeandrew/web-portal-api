import base64
import io
import sys
import unittest
import zipfile
from pathlib import Path
from decimal import Decimal
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "infrastructure" / "prepaid"))
import openpyxl
from normalize_source import normalize, prepare
from eg_report_adapter import financial


MAPPING = {"profile": "provided-eg-reports-v1", "approved": True,
           "callcardScope": "eg_report", "loadupAmount": "gross"}


def workbook(rows):
    book = openpyxl.Workbook()
    for row in rows:
        book.active.append(row)
    for row in book.active:
        for cell in row:
            if isinstance(cell.value, str):
                cell.data_type = "s"
    out = io.BytesIO()
    book.save(out)
    book.close()
    return out.getvalue()


def callcard():
    return workbook([["Company Code", "SO Number", "Customer", "Gross Amount", "SO Date"],
                     ["GLOB", "ORD1", "=not_a_formula_in_output", "1.50", "2023-09-01"],
                     ["GLOB", "ORD2", "Customer", "1.50", "2023-09-01"],
                     [None, None, None, "3.00"]])


def loadup():
    return workbook([["summary"], [], [], [], ["CFU", "Transaction ID", "GROSS", "VAT", "NET TOP UP"],
                     ["EG", "TX1", "112.00", "12.00", "100.00"],
                     ["SG", "TX2", "224.00", "24.00", "200.00"]])


class EgReportAdapterTests(unittest.TestCase):
    def test_both_unresolved_policies_fail_closed(self):
        for workflow, body, key in [("callcard_eg", callcard(), "callcardScope"), ("load_up_eg", loadup(), "loadupAmount")]:
            for mapping in [None, {**MAPPING, "approved": False}, {k: v for k, v in MAPPING.items() if k != key}]:
                with self.subTest(workflow=workflow), self.assertRaisesRegex(ValueError, "EG_REPORT_MAPPING_REQUIRED"):
                    prepare(workflow, workflow, body, "2023-09", mapping)

    def test_callcard_named_headers_and_individual_rounding_are_preserved(self):
        result = prepare("callcard_eg", "callcard_eg", callcard(), "2023-09", MAPPING)
        rows = result["datasets"]["callcard"]
        self.assertEqual([r["amount"] for r in rows], ["1.50", "1.50"])
        self.assertEqual(sum(Decimal(r["amount"]).quantize(Decimal("1"), rounding="ROUND_HALF_UP") for r in rows), Decimal(4))
        native = base64.b64decode(result["landing"])
        self.assertEqual(normalize("callcard_eg", "callcard_eg", native, "2023-09"), result["datasets"])
        book = openpyxl.load_workbook(io.BytesIO(native), data_only=False)
        self.assertEqual(book.active.cell(1, 3).value, "business")
        self.assertEqual(book.active.cell(2, 2).data_type, "s")
        self.assertEqual(book.active.cell(2, 2).value, "=not_a_formula_in_output")
        book.close()

    def test_loadup_basis_is_explicit_and_real_cfu_filters_other_regions(self):
        for basis, total in [("gross", "112.00"), ("net_top_up", "100.00")]:
            with self.subTest(basis=basis):
                result = prepare("load_up_eg", "load_up_eg", loadup(), None, {**MAPPING, "loadupAmount": basis})
                self.assertEqual(result["datasets"], {"loadup": [{"region": "eg", "amount": total}]})
                native = base64.b64decode(result["landing"])
                self.assertEqual(normalize("load_up_eg", "load_up_eg", native), result["datasets"])
                book = openpyxl.load_workbook(io.BytesIO(native))
                self.assertEqual(book.active.cell(4, 1).value, "SFA#")
                self.assertEqual(book.active.cell(5, 2).value, "EG")
                self.assertEqual(book.active.cell(5, 10).value, total)
                book.close()

    def test_adapted_bytes_are_deterministic(self):
        a = prepare("callcard_eg", "callcard_eg", callcard(), "2023-09", MAPPING)["landing"]
        b = prepare("callcard_eg", "callcard_eg", callcard(), "2023-09", MAPPING)["landing"]
        self.assertEqual(a, b)
        with zipfile.ZipFile(io.BytesIO(base64.b64decode(a))) as archive:
            self.assertTrue(all(i.date_time == (1980, 1, 1, 0, 0, 0) for i in archive.infolist()))

    def test_missing_duplicate_headers_and_amounts_do_not_become_zero(self):
        for headers, data in [(["Company Code", "SO Number", "Customer"], ["GLOB", "ORD1", "C"]),
                              (["Company Code", "SO Number", "Customer", "Gross Amount", "Gross Amount"], ["GLOB", "ORD1", "C", "1.00", "2.00"]),
                              (["Company Code", "SO Number", "Customer", "Gross Amount"], ["GLOB", "ORD1", "C", None])]:
            with self.assertRaises(ValueError):
                prepare("callcard_eg", "callcard_eg", workbook([headers, data]), "2023-09", MAPPING)

    def test_unrepresentable_native_numeric_text_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "round-trip"):
            financial("9007199254740993.00")
        self.assertEqual(financial(Decimal("17000.000000000004"), canonical_row=False), "17000.000000000004")


if __name__ == "__main__":
    unittest.main()
