"""Bounded, single-pass OOXML values reader for real legacy-sized sources.

Styles/shared strings use the pinned openpyxl metadata loader. Worksheet payload
is streamed; formatted empty cells/rows never become a rectangular Python grid.
No files are extracted, formulas evaluated, external links followed or values
rounded. Caller must close the generator when it stops before EOF.
"""
import io
import re
import zipfile
from decimal import Decimal, InvalidOperation
from defusedxml import DefusedXmlException
from defusedxml.ElementTree import iterparse

MAX_EXPANDED_BYTES = 768 * 1024 * 1024
MAX_WORKSHEET_BYTES = 600 * 1024 * 1024
MAX_METADATA_BYTES = 32 * 1024 * 1024
MAX_STREAM_CELLS = 10_000_000
MAX_SCANNED_CELLS = 20_000_000
MAX_ROWS = 1_048_576
MAX_COLUMNS = 100
NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


class BoundedXml:
    def __init__(self, stream, maximum):
        self.stream, self.maximum = stream, maximum
        self.size, self.tail = 0, b""

    def read(self, size=-1):
        # XML parser normally requests bounded chunks; do not honor read-all.
        data = self.stream.read(min(size if size >= 0 else 65536, 65536))
        self.size += len(data)
        if self.size > self.maximum:
            raise ValueError("Expanded workbook XML exceeds streaming limit")
        checked = self.tail + data
        if b"<!DOCTYPE" in checked or b"<!ENTITY" in checked:
            raise ValueError("Workbook XML entity declarations are not permitted")
        self.tail = checked[-16:]
        return data


def xml_events(source, events):
    try:
        yield from iterparse(
            source, events=events, forbid_dtd=True, forbid_entities=True, forbid_external=True
        )
    except DefusedXmlException as error:
        raise ValueError("Workbook XML entity declarations are not permitted") from error


def iter_workbook_rows(body, workflow):
    import openpyxl
    from openpyxl.utils.cell import column_index_from_string
    from openpyxl.utils.datetime import from_excel, from_ISO8601
    if len(body) > 100 * 1024 * 1024:
        raise ValueError("Source exceeds portal upload limit")
    with zipfile.ZipFile(io.BytesIO(body)) as archive:
        entries = archive.infolist()
        if len(entries) > 5000 or len({i.filename for i in entries}) != len(entries):
            raise ValueError("Workbook has too many or duplicate ZIP members")
        if sum(i.file_size for i in entries) > MAX_EXPANDED_BYTES:
            raise ValueError("Expanded workbook exceeds streaming limit")
        for item in entries:
            if item.filename.startswith("xl/worksheets/") and item.file_size > MAX_WORKSHEET_BYTES:
                raise ValueError("Worksheet exceeds streaming limit")
            if not item.filename.startswith("xl/worksheets/") and item.filename.endswith((".xml", ".rels")):
                if item.file_size > MAX_METADATA_BYTES:
                    raise ValueError("Workbook metadata exceeds streaming limit")
                with archive.open(item) as part:
                    checked = BoundedXml(part, MAX_METADATA_BYTES)
                    for _, element in xml_events(checked, ("end",)):
                        element.clear()
    book = openpyxl.load_workbook(io.BytesIO(body), read_only=True, data_only=False, keep_links=False)
    try:
        sheets = [s for s in book if "callcard" in s.title.lower().replace(" ", "")] if workflow == "callcard_sg" else list(book)
        if not sheets or (workflow == "callcard_sg" and len(sheets) != 1):
            raise ValueError("Missing or ambiguous CALLCARD worksheet")
        sheet = sheets[0]  # Preserve the native jobs' first-sheet contract.
        strings = sheet._shared_strings  # pinned openpyxl 3.1.2 metadata

        def value(cell):
            raw = cell.find(NS + "v")
            cached = raw.text if raw is not None else None
            if cached is not None and len(cached) > 128000:
                raise ValueError("Workbook cell value exceeds streaming limit")
            if cell.find(NS + "f") is not None and cached is None:
                raise ValueError("Workbook contains a formula without a cached value; recalculate and save it first")
            kind = cell.get("t", "n")
            if kind == "inlineStr":
                inline = cell.find(NS + "is")
                result = "".join(t.text or "" for t in inline.iter(NS + "t")) if inline is not None else None
                if result is not None and len(result) > 128000:
                    raise ValueError("Workbook cell value exceeds streaming limit")
                return result
            if cached is None:
                return None
            if kind == "s":
                index = int(cached)
                if index < 0 or index >= len(strings):
                    raise ValueError("Invalid workbook shared-string reference")
                return strings[index]
            if kind == "b":
                if cached not in ("0", "1"):
                    raise ValueError("Invalid workbook boolean")
                return cached == "1"
            if kind == "d":
                return from_ISO8601(cached)
            if kind == "e":
                raise ValueError("Workbook contains an Excel error value")
            if kind in ("str", "inlineStr"):
                return cached
            if kind != "n":
                raise ValueError("Unsupported workbook cell type")
            try:
                number = Decimal(cached)
            except InvalidOperation as error:
                raise ValueError("Invalid workbook number") from error
            if not number.is_finite() or abs(number.adjusted()) > 100 or len(number.as_tuple().digits) > 100:
                raise ValueError("Workbook number exceeds finite precision limits")
            style = int(cell.get("s", "0"))
            if style < 0 or style >= len(book._cell_styles):
                raise ValueError("Invalid workbook style reference")
            if style in book._date_formats:
                return from_excel(float(number), book.epoch)
            return number

        row_number, previous_row, emitted_row = 0, 0, 0
        values, parent_row, sheet_data = {}, None, None
        populated, scanned = 0, 0
        with book._archive.open(sheet._worksheet_path.lstrip("/")) as part:
            source = BoundedXml(part, MAX_WORKSHEET_BYTES)
            for event, element in xml_events(source, ("start", "end")):
                if event == "start":
                    if element.tag == NS + "sheetData":
                        sheet_data = element
                    elif element.tag == NS + "row":
                        row_number = int(element.get("r", str(previous_row + 1)))
                        if row_number <= previous_row or row_number > MAX_ROWS:
                            raise ValueError("Workbook row coordinates exceed streaming limits")
                        previous_row, values, parent_row = row_number, {}, element
                    continue
                if element.tag == NS + "c":
                    scanned += 1
                    if scanned > MAX_SCANNED_CELLS:
                        raise ValueError("Workbook scanned cells exceed streaming limits")
                    actual = value(element)
                    if actual is not None:
                        match = re.fullmatch(r"([A-Z]{1,3})([1-9][0-9]{0,6})", element.get("r", ""))
                        if not match or int(match[2]) != row_number:
                            raise ValueError("Invalid workbook cell coordinates")
                        column = column_index_from_string(match[1])
                        populated += 1
                        if column > MAX_COLUMNS or populated > MAX_STREAM_CELLS:
                            raise ValueError("Workbook populated columns/cells exceed streaming limits")
                        if column in values:
                            raise ValueError("Duplicate workbook cell coordinate")
                        values[column] = actual
                    element.clear()
                    if parent_row is not None:
                        parent_row.remove(element)
                elif element.tag == NS + "row":
                    if values:
                        # Preserve skiprows/header positions, not formatted tails.
                        for _ in range(emitted_row + 1, row_number):
                            yield ()
                        width = max(values)
                        yield tuple(values.get(column) for column in range(1, width + 1))
                        emitted_row = row_number
                    element.clear()
                    if sheet_data is not None:
                        sheet_data.remove(element)
                    parent_row = None
    finally:
        book.close()
