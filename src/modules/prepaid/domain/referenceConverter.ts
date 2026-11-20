import { createHash } from "node:crypto";
import { datasetSchemas, periodSchema } from "./contracts.js";

const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
/** Converts a real legacy export; never fabricates mappings or approves a source. */
export function convertLegacyReference(
  bytes: Uint8Array,
  requestedPeriod: string,
) {
  const period = periodSchema.parse(requestedPeriod);
  if (bytes.byteLength > 20 * 1024 * 1024)
    throw Error("Reference export exceeds 20 MiB.");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const rows: ReturnType<typeof datasetSchemas.reference.parse>[] = [];
  const provenance: { line: number; source: Record<string, unknown> }[] = [];
  let inputRows = 0,
    skippedClientRows = 0,
    missingSourceBrandRows = 0;
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    if (Buffer.byteLength(line) > 128000)
      throw Error(`Reference line ${index + 1} exceeds 128 KB.`);
    try {
      const source: unknown = JSON.parse(line);
      if (!source || typeof source !== "object" || Array.isArray(source))
        throw Error("Expected a JSON object.");
      const record = source as Record<string, unknown>;
      inputRows++;
      const field = (name: string) => {
        if (typeof record[name] !== "string")
          throw Error(
            `${name} must be an exact string; numeric coercion is not permitted.`,
          );
        return (record[name] as string).trim();
      };
      if (field("MANDT") !== "300") {
        skippedClientRows++;
        continue;
      }
      if (field("BUKRS") !== "GLOB")
        throw Error("BUKRS must be GLOB for the portal reference contract.");
      const account = field("HKONT");
      if (!/^\d{1,10}$/.test(account))
        throw Error("HKONT must contain 1–10 digits.");
      // BRAND describes membership; WWBRD is the allocation classification.
      // Real staging rows have a blank description. Retain that absence as
      // unknown membership, rather than rejecting a valid allocation key or
      // inventing GHP-PREPAID. The original value remains in provenance.
      const sourceBrand =
        record.BRAND === undefined ? undefined : field("BRAND");
      if (!sourceBrand) missingSourceBrandRows++;
      const row = datasetSchemas.reference.parse({
        period,
        client: "300",
        company: "GLOB",
        ...(sourceBrand ? { source_brand: sourceBrand } : {}),
        ...(record.PSTKY === undefined ? {} : { posting_key: field("PSTKY") }),
        cost_element: account.padStart(10, "0"),
        brand: field("WWBRD").toUpperCase(),
        cfu: field("WWSPA").toUpperCase(),
        revenue_type: field("WWST").toUpperCase(),
        sub_product: field("SPB"),
        tax_rate: field("TAXRATE"),
        average_rate: field("AVERATE"),
        uom: field("DUOM"),
      });
      if (!row.brand || !row.cfu || !row.revenue_type || !row.sub_product)
        throw Error("Reference classification fields must not be empty.");
      rows.push(row);
      provenance.push({ line: index + 1, source: record });
    } catch (error) {
      throw Error(
        `Reference line ${index + 1}: ${error instanceof Error ? error.message : "Invalid row"}`,
      );
    }
  }
  if (!rows.length)
    throw Error("No client-300 GLOB reference rows were found.");
  const output = Buffer.from(
    rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  return {
    output,
    rows,
    provenance,
    report: {
      period,
      inputRows,
      rowCount: rows.length,
      skippedClientRows,
      missingSourceBrandRows,
      sourceSha256: hash(bytes),
      sha256: hash(output),
      verifiedMappingSource: false,
    },
  };
}
