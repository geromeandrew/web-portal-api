import { datasetSchemas } from "./contracts.js";
import { z } from "zod";

type Reference = z.infer<typeof datasetSchemas.reference>;
export interface ReferenceUsage {
  cost_element: string;
  brand: string;
  cfu: string;
  revenue_type: string;
  sub_product: string;
  source_entries: string;
  absolute_activity: string;
  amount: string;
}
const normalized = (v: string) => v.trim().toUpperCase();
export const referenceKey = (
  r: Pick<
    Reference,
    "cost_element" | "brand" | "cfu" | "revenue_type" | "sub_product"
  >,
) =>
  [
    r.cost_element.padStart(10, "0"),
    r.brand,
    r.cfu,
    r.revenue_type,
    r.sub_product,
  ]
    .map(normalized)
    .join("|");
// Normalize exact decimal strings for equality only; never coerce money/rates to floats.
const decimal = (value: string) => {
  const [whole, fraction = ""] = value.replace(/^\+/, "").split(".");
  const integer = whole.replace(/^(-?)0+(?=\d)/, "$1"),
    tail = fraction.replace(/0+$/, "");
  const result = integer + (tail ? "." + tail : "");
  return /^-?0$/.test(result) ? "0" : result;
};
export function assessReferenceCoverage(
  used: ReferenceUsage[],
  reference: Reference[],
  policy?: "legacy_all_matches",
) {
  const original = reference.map((value) => ({
    ...value,
    cost_element: value.cost_element.padStart(10, "0"),
    brand: normalized(value.brand),
    cfu: normalized(value.cfu),
    revenue_type: normalized(value.revenue_type),
    sub_product: normalized(value.sub_product),
  }));
  const originalKeys = new Set(
    original.map((row) => `${referenceKey(row)}|${row.posting_key ?? ""}`),
  );
  const expanded = new Map<string, Map<string, Reference>>();
  const add = (row: Reference) => {
    const key = referenceKey(row),
      values = expanded.get(key) ?? new Map<string, Reference>();
    values.set(
      JSON.stringify([
        row.posting_key ?? "",
        decimal(row.tax_rate),
        decimal(row.average_rate),
        row.uom,
      ]),
      row,
    );
    expanded.set(key, values);
  };
  const rules = [
    ["CB", "BB", "SG", "BB"],
    ["SG", "BB", "CB", "BB"],
    ["CB", "BB", "SG", "MT"],
    ["SG", "MT", "CB", "BB"],
    ["SG", "BB", "SG", "MT"],
    ["SG", "MT", "SG", "BB"],
  ];
  for (const row of original) {
    add(row);
    if (row.brand !== "GP") continue;
    for (const [cfu, revenue, targetCfu, targetRevenue] of rules) {
      if (row.cfu !== cfu || row.revenue_type !== revenue) continue;
      const target = { ...row, cfu: targetCfu, revenue_type: targetRevenue };
      if (!originalKeys.has(`${referenceKey(target)}|${row.posting_key ?? ""}`))
        add(target);
    }
  }
  const missing: ReferenceUsage[] = [],
    ambiguous: object[] = [],
    zeroRates: object[] = [];
  for (const key of used) {
    const rows = [...(expanded.get(referenceKey(key))?.values() ?? [])];
    if (!rows.length) {
      missing.push(key);
      continue;
    }
    const rates = [
      ...new Set(
        rows.map((row) =>
          JSON.stringify([
            decimal(row.tax_rate),
            decimal(row.average_rate),
            row.uom,
          ]),
        ),
      ),
    ];
    if (rates.length > 1)
      ambiguous.push({
        ...key,
        mappings: rates.map((value) => JSON.parse(value)),
      });
    if (
      decimal(key.absolute_activity) !== "0" &&
      rows.some((row) => decimal(row.average_rate) === "0")
    )
      zeroRates.push({
        ...key,
        reason:
          "A used reference has zero AVERATE; no replacement value was invented.",
      });
  }
  const postingKeysPresent = reference.every(
    (row) =>
      typeof row.posting_key === "string" && row.posting_key.trim().length > 0,
  );
  return {
    usedKeys: used.length,
    referenceRows: reference.length,
    missing,
    ambiguous,
    zeroRates,
    postingKeysPresent,
    complete:
      !missing.length &&
      (policy === "legacy_all_matches" ||
        (!ambiguous.length && !zeroRates.length)) &&
      postingKeysPresent,
  };
}
