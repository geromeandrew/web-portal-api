function csvCell(value: unknown) {
  const text = String(value ?? "");
  return /[\",\n]/.test(text) ? `\"${text.replace(/\"/g, '\"\"')}\"` : text;
}

export function toCsv(headers: string[], rows: string[][]) {
  return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
}
