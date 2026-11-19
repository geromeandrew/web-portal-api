"""Project verified Glue database columns into the existing accounting contract.

No original workbook values are read here. Flat extractors have already removed
title rows and (SG Load API) discarded columns; use destination column names,
not the original spreadsheet ordinals. Decimal arithmetic remains in the shared
legacy-compatible parsers.
"""
from normalize_source import (
    KE24_HEADERS, CHARGE_HEADERS, RECHARGE_HEADERS, parse_ke24,
    parse_callcard_eg, parse_callcard, parse_loadup, parse_loadapi,
    parse_header, parse_adjustments, parse_charges, parse_recharge,
)
from portal_source_extract import HEADERS
import csv
import io
import re
from decimal import Decimal


def normalize_raw(workflow, code, tables, period=None):
    if workflow in ("adjustments_308", "charges_318"):
        if not re.fullmatch(("308" if workflow == "adjustments_308" else "318") + r"_\d{2}", code):
            raise ValueError("Raw billing source does not belong to its extraction workflow")
    elif code != workflow:
        raise ValueError("Raw source does not belong to its extraction workflow")
    numeric_columns = {"Value TranCurr", "Total Quantity", "GROSS AMOUNT", "trade",
                       "INTERNAL  (BASED ON SALES)", "amount", "Top up Amount",
                       "RECHARGE AMOUNT", "Total Amount"}

    def scalar(row, name):
        value = row.get(name)
        # Spark/JDBC numeric values may be rendered in exponent notation.
        # Expand notation exactly; do not round, infer amounts or coerce labels.
        if name in numeric_columns and isinstance(value, str) and re.fullmatch(r"[+-]?\d+(?:\.\d+)?[eE][+-]?\d{1,2}", value):
            return format(Decimal(value), "f")
        return value

    def matrix(table, names):
        if table not in tables:
            raise ValueError("Missing verified Glue raw table: " + table)
        return [[scalar(row, name) for name in names] for row in tables[table]]

    if workflow == "ke24":
        return {"ke24": parse_ke24([KE24_HEADERS] + matrix("dcKE24", KE24_HEADERS))}
    if workflow == "callcard_eg":
        names = ["count", "CUSTOMER NAME", "business", "date", "Doc#", "SO#", "BillDoc#", "description", "GROSS AMOUNT"]
        return {"callcard": parse_callcard_eg([names] + matrix("dcmanualcallcard", names), period)}
    if workflow == "callcard_sg":
        names = ["column1", "trade", "column3", "column4", "column5", "column6", "INTERNAL  (BASED ON SALES)"]
        return {"callcard": parse_callcard([[]] * 4 + matrix("dccallcard_sg", names))}
    if workflow in ("load_up_eg", "load_up_sg", "load_api_eg", "load_api_sg"):
        region = workflow[-2:]
        if workflow.startswith("load_up"):
            table = "dcload_up" if region == "eg" else "dcload_up_sg"
            names = ["SFA#", "type"] + [None] * 7 + ["amount"] if region == "eg" else ["type"] + [None] * 7 + ["amount"]
            return {"loadup": parse_loadup([[]] * 4 + matrix(table, names), region)}
        table = "dcload_api" if region == "eg" else "dcload_api_sg"
        names = ["type"] + [None] * (4 if region == "eg" else 7) + ["Top up Amount"]
        return {"loadapi": parse_loadapi([[]] * (3 if region == "eg" else 2) + matrix(table, names), region)}
    if workflow == "monthly_recharge":
        names = ["RECHARGE DATE", "brand", "CUSTOMER TYPE", "SUBSCRIBER TYPE", "RECHARGE METHOD", "RECHARGE CHANNEL", "CR/DR INDICATOR", "RECHARGE AMOUNT", "FREE TEXT AWARDED", "status"]
        stream = io.StringIO(newline="")
        writer = csv.writer(stream)
        writer.writerow(RECHARGE_HEADERS)
        writer.writerows(matrix("dcmonthlyrechargesummary", names))
        return {"recharge": parse_recharge(stream.getvalue().encode("utf-8"))}
    cycle = code[4:]
    if workflow == "adjustments_308":
        header = matrix("billed_adjustments_header_cycles", ["column1", "column2"])
        details = matrix("billed_adjustments_lineitem_cycles", ["Customer Type", "Customer Sub Type", "Subscriber Type", "Adjustment Type", "Adjustment Code", "Adjustment Reason", "Legal Entity", "currency", "amount", "Write-Off Activity Indicator"])
        return {"adjustment_headers": parse_header(header, cycle), "adjustments": parse_adjustments([HEADERS] + details, cycle)}
    if workflow == "charges_318":
        header = matrix("billed_charges_header_cycles", ["column1", "column2"])
        names = CHARGE_HEADERS[:-1] + ["currency"]
        details = matrix("billed_charges_lineitem_cycles", names)
        return {"charge_headers": parse_header(header, cycle), "charges": parse_charges([CHARGE_HEADERS] + details, cycle)}
    raise ValueError("Unsupported Glue raw workflow")
