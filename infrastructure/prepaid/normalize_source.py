"""Bounded local normalization of the ten native extraction inputs.
No AWS/database calls. Rules follow inspected Glue mappings and legacy consumers.
"""
import csv
import io
import json
import re
import base64
import sys
from decimal import Decimal, ROUND_HALF_UP
from contextlib import closing
from itertools import chain, islice
from workbook_stream import iter_workbook_rows
from eg_report_adapter import mapped_report, workbook_bytes
from portal_source_extract import (
    workbook_rows, parse_callcard, parse_loadapi, parse_header,
    parse_adjustments, normalize_label, text, amount, money, billing_money, HEADERS,
    MAX_SOURCE_BYTES, MAX_WORKBOOK_CELLS
)

KE24_HEADERS = ["Period/Year", "Document number", "Reference document", "Item number",
                "Cost Element", "Profit Center", "Sub-Product Group B", "Created On",
                "CACur", "Value TranCurr", "Total Quantity", "Unit of Measure",
                "Posting date", "Sub-Product Group A", "Brand", "Product-Rev Type"]
CHARGE_HEADERS = ["Customer Type", "Customer SubType", "Subscriber Type", "Revenue Type",
                  "Charge Code/Tax Code", "Charge Type/Tax Type", "Discount Plan Code",
                  "Total Amount", "Document Demand Type", "Legal Entity", "Currency"]
RECHARGE_HEADERS = ["RECHARGE DATE", "BRAND", "CUSTOMER TYPE", "SUBSCRIBER TYPE",
                    "RECHARGE METHOD", "RECHARGE CHANNEL", "CR/DR INDICATOR",
                    "RECHARGE AMOUNT", "FREE TEXT AWARDED", "STATUS"]


def header_mapping(rows, headers):
    labels = [normalize_label(h) for h in headers]
    for start in range(min(50, len(rows))):
        for height in range(1, min(8, len(rows) - start) + 1):
            block = rows[start:start + height]
            width = max((len(r) for r in block), default=0)
            combined = [normalize_label(" ".join(text(r[c]) for r in block if c < len(r)))
                        for c in range(width)]
            if all(combined.count(label) == 1 for label in labels):
                return start + height, [combined.index(label) for label in labels]
    raise ValueError("Required source headers are incomplete or ambiguous")


def header_rows(rows, headers):
    rows = iter(rows)
    leading = list(islice(rows, 57))
    start, positions = header_mapping(leading, headers)
    for row in chain(leading[start:], rows):
        if not any(text(v) for v in row):
            continue
        values = [row[i] if i < len(row) else None for i in positions]
        if normalize_label(values[0]) == normalize_label(headers[0]):
            continue
        if re.search(r"Report.*Creator.*Amdocs.*BI.*Team", text(values[0]), re.I):
            continue
        yield values


def accounting_period(value):
    value = text(value)
    match = re.fullmatch(r"(\d{1,3})[./](\d{4})", value)
    result = f"{match[2]}-{int(match[1]):02d}" if match else value
    if not re.fullmatch(r"(?!0000)\d{4}-(0[1-9]|1[0-2])", result):
        raise ValueError("Unsupported KE24 Period/Year; only normal fiscal periods 001-012 are approved")
    return result


def parse_ke24(rows):
    groups = {}
    periods = set()
    for row in header_rows(rows, KE24_HEADERS):
        period = accounting_period(row[0])
        currency = text(row[8]).upper()
        if currency != "PHP":
            raise ValueError("KE24 financial rows must be PHP for the portal; do not silently drop another currency")
        account = text(row[4])
        if isinstance(row[4], (int, float, Decimal)) and Decimal(str(row[4])) == Decimal(str(row[4])).to_integral_value():
            account = str(int(row[4]))
        if not re.fullmatch(r"\d{1,10}", account):
            raise ValueError("Invalid KE24 Cost Element")
        classification = [text(row[i]).upper() for i in (14, 13, 15)]
        if not all(classification) or not text(row[5]) or not text(row[6]):
            raise ValueError("KE24 classification/profit-center/sub-product fields are required")
        # Legacy FormatC010 groups by accounting dimensions and the _8
        # classification, NOT by individual reference-document identity.
        # Preserve every dimension used by the PostgreSQL importer/allocator.
        reference_bucket = "8" if "_".join(classification) in ("GP_CB_BB", "GP_SG_MT") and text(row[2]).startswith("8") else ""
        key = (period, *classification, account.zfill(10), text(row[5]), text(row[6]), text(row[11]), reference_bucket)
        periods.add(period)
        if key not in groups:
            if len(groups) >= 100000:
                raise ValueError("KE24 grouped output exceeds bounded normalization limits")
            groups[key] = {"period": period, "brand": classification[0], "cfu": classification[1],
                       "revenue_type": classification[2], "cost_element": account,
                       "profit_center": text(row[5]), "sub_product": text(row[6]),
                       "uom": text(row[11]), "reference_document": reference_bucket,
                       "amount": Decimal(0), "quantity": Decimal(0), "currency": "PHP"}
        groups[key]["amount"] += amount(row[9])
        groups[key]["quantity"] += amount(row[10], True)
    if not groups or len(periods) != 1:
        raise ValueError("KE24 must contain exactly one accounting period and nonempty revenue records")
    result = []
    for row in groups.values():
        # PostgreSQL's existing canonical columns are numeric(38,10). Apply
        # their scale AFTER the legacy C010 SUM, not once per source row.
        for field in ("amount", "quantity"):
            if row[field].as_tuple().exponent < -10:
                row[field] = row[field].quantize(Decimal("0.0000000001"), rounding=ROUND_HALF_UP)
        row["amount"], row["quantity"] = money(row["amount"]), money(row["quantity"])
        result.append(row)
    return result


def parse_callcard_eg(rows, period):
    if not period:
        raise ValueError("Call Card EG requires the verified KE24 period")
    month = int(accounting_period(period)[5:])
    return [{"region": "eg", "kind": "trade", "month_no": month, "amount": value}
            for value in callcard_eg_amounts(rows)]


def callcard_eg_amounts(rows):
    result = []
    # Glue extract_6 skips one row: count=1, Business=3, Gross Amount=9.
    # Preserve EACH amount: legacy SQL rounds each row to numeric(18,0) before SUM.
    rows = iter(rows)
    first = next(rows, ())
    if first and normalize_label(first[0]) == "companycode":
        raise ValueError("Wrong Call Card EG template: the sales-order/receipt report is not the manual Call Card source. Native extract_6 requires Count column 1, Business column 3 and Gross Amount column 9; renaming a report is insufficient")
    for row in rows:
        if not row or not text(row[0]) or text(row[0]).casefold() == "company code":
            continue
        if len(row) < 9:
            raise ValueError("Call Card EG row does not match the verified ordinal mapping")
        if text(row[2]).upper() != "EG":
            continue
        result.append(money(amount(row[8], True)))
    if not result:
        raise ValueError("Call Card EG contains no EG records")
    return result


def parse_loadup(rows, region):
    total, selected = Decimal(0), 0
    type_index, amount_index = (1, 9) if region == "eg" else (0, 8)
    rows = iter(rows)
    leading = list(islice(rows, 5))
    if region == "eg" and len(leading) == 5 and leading[4] and normalize_label(leading[4][0]) == "cfu":
        raise ValueError("Wrong Load Up EG template for native extract_7: CFU in column 1 / NET TOP UP in column 9 does not match SFA# column 1, Type column 2 and Amount column 10. Supply the matching EG source or have the workflow owner revise its mapping; financial columns will not be guessed")
    for row in chain(leading[4:], rows):
        if not row or not text(row[0]) or text(row[0]).upper() == "CFU":
            continue
        if len(row) <= amount_index:
            raise ValueError("Load Up row does not match the verified ordinal mapping")
        if text(row[type_index]).upper() != region.upper():
            continue
        total += amount(row[amount_index], True)
        selected += 1
    if not selected:
        raise ValueError("Load Up contains no records for the required region")
    return [{"region": region, "amount": money(total, True)}]


def parse_recharge(body):
    decoded = body.decode("utf-8-sig", errors="strict")
    csv.field_size_limit(128000)
    rows, cells = [], 0
    for row in csv.reader(io.StringIO(decoded, newline=""), delimiter=",", strict=True):
        cells += len(row)
        if len(rows) >= 250000 or len(row) > 100 or cells > MAX_WORKBOOK_CELLS:
            raise ValueError("Recharge CSV exceeds extraction row/column limits")
        rows.append(row)
    result = []
    for row in header_rows(rows, RECHARGE_HEADERS):
        customer, method, channel = (text(row[i]).upper() for i in (2, 4, 5))
        # Legacy views select E/S + PS/RP; they do not flip signs by CR/DR.
        if customer not in ("E", "S") or method != "PS" or channel != "RP":
            continue
        result.append({"customer_type": customer, "method": method, "channel": channel,
                       "amount": money(amount(row[7], True))})
    return result


def parse_charges(rows, cycle):
    result = []
    for row in header_rows(rows, CHARGE_HEADERS):
        currency = text(row[10]).upper()
        if not currency:
            raise ValueError("318 financial row has no currency")
        if currency != "PHP":
            continue  # Same PHP-only AMAXCE boundary as 308.
        customer, code = text(row[0]), text(row[4])
        if not customer or not code:
            raise ValueError("318 financial row has no customer type or charge code")
        result.append({"cycle": cycle, "customer_type": customer, "code": code,
                       "amount": billing_money(row[7]), "currency": "PHP"})
    return result


def normalize(workflow, code, body, period=None, mapping=None):
    if len(body) > MAX_SOURCE_BYTES:
        raise ValueError("Source exceeds portal upload limit")
    if workflow == "monthly_recharge" and code == workflow:
        return {"recharge": parse_recharge(body)}
    with closing(iter_workbook_rows(body, workflow)) as rows:
        return normalize_rows(workflow, code, rows, period, mapping)


def normalize_rows(workflow, code, rows, period=None, mapping=None):
    if workflow in ("callcard_eg", "load_up_eg") and code == workflow:
        adapted, original = mapped_report(workflow, rows, mapping)
        rows = adapted if adapted is not None else original
    if workflow == "ke24" and code == workflow:
        return {"ke24": parse_ke24(rows)}
    if workflow == "callcard_eg" and code == workflow:
        return {"callcard": parse_callcard_eg(rows, period)}
    if workflow == "callcard_sg" and code == workflow:
        return {"callcard": parse_callcard(list(rows))}
    if workflow in ("load_api_eg", "load_api_sg") and code == workflow:
        return {"loadapi": parse_loadapi(rows, workflow[-2:])}
    if workflow in ("load_up_eg", "load_up_sg") and code == workflow:
        return {"loadup": parse_loadup(rows, workflow[-2:])}
    if workflow == "adjustments_308" and re.fullmatch(r"308_\d{2}", code):
        rows = list(rows)
        return {"adjustment_headers": parse_header(rows, code[4:]), "adjustments": parse_adjustments(rows, code[4:])}
    if workflow == "charges_318" and re.fullmatch(r"318_\d{2}", code):
        rows = list(rows)
        return {"charge_headers": parse_header(rows, code[4:]), "charges": parse_charges(rows, code[4:])}
    raise ValueError("Source does not belong to the selected extraction workflow")


def prepare(workflow, code, body, period=None, mapping=None, landing_only=False):
    if workflow not in ("callcard_eg", "load_up_eg") or code != workflow:
        return {"datasets": normalize(workflow, code, body, period, mapping)}
    with closing(iter_workbook_rows(body, workflow)) as rows:
        adapted, original = mapped_report(workflow, rows, mapping)
        if landing_only and workflow == "callcard_eg":
            def normalize_landing(rows):
                return {"callcard": callcard_eg_amounts(rows)}
        else:
            def normalize_landing(rows):
                return normalize_rows(workflow, code, rows, period)
        if adapted is None:
            return {"datasets": normalize_landing(original)}
        datasets = normalize_landing(iter(adapted))
        landing = workbook_bytes(adapted)
        if len(landing) > MAX_SOURCE_BYTES:
            raise ValueError("Adapted workbook exceeds source byte limit")
        # Re-read the exact persisted working copy, not just its in-memory rows.
        with closing(iter_workbook_rows(landing, workflow)) as staged:
            if normalize_landing(staged) != datasets:
                raise ValueError("Adapted native workbook differs from original-report calculations")
        return {"datasets": datasets, "landing": base64.b64encode(landing).decode("ascii")}


if __name__ == "__main__":
    try:
        body = sys.stdin.buffer.read(MAX_SOURCE_BYTES + 1)
        if len(body) > MAX_SOURCE_BYTES:
            raise ValueError("Source exceeds portal upload limit")
        period = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] else None
        mapping = json.loads(sys.argv[4]) if len(sys.argv) > 4 and sys.argv[4] else None
        if len(sys.argv) > 5 and sys.argv[5] == "raw":
            from normalize_raw_source import normalize_raw
            result = normalize_raw(sys.argv[1], sys.argv[2], json.loads(body), period)
        elif len(sys.argv) > 5 and sys.argv[5] in ("prepare", "landing"):
            result = prepare(sys.argv[1], sys.argv[2], body, period, mapping, sys.argv[5] == "landing")
        else:
            result = normalize(sys.argv[1], sys.argv[2], body, period, mapping)
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
