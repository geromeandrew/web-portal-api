"""Source-specific parsing rules reused by the local backend normalizer.

normalize_source.py imports the pure parsing helpers; no AWS imports occur on
import. The old Glue run()/__main__ below is historical compatibility code only:
the backend no longer deploys it or requires portal arguments inside AWS.
"""
import hashlib
import io
import json
import re
import sys
import zipfile
from datetime import date, datetime
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP, getcontext
from itertools import islice

getcontext().prec = 50  # do not round intermediate sums through Python's default 28 digits
MAX_SOURCE_BYTES = 100 * 1024 * 1024  # legacy generic upload controller: 100 MiB
MAX_WORKBOOK_CELLS = 2_000_000
MAX_WORKBOOK_ROWS = 250_000
MAX_SCANNED_WORKBOOK_ROWS = 1_048_576  # Excel's physical row bound, including blank formatting


def dumps(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def text(value):
    if value is None:
        return ""
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return format(value, "f")
    return str(value).strip()


def amount(value, nullable=False):
    value = text(value)
    if not value and nullable:
        return Decimal(0)
    if not re.fullmatch(r"[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?", value):
        raise ValueError("Invalid source amount; no guessed zero or dropped financial row")
    try:
        result = Decimal(value.replace(",", ""))
    except InvalidOperation as error:
        raise ValueError("Invalid source amount") from error
    if not result.is_finite() or abs(result) >= Decimal("1e28"):
        raise ValueError("Source amount exceeds canonical limits")
    return result


def money(value, rounded=False):
    if rounded:
        value = value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    result = format(value, "f")
    if not re.fullmatch(r"-?\d{1,28}(?:\.\d{1,10})?", result):
        raise ValueError("Source precision exceeds the canonical contract")
    return result


def billing_money(value):
    """Match the unchanged native openpyxl numeric-cell representation.

    The streaming reader preserves XML Decimal text, including Excel double
    artifacts such as -533.91999999999996. Native openpyxl 3.1.2 reads that cell
    as float -533.92. Fractional numeric cells take this same conversion even
    when their XML artifact fits ten places; text amounts are never coerced.
    Integer cells remain exact. No float aggregation or forced
    two-decimal rounding occurs. Genuine excess precision still fails money().
    """
    parsed = amount(value)
    if isinstance(value, Decimal) and parsed.as_tuple().exponent < 0:
        parsed = Decimal(str(float(parsed)))
    return money(parsed)


def month(value):
    if isinstance(value, (date, datetime)):
        return value.strftime("%Y-%m")
    value = text(value)
    for pattern in ("%B %Y", "%b %Y", "%Y-%m-%d", "%Y-%m-%d %H:%M:%S", "%m/%d/%Y"):
        try:
            return datetime.strptime(value, pattern).strftime("%Y-%m")
        except ValueError:
            pass
    return None  # legacy source view excludes rows for which ISDATE is false


def normalize_label(value):
    return re.sub(r"[\s_-]+", "", text(value)).casefold()


def parse_callcard(rows):
    # Glue extract_1: CALLCARD sheet, skip 4 rows, trade ordinal 2/internal 7.
    dated = []
    for row in rows[4:]:
        row = list(row) + [None] * 14
        source_month = month(row[0])
        if source_month:
            dated.append((source_month, row))
    if not dated:
        raise ValueError("Call Card SG has no valid dated data rows")
    latest = max(value[0] for value in dated)
    selected = [row for source_month, row in dated if source_month == latest]
    if len(selected) != 1:
        raise ValueError("Ambiguous latest Call Card month (legacy scalar selection requires one row)")
    # Legacy importer chooses MAX(MonthNo), not the sum of historical months.
    row = selected[0]
    return [{"region": "sg", "kind": kind, "month_no": int(latest[5:]),
             "sourcePeriod": latest, "amount": money(amount(row[index], True), True)}
            for kind, index in (("trade", 1), ("internal", 6))]


def parse_loadapi(rows, region):
    # Observed job mappings: EG skip 3, amount ordinal 6; SG skip 2, amount 9.
    skip, index = (3, 5) if region == "eg" else (2, 8)
    total = Decimal(0)
    selected = 0
    for row in islice(rows, skip, None):
        if not row or not text(row[0]) or text(row[0]).casefold().startswith("type"):
            continue
        if text(row[0]).upper() != region.upper():
            continue  # legacy importer selects Type='EG' or Type='SG'
        if len(row) <= index:
            raise ValueError("Load API row does not match the verified ordinal mapping")
        total += amount(row[index], True)
        selected += 1
    if not selected:
        raise ValueError("Load API contains no records for the required region")
    return [{"region": region, "amount": money(total, True)}]


HEADERS = ["Customer Type", "Customer Sub Type", "Subscriber Type", "Adjustment Type",
           "Adjustment Code", "Adjustment Reason", "Legal Entity", "Currency", "Amount",
           "Write-Off Activity Indicator"]


def parse_header(rows, cycle):
    values = {}
    for row in rows:
        if len(row) < 2:
            continue
        label = re.sub(r"[^a-z]", "", text(row[0]).lower())
        if label in ("cyclecode", "cycleyear", "cycleinstance"):
            value = text(row[1])
            if label in values and values[label] != value:
                raise ValueError("Conflicting 308 cycle header fields")
            values[label] = value
    if not all(values.get(key) for key in ("cyclecode", "cycleyear", "cycleinstance")):
        raise ValueError("308 requires Cycle Code, Cycle Year and Cycle Instance header evidence")
    code = re.sub(r"^BC", "", values["cyclecode"], flags=re.I)
    if not code.isdigit() or code.zfill(2) != cycle or not re.fullmatch(r"\d{4}", values["cycleyear"]):
        raise ValueError("308 header cycle/year does not agree with the exact uploaded source")
    return [{"cycle": cycle, "cycleYear": values["cycleyear"], "cycleInstance": values["cycleinstance"]}]


def parse_adjustments(rows, cycle):
    # Require all ten labels, including multi-row headings. Unlike the old fuzzy
    # heuristic, ambiguous/unmatched financial columns fail instead of guessing.
    labels = [normalize_label(value) for value in HEADERS]
    found = None
    for start in range(min(50, len(rows))):
        for height in range(1, min(8, len(rows) - start) + 1):
            width = max((len(row) for row in rows[start:start + height]), default=0)
            combined = [normalize_label(" ".join(text(rows[r][c]) for r in range(start, start + height)
                                                if c < len(rows[r]))) for c in range(width)]
            if all(combined.count(label) == 1 for label in labels):
                found = (start + height, [combined.index(label) for label in labels])
                break
        if found:
            break
    if not found:
        raise ValueError("308 detail headers are incomplete or ambiguous; supply the actual layout")
    result = []
    for row in rows[found[0]:]:
        if not any(text(value) for value in row):
            continue
        values = [row[index] if index < len(row) else None for index in found[1]]
        customer = text(values[0])
        if re.search(r"Report.*Creator.*Amdocs.*BI.*Team", customer, re.I):
            continue
        if normalize_label(customer) == labels[0]:
            continue  # repeated page header
        currency = text(values[7]).upper()
        if not currency:
            raise ValueError("308 financial row has no currency")
        if currency != "PHP":
            continue  # canonical legacy AMAXCE inputs are PHP-only
        if not customer or not text(values[4]):
            raise ValueError("308 financial row has no customer type or adjustment code")
        result.append({"cycle": cycle, "customer_type": customer, "code": text(values[4]),
                       "amount": billing_money(values[8]), "currency": "PHP"})
    return result  # an attested header with genuinely zero PHP lines is permitted


def validate_request(request):
    from uuid import UUID
    if request.get("contractVersion") != 1 or request.get("workflow") not in (
            "callcard_sg", "load_api_eg", "load_api_sg", "adjustments_308"):
        raise ValueError("Unsupported extraction contract/workflow")
    for field in ("sessionId", "workspaceId", "preparationId"):
        UUID(request[field])
    if not isinstance(request["sourceVersion"], int) or request["sourceVersion"] < 0:
        raise ValueError("Invalid source version")
    if not re.fullmatch(r"[a-f0-9]{64}", request["scriptSha256"]):
        raise ValueError("Invalid deployed script revision")
    prefix = f"prepaid_reclass/sessions/{request['sessionId']}/preparation/{request['preparationId']}/extractions/{request['workflow']}/"
    if request["outputPrefix"] != prefix or request["receiptKey"] != prefix + "receipt.json":
        raise ValueError("Output must belong to the exact preparation/workflow")
    if not re.fullmatch(r"arn:aws:states:[a-z0-9-]+:\d{12}:execution:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+", request["executionArn"]):
        raise ValueError("Invalid child execution identity")
    sources = request["sources"]
    if not sources or len(sources) > 100 or len({s["id"] for s in sources}) != len(sources) or len({s["code"] for s in sources}) != len(sources):
        raise ValueError("Missing/duplicate source identities")
    for source in sources:
        UUID(source["id"])
        source_prefix = f"prepaid_reclass/sessions/{request['sessionId']}/sources/{source['id']}/"
        if not source["key"].startswith(source_prefix) or ".." in source["key"] or "\\" in source["key"]:
            raise ValueError("Source object is outside its immutable upload identity")
        if not re.fullmatch(r"[a-f0-9]{64}", source["sha256"]):
            raise ValueError("Invalid source checksum")
        if request["workflow"] == "adjustments_308":
            valid = re.fullmatch(r"308_\d{2}", source["code"])
        else:
            valid = len(sources) == 1 and source["code"] == request["workflow"]
        if not valid:
            raise ValueError("Source is not covered by this workflow")


def workbook_rows(body, workflow):
    import openpyxl
    if len(body) > MAX_SOURCE_BYTES:
        raise ValueError("Source exceeds portal upload size")
    with zipfile.ZipFile(io.BytesIO(body)) as archive:
        if len(archive.infolist()) > 5000 or sum(item.file_size for item in archive.infolist()) > 128_000_000:
            raise ValueError("Expanded workbook exceeds extraction limits")
    workbook = openpyxl.load_workbook(io.BytesIO(body), read_only=True, data_only=True, keep_links=False)
    try:
        sheets = [s for s in workbook if "callcard" in s.title.lower().replace(" ", "")] if workflow == "callcard_sg" else list(workbook)
        if not sheets or (workflow == "callcard_sg" and len(sheets) != 1):
            raise ValueError("Missing or ambiguous CALLCARD worksheet")
        sheet = sheets[0]  # same first-sheet selection as the existing flat jobs
        # Real legacy exports advertise XEZ/XFD-sized used ranges because of
        # formatting. Bound actual payload, not the untrusted dimension hint.
        # Reset makes the streaming reader stop at XML rows, not that hint.
        sheet.reset_dimensions()
        rows, cell_count, blank_rows = [], 0, 0
        for index, row in enumerate(sheet.iter_rows(values_only=True)):
            if index >= MAX_SCANNED_WORKBOOK_ROWS:
                raise ValueError("Workbook scanned rows exceed extraction limits")
            last = len(row)
            while last and row[last - 1] is None:
                last -= 1
            if not last:
                blank_rows += 1
                continue
            row = row[:last]
            cell_count += len(row)
            if len(rows) + blank_rows >= MAX_WORKBOOK_ROWS or len(row) > 100 or cell_count > MAX_WORKBOOK_CELLS:
                raise ValueError("Workbook rows/columns/cells exceed extraction limits")
            # Preserve internal/leading blank row ordinals (skiprows contracts),
            # but do not retain a potentially enormous empty formatted tail.
            rows.extend([()] * blank_rows)
            blank_rows = 0
            rows.append(row)
        formulas = openpyxl.load_workbook(io.BytesIO(body), read_only=True, data_only=False, keep_links=False)
        try:
            formula_sheet = formulas[sheet.title]
            formula_sheet.reset_dimensions()
            for index, row in enumerate(formula_sheet.iter_rows()):
                if index >= MAX_SCANNED_WORKBOOK_ROWS:
                    raise ValueError("Workbook scanned rows exceed extraction limits")
                for column, cell in enumerate(row):
                    if cell.data_type == "f" and (index >= len(rows) or column >= len(rows[index]) or rows[index][column] is None):
                        raise ValueError("Workbook contains a formula without a cached value; recalculate and save it first")
        finally:
            formulas.close()
        return rows
    finally:
        workbook.close()


def read_object(s3, bucket, key, maximum):
    response = s3.get_object(Bucket=bucket, Key=key)
    stream = response["Body"]
    try:
        if response.get("ContentLength", 0) > maximum:
            raise ValueError("Object exceeds extraction limit")
        body = stream.read(maximum + 1)
        if len(body) > maximum:
            raise ValueError("Object exceeds extraction limit")
        return body
    finally:
        stream.close()


def immutable_put(s3, bucket, key, body, content_type):
    try:
        s3.put_object(Bucket=bucket, Key=key, Body=body, ContentType=content_type, IfNoneMatch="*")
    except Exception as error:
        if getattr(error, "response", {}).get("Error", {}).get("Code") not in ("PreconditionFailed", "412"):
            raise
        if read_object(s3, bucket, key, len(body)) != body:
            raise ValueError("Existing extraction artifact differs; refusing overwrite") from error


def run(request, phase, s3):
    validate_request(request)
    workflow, bucket, prefix = request["workflow"], request["bucket"], request["outputPrefix"]
    if phase not in (("header", "detail") if workflow == "adjustments_308" else ("complete",)):
        raise ValueError("Invalid source extraction phase")
    artifacts = []
    if phase == "detail":
        header = json.loads(read_object(s3, bucket, prefix + "header-receipt.json", 2_000_000))
        for field in ("sessionId", "workspaceId", "preparationId", "sourceVersion", "workflow", "sources", "executionArn", "scriptSha256"):
            if header.get(field) != request.get(field):
                raise ValueError("308 header/detail source identities do not match")
        if header.get("phase") != "header":
            raise ValueError("308 header phase has not completed")
        artifacts.extend(header["artifacts"])
    for source in request["sources"]:
        body = read_object(s3, bucket, source["key"], MAX_SOURCE_BYTES)
        if hashlib.sha256(body).hexdigest() != source["sha256"]:
            raise ValueError("Uploaded source checksum mismatch")
        rows = workbook_rows(body, workflow)
        if workflow == "callcard_sg":
            name, result = "callcard", parse_callcard(rows)
        elif workflow.startswith("load_api_"):
            name, result = "loadapi", parse_loadapi(rows, workflow[-2:])
        elif phase == "header":
            name, result = "adjustment_headers", parse_header(rows, source["code"][4:])
        else:
            name, result = "adjustments", parse_adjustments(rows, source["code"][4:])
        body = b"".join(dumps(row) + b"\n" for row in result)
        key = f"{prefix}{source['id']}/{name}.jsonl"
        immutable_put(s3, bucket, key, body, "application/x-ndjson")
        artifacts.append({"sourceId": source["id"], "sourceCode": source["code"], "name": name,
                          "key": key, "sha256": hashlib.sha256(body).hexdigest(), "rowCount": len(result)})
    receipt = {key: request[key] for key in ("contractVersion", "workflow", "sessionId", "workspaceId", "preparationId",
                                            "sourceVersion", "executionArn", "scriptSha256", "sources")}
    receipt.update(phase="header" if phase == "header" else "complete", artifacts=artifacts)
    receipt_key = prefix + "header-receipt.json" if phase == "header" else request["receiptKey"]
    immutable_put(s3, bucket, receipt_key, dumps(receipt), "application/json")


if __name__ == "__main__":
    import boto3
    from awsglue.utils import getResolvedOptions
    arguments = getResolvedOptions(sys.argv, ["portal_request", "portal_phase"])
    run(json.loads(arguments["portal_request"]), arguments["portal_phase"], boto3.client("s3"))
