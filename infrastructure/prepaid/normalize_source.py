"""Bounded local normalization of the ten native extraction inputs.
No AWS/database calls. Rules follow inspected Glue mappings and legacy consumers.
"""
import csv
import io
import json
import re
import sys
from decimal import Decimal
from portal_source_extract import (
    workbook_rows, parse_callcard, parse_loadapi, parse_header,
    parse_adjustments, normalize_label, text, amount, money, HEADERS,
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
    start, positions = header_mapping(rows, headers)
    for row in rows[start:]:
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
    result = []
    for row in header_rows(rows, KE24_HEADERS):
        period = accounting_period(row[0])
        currency = text(row[8]).upper()
        if currency != "PHP":
            raise ValueError("KE24 financial rows must be PHP for the portal; do not silently drop another currency")
        account = text(row[4])
        if isinstance(row[4], (int, float)) and float(row[4]).is_integer():
            account = str(int(row[4]))
        if not re.fullmatch(r"\d{1,10}", account):
            raise ValueError("Invalid KE24 Cost Element")
        classification = [text(row[i]).upper() for i in (14, 13, 15)]
        if not all(classification) or not text(row[5]) or not text(row[6]):
            raise ValueError("KE24 classification/profit-center/sub-product fields are required")
        result.append({"period": period, "brand": classification[0], "cfu": classification[1],
                       "revenue_type": classification[2], "cost_element": account,
                       "profit_center": text(row[5]), "sub_product": text(row[6]),
                       "uom": text(row[11]), "reference_document": text(row[2]),
                       "amount": money(amount(row[9])), "quantity": money(amount(row[10], True)),
                       "currency": "PHP"})
    if not result or len({r["period"] for r in result}) != 1:
        raise ValueError("KE24 must contain exactly one accounting period and nonempty revenue records")
    return result


def parse_callcard_eg(rows, period):
    if not period:
        raise ValueError("Call Card EG requires the verified KE24 period")
    month = int(accounting_period(period)[5:])
    result = []
    # Glue extract_6 skips one row: count=1, Business=3, Gross Amount=9.
    # Preserve EACH amount: legacy SQL rounds each row to numeric(18,0) before SUM.
    for row in rows[1:]:
        if not row or not text(row[0]) or text(row[0]).casefold() == "company code":
            continue
        if len(row) < 9:
            raise ValueError("Call Card EG row does not match the verified ordinal mapping")
        if text(row[2]).upper() != "EG":
            continue
        result.append({"region": "eg", "kind": "trade", "month_no": month,
                       "amount": money(amount(row[8], True))})
    if not result:
        raise ValueError("Call Card EG contains no EG records")
    return result


def parse_loadup(rows, region):
    total, selected = Decimal(0), 0
    type_index, amount_index = (1, 9) if region == "eg" else (0, 8)
    for row in rows[4:]:
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
                       "amount": money(amount(row[7])), "currency": "PHP"})
    return result


def normalize(workflow, code, body, period=None):
    if len(body) > MAX_SOURCE_BYTES:
        raise ValueError("Source exceeds portal upload limit")
    if workflow == "monthly_recharge" and code == workflow:
        return {"recharge": parse_recharge(body)}
    rows = workbook_rows(body, workflow)
    if workflow == "ke24" and code == workflow:
        return {"ke24": parse_ke24(rows)}
    if workflow == "callcard_eg" and code == workflow:
        return {"callcard": parse_callcard_eg(rows, period)}
    if workflow == "callcard_sg" and code == workflow:
        return {"callcard": parse_callcard(rows)}
    if workflow in ("load_api_eg", "load_api_sg") and code == workflow:
        return {"loadapi": parse_loadapi(rows, workflow[-2:])}
    if workflow in ("load_up_eg", "load_up_sg") and code == workflow:
        return {"loadup": parse_loadup(rows, workflow[-2:])}
    if workflow == "adjustments_308" and re.fullmatch(r"308_\d{2}", code):
        return {"adjustment_headers": parse_header(rows, code[4:]), "adjustments": parse_adjustments(rows, code[4:])}
    if workflow == "charges_318" and re.fullmatch(r"318_\d{2}", code):
        return {"charge_headers": parse_header(rows, code[4:]), "charges": parse_charges(rows, code[4:])}
    raise ValueError("Source does not belong to the selected extraction workflow")


if __name__ == "__main__":
    try:
        body = sys.stdin.buffer.read(MAX_SOURCE_BYTES + 1)
        if len(body) > MAX_SOURCE_BYTES:
            raise ValueError("Source exceeds portal upload limit")
        result = normalize(sys.argv[1], sys.argv[2], body, sys.argv[3] if len(sys.argv) > 3 else None)
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
