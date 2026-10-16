"""Local backend helper: XLSX bytes on stdin, validated fragments on stdout.
No AWS or database access. Reuses the tested source-specific parsing rules.
"""
import json
import sys
from portal_source_extract import workbook_rows, parse_callcard, parse_loadapi, parse_header, parse_adjustments


def normalize(workflow, code, body):
    rows = workbook_rows(body, workflow)
    if workflow == "callcard_sg" and code == workflow:
        return {"callcard": parse_callcard(rows)}
    if workflow in ("load_api_eg", "load_api_sg") and code == workflow:
        return {"loadapi": parse_loadapi(rows, workflow[-2:])}
    if workflow == "adjustments_308" and code.startswith("308_"):
        return {"adjustment_headers": parse_header(rows, code[4:]), "adjustments": parse_adjustments(rows, code[4:])}
    raise ValueError("Source does not belong to the selected extraction workflow")


if __name__ == "__main__":
    try:
        body = sys.stdin.buffer.read(4_500_001)
        if len(body) > 4_500_000:
            raise ValueError("Source exceeds portal upload limit")
        print(json.dumps(normalize(sys.argv[1], sys.argv[2], body), ensure_ascii=False, separators=(",", ":")))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
