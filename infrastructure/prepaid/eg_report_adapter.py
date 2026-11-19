"""Explicit, audited original-report -> native Glue workbook adapter.

No AWS/DB access, guessed classifications, zero-filled amounts or implicit
gross/net selection. Native accounting formulas and reader arguments stay intact.
"""
import io
import re
import zipfile
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from itertools import chain, islice

CALLCARD_COLUMNS = "count,CUSTOMER NAME,business,date,Doc#,SO#,BillDoc#,description,GROSS AMOUNT,PREPAID CARDS,simcard,SOA AMOUNT,payment,balance,remarks,column16,column17,column18,column19,column20,column21,column22,column23,column24,column25,column26".split(",")
LOADUP_COLUMNS = "SFA#,type,Company Name,Merchant Name,Merchant Email,Merchant Mobile,Transaction ID,Transaction Date,Payment Method,amount,log,PAYMENT STATUS,status,remarks,Actual Disc (%),Check,column17,column18".split(",")


def text(value):
    if value is None:
        return ""
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    return str(value).strip()


def label(value):
    return re.sub(r"[\s_-]+", "", text(value)).casefold()


def financial(value, canonical_row=True):
    # Match the native openpyxl representation of Excel numeric cells only.
    # Numeric-looking text remains exact; no blanks become fabricated zeros.
    if isinstance(value, Decimal) and value.as_tuple().exponent < 0:
        value = str(float(value))
    raw = text(value)
    if not re.fullmatch(r"[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?", raw):
        raise ValueError("EG report has a missing or invalid financial amount")
    number = Decimal(raw.replace(",", ""))
    if not number.is_finite() or abs(number) >= Decimal("1e28") or (canonical_row and number.as_tuple().exponent < -10):
        raise ValueError("EG report amount exceeds canonical precision")
    # The unchanged Glue pandas reader may infer numeric-looking text. Refuse
    # values that could change numerically instead of silently losing precision.
    if Decimal(str(float(number))) != number:
        raise ValueError("EG report amount cannot round-trip through the native Glue reader exactly")
    return format(number, "f")


def policy_for(mapping, key):
    if not isinstance(mapping, dict) or mapping.get("profile") != "provided-eg-reports-v1" or mapping.get("approved") is not True or not mapping.get(key):
        raise ValueError("EG_REPORT_MAPPING_REQUIRED: approve sourceExtraction.egReportMapping." + key + " before using this report; the backend will not infer accounting rules")
    if key == "callcardScope" and mapping[key] != "eg_report":
        raise ValueError("Unsupported Call Card EG scope")
    if key == "loadupAmount" and mapping[key] not in ("gross", "net_top_up"):
        raise ValueError("Unsupported Load Up EG amount basis")
    return mapping[key]


def mapped_report(workflow, rows, mapping):
    """Return native-layout rows when a supplied-format header is detected.
    None means a historical native-format workbook; no policy is assumed.
    """
    rows = iter(rows)
    leading = list(islice(rows, 5))
    if workflow == "callcard_eg":
        if not leading or not leading[0] or label(leading[0][0]) != "companycode":
            return None, chain(leading, rows)
        policy_for(mapping, "callcardScope")
        header, data = leading[0], chain(leading[1:], rows)
        required = ["Company Code", "SO Number", "Customer", "Gross Amount"]
        columns, skipped, amount_name = CALLCARD_COLUMNS, 1, "Gross Amount"
    elif workflow == "load_up_eg":
        if len(leading) != 5 or not leading[4] or label(leading[4][0]) != "cfu":
            return None, chain(leading, rows)
        basis = policy_for(mapping, "loadupAmount")
        header, data = leading[4], rows
        amount_name = "GROSS" if basis == "gross" else "NET TOP UP"
        required = ["CFU", "Transaction ID", amount_name]
        columns, skipped = LOADUP_COLUMNS, 4
    else:
        return None, chain(leading, rows)
    headers = [label(value) for value in header]
    for name in required:
        if headers.count(label(name)) != 1:
            raise ValueError("Missing or ambiguous EG source header: " + name)

    def field(row, name):
        key = label(name)
        if headers.count(key) != 1:
            return ""
        index = headers.index(key)
        return text(row[index]) if index < len(row) else ""

    output = [[] for _ in range(skipped - 1)] + [columns]
    for index, row in enumerate(data, skipped + 1):
        if not row or not any(text(value) for value in row):
            continue
        if workflow == "callcard_eg":
            company, order = field(row, "Company Code"), field(row, "SO Number")
            if label(company) == "companycode":
                raise ValueError("Repeated EG report header inside transaction data")
            if not company and not order:
                # Original report's calculated footer, not a transaction.
                continue
            if company != "GLOB" or not order:
                raise ValueError("Call Card report transaction requires GLOB and SO Number")
            record = {"count": f"source-row:{index}", "CUSTOMER NAME": field(row, "Customer"),
                      "business": "EG", "date": field(row, "SO Date"), "Doc#": field(row, "SAP FI Document Number"),
                      "SO#": order, "description": field(row, "SO Type Description")}
        else:
            cfu = field(row, "CFU").upper()
            if cfu == "CFU":
                raise ValueError("Repeated EG report header inside transaction data")
            if cfu != "EG":
                continue  # Retain the legacy explicit Type=EG selection rule.
            transaction = field(row, "Transaction ID")
            if not transaction:
                raise ValueError("EG Load Up transaction has no Transaction ID")
            # SFA# is a technical nonempty source-row key for the unchanged
            # native filter, NOT an assertion that the report had an SFA number.
            record = {"SFA#": f"source-row:{index}", "type": "EG", "Company Name": field(row, "Company Name"),
                      "Merchant Email": field(row, "Email Address"), "Merchant Mobile": field(row, "Mobile Number"),
                      "Transaction ID": transaction, "Transaction Date": field(row, "Transaction Date"),
                      "Payment Method": field(row, "Payment Method"), "status": field(row, "Status")}
        value_index = headers.index(label(amount_name))
        # Load Up is rounded AFTER summing the report, as in the legacy view;
        # retain numeric-cell double artifacts rather than rounding every row.
        value = financial(row[value_index] if value_index < len(row) else None, canonical_row=workflow == "callcard_eg")
        record["GROSS AMOUNT" if workflow == "callcard_eg" else "amount"] = value
        output.append([record.get(column, "") for column in columns])
    if len(output) == skipped:
        raise ValueError("Supplied EG report contains no eligible transactions")
    return output, None


def workbook_bytes(rows):
    import openpyxl
    book = openpyxl.Workbook(write_only=True)
    sheet = book.create_sheet("Source")
    for row in rows:
        cells = []
        for value in row:
            cell = openpyxl.cell.WriteOnlyCell(sheet, value=value)
            if isinstance(value, str):
                cell.data_type = "s"  # Never promote source text to a formula.
            cells.append(cell)
        sheet.append(cells)
    result = io.BytesIO()
    book.save(result)
    book.close()
    # Immutable artifact retries must produce identical bytes, not a workbook
    # whose ZIP/core timestamps change on every attempt.
    stable = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(result.getvalue())) as source:
        with zipfile.ZipFile(stable, "w", compression=zipfile.ZIP_DEFLATED) as target:
            for name in sorted(source.namelist()):
                data = source.read(name)
                if name == "docProps/core.xml":
                    data = re.sub(rb"(<dcterms:(?:created|modified)[^>]*>)[^<]*(</dcterms:(?:created|modified)>)", rb"\g<1>2000-01-01T00:00:00Z\g<2>", data)
                info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                target.writestr(info, data)
    return stable.getvalue()
