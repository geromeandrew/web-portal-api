"""Bounded streaming and legacy C010 grouping; no real SAP/AWS/DB access."""
import io
import re
import sys
import json
import zipfile
import unittest
from pathlib import Path
from unittest.mock import patch
from contextlib import closing
from decimal import Decimal
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "infrastructure/prepaid"))
from normalize_source import normalize, KE24_HEADERS
from workbook_stream import iter_workbook_rows, BoundedXml
from prepaid_all_source_normalize_test import workbook, ke24_row


def edit_part(body, name, transform):
    result = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(body)) as source, zipfile.ZipFile(result, "w", zipfile.ZIP_DEFLATED) as target:
        for part in source.infolist():
            content = source.read(part)
            target.writestr(part, transform(content) if part.filename == name else content)
    return result.getvalue()


class StreamingTests(unittest.TestCase):
    def test_legacy_c010_groups_without_individual_document_identity(self):
        first, second = ke24_row(), ke24_row()
        first[2], second[2] = "812345", "923456"
        second[9], second[10] = "-0.10", "0.25"
        rows = normalize("ke24", "ke24", workbook([KE24_HEADERS, first, second]))["ke24"]
        self.assertEqual(len(rows), 1)
        self.assertEqual((rows[0]["amount"], rows[0]["quantity"]), ("-100.35", "10.75"))
        self.assertEqual(rows[0]["reference_document"], "")

    def test_c010_eight_prefix_and_profit_center_boundaries_are_preserved(self):
        rows = [ke24_row() for _ in range(4)]
        for row in rows:
            row[13], row[15], row[9], row[10] = "CB", "BB", "10", "1"
        for row, reference in zip(rows, ["8123", "8456", "1234", "8999"]):
            row[2] = reference
        rows[-1][5] = "P2"
        actual = normalize("ke24", "ke24", workbook([KE24_HEADERS] + rows))["ke24"]
        self.assertEqual(len(actual), 3)
        self.assertEqual(sum(Decimal(r["amount"]) for r in actual), Decimal("40"))
        self.assertEqual(next(r for r in actual if r["profit_center"] == "P1" and r["reference_document"] == "8")["amount"], "20")

    def test_canonical_numeric_scale_is_applied_after_grouped_sum(self):
        rows = [ke24_row(), ke24_row()]
        for row in rows:
            row[9], row[10] = "0.00000000006", "-0.00000000006"
        actual = normalize("ke24", "ke24", workbook([KE24_HEADERS] + rows))["ke24"][0]
        self.assertEqual(actual["amount"], "0.0000000001")
        self.assertEqual(actual["quantity"], "-0.0000000001")

    def test_actual_source_rows_beyond_old_grid_limit_stream_without_retaining_blank_grid(self):
        def move(content):
            content = content.replace(b'<row r="2"', b'<row r="300001"')
            return re.sub(br'r="([A-P])2"', rb'r="\g<1>300001"', content)
        body = edit_part(workbook([KE24_HEADERS, ke24_row()]), "xl/worksheets/sheet1.xml", move)
        self.assertEqual(normalize("ke24", "ke24", body)["ke24"][0]["amount"], "-100.25")

    def test_stream_limits_are_enforced_for_actual_populated_cells(self):
        with patch("workbook_stream.MAX_STREAM_CELLS", 2):
            with self.assertRaisesRegex(ValueError, "populated columns/cells"):
                with closing(iter_workbook_rows(workbook([["a", "b", "c"]]), "ke24")) as rows:
                    list(rows)

    def test_expanded_and_metadata_caps_remain_enforced(self):
        body = workbook([["data"]])
        for cap, reason in [("MAX_EXPANDED_BYTES", "Expanded workbook"), ("MAX_METADATA_BYTES", "metadata")]:
            with patch("workbook_stream." + cap, 1), self.assertRaisesRegex(ValueError, reason):
                with closing(iter_workbook_rows(body, "ke24")) as rows:
                    list(rows)

    def test_xml_entity_declarations_are_rejected_across_chunk_boundaries(self):
        checked = BoundedXml(io.BytesIO(b"<!DOCTYPE worksheet>"), 100)
        with self.assertRaisesRegex(ValueError, "entity declarations"):
            while checked.read(4):
                pass

    def test_utf16_doctype_is_rejected_in_metadata_and_worksheet(self):
        def add_doctype(content):
            xml = re.sub(r"^<\?xml.*?\?>", "", content.decode("utf-8"))
            return ('<?xml version="1.0" encoding="UTF-16"?><!DOCTYPE workbook>' + xml).encode("utf-16")

        for name in ("xl/workbook.xml", "xl/worksheets/sheet1.xml"):
            with self.subTest(part=name):
                body = edit_part(workbook([[1]]), name, add_doctype)
                with self.assertRaisesRegex(ValueError, "entity declarations"):
                    with closing(iter_workbook_rows(body, "ke24")) as rows:
                        list(rows)

    def test_duplicate_coordinates_and_nonfinite_numbers_fail_closed(self):
        for transform, reason in [
            (lambda b: b.replace(b'</row>', b'<c r="A1"><v>1</v></c></row>', 1), "Duplicate"),
            (lambda b: b.replace(b'<v>1</v>', b'<v>NaN</v>'), "finite precision"),
        ]:
            body = edit_part(workbook([[1]]), "xl/worksheets/sheet1.xml", transform)
            with self.assertRaisesRegex(ValueError, reason):
                with closing(iter_workbook_rows(body, "ke24")) as rows:
                    list(rows)

    def test_wrong_archived_templates_are_not_reinterpreted_or_zeroed(self):
        with self.assertRaisesRegex(ValueError, "egReportMapping.callcardScope"):
            normalize("callcard_eg", "callcard_eg", workbook([["Company Code"] + [None]*16 + ["Gross Amount"], ["GLOB"]]), "2023-09")
        with self.assertRaisesRegex(ValueError, "egReportMapping.loadupAmount"):
            normalize("load_up_eg", "load_up_eg", workbook([["title"]]*4 + [["CFU"]+[None]*7+["NET TOP UP"], ["EG"]+[None]*7+["100"]]))


if __name__ == "__main__":
    unittest.main()
