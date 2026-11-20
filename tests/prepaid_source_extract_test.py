import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import unittest
from uuid import uuid4

import openpyxl

spec = importlib.util.spec_from_file_location("prepaid_extract", Path(__file__).resolve().parents[1] / "infrastructure/prepaid/portal_source_extract.py")
extract = importlib.util.module_from_spec(spec)
spec.loader.exec_module(extract)


class ExistsError(Exception):
    response = {"Error": {"Code": "PreconditionFailed"}}


class FakeS3:
    def __init__(self):
        self.objects = {}

    def get_object(self, Bucket, Key):
        value = self.objects[(Bucket, Key)]
        return {"Body": io.BytesIO(value), "ContentLength": len(value)}

    def put_object(self, Bucket, Key, Body, **args):
        if (Bucket, Key) in self.objects:
            raise ExistsError()
        self.objects[(Bucket, Key)] = Body


def workbook(rows, title="Sheet1"):
    wb = openpyxl.Workbook()
    wb.active.title = title
    for row in rows:
        wb.active.append(row)
    buffer = io.BytesIO()
    wb.save(buffer)
    wb.close()
    return buffer.getvalue()


def request(workflow, body, code=None):
    session, preparation, source = str(uuid4()), str(uuid4()), str(uuid4())
    prefix = f"prepaid_reclass/sessions/{session}/preparation/{preparation}/extractions/{workflow}/"
    req = {"contractVersion": 1, "workflow": workflow, "scriptSha256": "a" * 64,
           "sessionId": session, "workspaceId": str(uuid4()), "preparationId": preparation,
           "sourceVersion": 1, "bucket": "test-only-bucket", "outputPrefix": prefix,
           "receiptKey": prefix + "receipt.json", "executionArn": "arn:aws:states:us-east-1:123456789012:execution:test:run",
           "sources": [{"id": source, "code": code or workflow,
                        "key": f"prepaid_reclass/sessions/{session}/sources/{source}/source.xlsx",
                        "sha256": hashlib.sha256(body).hexdigest()}]}
    s3 = FakeS3()
    s3.objects[(req["bucket"], req["sources"][0]["key"])] = body
    return req, s3


def artifact_rows(req, s3, name):
    receipt = json.loads(s3.objects[(req["bucket"], req["receiptKey"])])
    artifact = next(a for a in receipt["artifacts"] if a["name"] == name)
    body = s3.objects[(req["bucket"], artifact["key"])]
    assert hashlib.sha256(body).hexdigest() == artifact["sha256"]
    return [json.loads(line) for line in body.splitlines()]


class SourceExtractionTests(unittest.TestCase):
    def test_callcard_latest_not_historical_sum(self):
        body = workbook([["header"]] * 4 + [["August 2026", "1,000", None, None, None, None, "25"], ["September 2026", "2,345.67", None, None, None, None, "-45.10"]], "CALLCARD")
        req, s3 = request("callcard_sg", body)
        extract.run(req, "complete", s3)
        rows = artifact_rows(req, s3, "callcard")
        self.assertEqual([r["amount"] for r in rows], ["2345.67", "-45.10"])
        self.assertEqual(rows[0]["sourcePeriod"], "2026-09")
        self.assertEqual(rows[0]["month_no"], 9)
        self.assertEqual(s3.objects[(req["bucket"], req["sources"][0]["key"])], body)

    def test_load_api_eg_exact_ordinal_and_type(self):
        body = workbook([["header"]] * 3 + [["EG", None, None, None, None, "0.10"], ["SG", None, None, None, None, "999"], ["EG", None, None, None, None, "0.20"]])
        req, s3 = request("load_api_eg", body)
        extract.run(req, "complete", s3)
        self.assertEqual(artifact_rows(req, s3, "loadapi"), [{"region": "eg", "amount": "0.30"}])

    def test_load_api_sg_uses_ninth_column(self):
        body = workbook([["header"]] * 2 + [["SG", None, None, None, None, None, "900", "100", "800.50"]])
        req, s3 = request("load_api_sg", body)
        extract.run(req, "complete", s3)
        self.assertEqual(artifact_rows(req, s3, "loadapi"), [{"region": "sg", "amount": "800.50"}])

    def test_308_header_then_detail_associates_exact_cycle_not_wildcard_position(self):
        body = workbook([["Cycle Code:", "06"], ["Cycle Year:", "2026"], ["Cycle Instance:", "9"], [], extract.HEADERS,
                         ["E", "x", "x", "x", "ABC", "x", "GLOB", "PHP", "-12.50", "N"],
                         ["E", "x", "x", "x", "USD1", "x", "GLOB", "USD", "100", "N"],
                         ["Report Creator Amdocs BI Team"]])
        req, s3 = request("adjustments_308", body, "308_06")
        extract.run(req, "header", s3)
        self.assertNotIn((req["bucket"], req["receiptKey"]), s3.objects)
        extract.run(req, "detail", s3)
        self.assertEqual(artifact_rows(req, s3, "adjustments"), [{"cycle": "06", "customer_type": "E", "code": "ABC", "amount": "-12.50", "currency": "PHP"}])
        self.assertEqual(artifact_rows(req, s3, "adjustment_headers")[0]["cycleInstance"], "9")

    def test_repeat_is_immutable_and_idempotent(self):
        body = workbook([["header"]] * 3 + [["EG", None, None, None, None, "1.00"]])
        req, s3 = request("load_api_eg", body)
        extract.run(req, "complete", s3)
        before = copy.deepcopy(s3.objects)
        extract.run(req, "complete", s3)
        self.assertEqual(before, s3.objects)
        s3.objects[(req["bucket"], req["receiptKey"])] = b"corrupt"
        with self.assertRaisesRegex(ValueError, "refusing overwrite"):
            extract.run(req, "complete", s3)

    def test_checksum_and_cross_session_keys_are_rejected(self):
        req, s3 = request("load_api_eg", b"bad workbook")
        req["sources"][0]["sha256"] = "b" * 64
        with self.assertRaisesRegex(ValueError, "checksum mismatch"):
            extract.run(req, "complete", s3)
        req["sources"][0]["key"] = "prepaid_reclass/inbound/shared.xlsx"
        with self.assertRaisesRegex(ValueError, "immutable upload"):
            extract.run(req, "complete", s3)
        self.assertEqual(len(s3.objects), 1)

    def test_unmatched_headers_cycle_and_invalid_money_fail_closed(self):
        with self.assertRaisesRegex(ValueError, "headers"):
            extract.parse_adjustments([["random"]], "01")
        with self.assertRaisesRegex(ValueError, "cycle/year"):
            extract.parse_header([["Cycle Code:", "02"], ["Cycle Year:", "2026"], ["Cycle Instance:", "9"]], "01")
        for value in ("1,2", "NaN", "Infinity", "not money"):
            with self.assertRaises(ValueError):
                extract.amount(value)

    def test_uncached_formula_is_not_silently_zero(self):
        body = workbook([["header"]] * 3 + [["EG", None, None, None, None, "=1+2"]])
        req, s3 = request("load_api_eg", body)
        with self.assertRaisesRegex(ValueError, "formula without a cached value"):
            extract.run(req, "complete", s3)

    def test_conflicting_latest_month_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "Ambiguous"):
            extract.parse_callcard([["header"]] * 4 + [["September 2026", "1"], ["September 2026", "2"]])


if __name__ == "__main__":
    unittest.main()
