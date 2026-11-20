"""Run the two extraction-used helper functions with fake S3 only.

The fixture is a verbatim read-only copy of the reviewed AWS object, not a Glue
deployment. Export functions are not invoked by the Prepaid extraction wrappers.
"""
import ast
import os
from pathlib import Path
from types import SimpleNamespace
import unittest
from urllib.parse import urlparse


FIXTURE = Path(__file__).parent / "fixtures" / "prepaid-reviewed-utilsaws.py"
EXTRACTION_FUNCTIONS = {"move_s3_file", "resolve_s3_case_insensitivity"}


class FakeS3:
    def __init__(self):
        self.calls = []
        self.objects = []
        self.missing = False
        self.copy_failure = False
        self.list_failure = False

    def head_object(self, **kwargs):
        self.calls.append(("head", kwargs))
        if self.missing:
            raise RuntimeError("missing")

    def copy_object(self, **kwargs):
        self.calls.append(("copy", kwargs))
        if self.copy_failure:
            raise RuntimeError("copy failed")

    def delete_object(self, **kwargs):
        self.calls.append(("delete", kwargs))

    def list_objects_v2(self, **kwargs):
        self.calls.append(("list", kwargs))
        if self.list_failure:
            raise RuntimeError("list failed")
        return {"Contents": self.objects}


class ReviewedExtractionHelper(unittest.TestCase):
    def setUp(self):
        self.s3 = FakeS3()
        source = ast.parse(FIXTURE.read_text(encoding="utf-8-sig"))
        functions = [node for node in source.body if isinstance(node, ast.FunctionDef)
                     and node.name in EXTRACTION_FUNCTIONS]
        self.assertEqual({node.name for node in functions}, EXTRACTION_FUNCTIONS)
        # No boto3 import, AWS credentials, Spark runtime or network access.
        namespace = {
            "boto3": SimpleNamespace(client=lambda service: self.client(service)),
            "urlparse": urlparse,
            "os": os,
            "print": lambda *_args, **_kwargs: None,
        }
        exec(compile(ast.Module(body=functions, type_ignores=[]), str(FIXTURE), "exec"), namespace)
        self.move = namespace["move_s3_file"]
        self.resolve = namespace["resolve_s3_case_insensitivity"]
        self.src = "s3://test/prepaid_reclass/inbound/KE24.xlsx"
        self.dest = "s3://test/prepaid_reclass/success/run/KE24.xlsx"

    def client(self, service):
        self.assertEqual(service, "s3")
        return self.s3

    def test_copy_only_retains_original_for_multi_job_workflows(self):
        self.move(self.src, self.dest, delete_original=False)
        self.assertEqual([name for name, _ in self.s3.calls], ["head", "copy"])
        self.assertEqual(self.s3.calls[-1][1], {
            "Bucket": "test", "Key": "prepaid_reclass/success/run/KE24.xlsx",
            "CopySource": {"Bucket": "test", "Key": "prepaid_reclass/inbound/KE24.xlsx"},
        })

    def test_move_deletes_only_exact_source_after_successful_copy(self):
        self.move(self.src, self.dest, delete_original=True)
        self.assertEqual([name for name, _ in self.s3.calls], ["head", "copy", "delete"])
        self.assertEqual(self.s3.calls[-1][1], {
            "Bucket": "test", "Key": "prepaid_reclass/inbound/KE24.xlsx",
        })

    def test_missing_source_does_not_copy_or_delete(self):
        self.s3.missing = True
        with self.assertRaisesRegex(Exception, "does not exist"):
            self.move(self.src, self.dest)
        self.assertEqual([name for name, _ in self.s3.calls], ["head"])

    def test_failed_copy_does_not_delete_source(self):
        self.s3.copy_failure = True
        with self.assertRaisesRegex(Exception, "copy failed"):
            self.move(self.src, self.dest)
        self.assertEqual([name for name, _ in self.s3.calls], ["head", "copy"])

    def test_blank_paths_do_not_touch_storage(self):
        self.move("", self.dest)
        self.move(self.src, "")
        self.assertEqual(self.s3.calls, [])

    def test_case_resolution_ignores_other_sources_and_uses_newest_exact_match(self):
        self.s3.objects = [
            {"Key": "prepaid_reclass/inbound/KE24.xlsx", "LastModified": 1},
            {"Key": "prepaid_reclass/inbound/ke24.XLSX", "LastModified": 2},
            {"Key": "prepaid_reclass/inbound/318.xlsx", "LastModified": 9},
            {"Key": "prepaid_reclass/inbound/subfolder/KE24.xlsx", "LastModified": 10},
        ]
        self.assertEqual(self.resolve(self.src), "s3://test/prepaid_reclass/inbound/ke24.XLSX")
        self.assertEqual(self.s3.calls, [("list", {"Bucket": "test", "Prefix": "prepaid_reclass/inbound/"})])

    def test_case_resolution_never_substitutes_an_unrelated_report(self):
        self.s3.objects = [{"Key": "prepaid_reclass/inbound/318.xlsx", "LastModified": 9}]
        self.assertEqual(self.resolve(self.src), self.src)
        self.assertEqual([name for name, _ in self.s3.calls], ["list"])

    def test_listing_failure_does_not_move_or_delete_any_file(self):
        self.s3.list_failure = True
        self.assertEqual(self.resolve(self.src), self.src)
        self.assertEqual([name for name, _ in self.s3.calls], ["list"])


if __name__ == "__main__":
    unittest.main()
