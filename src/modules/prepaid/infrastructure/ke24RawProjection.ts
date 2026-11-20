import type { Client } from "pg";
import {
  GlueRawSourceValidationError,
  type RawRow,
} from "../domain/nativeRawSource.js";

const field = (name: string) => `trim(coalesce("${name}"::text,''))`;
const numeric = (name: string, nullable = false) => {
  const value = field(name);
  const pattern =
    "^[+-]?(?:[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+)(?:[.][0-9]+)?(?:[eE][+-]?[0-9]{1,2})?$";
  return `CASE WHEN ${nullable ? `${value}='' THEN true WHEN ` : ""}length(${value})<=128 AND ${value} ~ '${pattern}' THEN abs(replace(${value},',','')::numeric)<1e28 ELSE false END`;
};
const period = `CASE WHEN ${field("Period/Year")} ~ '^[0-9]{1,3}[./][0-9]{4}$' THEN
 CASE WHEN split_part(replace(${field("Period/Year")},'/','.'),'.',1)::integer BETWEEN 1 AND 12
 THEN right(${field("Period/Year")},4)||'-'||lpad(split_part(replace(${field("Period/Year")},'/','.'),'.',1)::integer::text,2,'0') ELSE 'invalid' END
 ELSE ${field("Period/Year")} END`;
const uuidPattern =
  "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const base = `WITH source AS (SELECT *, ${period} AS normalized_period,
 CASE WHEN sequentialid::text ~* '${uuidPattern}' THEN
 ('x'||substr(replace(sequentialid::text,'-',''),1,12))::bit(48)::bigint END AS written_ms
 FROM sdbtdir1_prepaid_dbo."dcKE24" WHERE split_part(filename,' - ',1)=ANY($1::text[]))`;

/** Legacy FormatC010 performs SUM/GROUP BY over dcKE24 before layout import.
 * Apply that lossless reduction at the database boundary. Validate EVERY raw row
 * before reducing it; do not silently drop malformed or stale financial records.
 * This keeps large native outputs out of the Node/Python JSON working set.
 */
export async function projectKe24Raw(
  client: Pick<Client, "query">,
  names: string[],
  started: Date,
  completed: Date,
) {
  const counts = await client.query(
    `${base} SELECT count(*)::text AS total,
    count(DISTINCT lower(sequentialid::text))::text AS identities,
    count(*) FILTER(WHERE written_ms IS NULL OR written_ms<$2 OR written_ms>$3 OR dateread IS NULL)::text AS stale,
    count(*) FILTER(WHERE normalized_period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' OR left(normalized_period,4)='0000'
      OR upper(${field("CACur")})<>'PHP' OR ${field("Cost Element")} !~ '^[0-9]{1,10}$'
      OR ${field("Brand")}='' OR ${field("Sub-Product Group A")}='' OR ${field("Product-Rev Type")}=''
      OR ${field("Profit Center")}='' OR ${field("Sub-Product Group B")}=''
      OR NOT (${numeric("Value TranCurr")}) OR NOT (${numeric("Total Quantity", true)}))::text AS invalid
    FROM source`,
    [names, started.getTime(), completed.getTime()],
  );
  const evidence = counts.rows[0];
  const rowCount = Number(evidence.total);
  if (rowCount > 1048576)
    throw new GlueRawSourceValidationError(
      "KE24 raw output exceeds the supported workbook row limit.",
    );
  if (Number(evidence.stale) || Number(evidence.identities) !== rowCount)
    throw new GlueRawSourceValidationError(
      "KE24 raw output contains stale, missing or duplicate extraction row identities.",
    );
  if (Number(evidence.invalid))
    throw new GlueRawSourceValidationError(
      "KE24 extracted records contain invalid accounting fields or amounts.",
    );
  const referenceBucket = `CASE WHEN upper(${field("Brand")})||'_'||upper(${field("Sub-Product Group A")})||'_'||upper(${field("Product-Rev Type")}) IN ('GP_CB_BB','GP_SG_MT') AND left(${field("Reference document")},1)='8' THEN '8' ELSE '' END`;
  const dimensions = [
    ["Period/Year", "normalized_period"],
    ["Cost Element", `lpad(${field("Cost Element")},10,'0')`],
    ["Profit Center", field("Profit Center")],
    ["Sub-Product Group B", field("Sub-Product Group B")],
    ["Unit of Measure", field("Unit of Measure")],
    ["Sub-Product Group A", `upper(${field("Sub-Product Group A")})`],
    ["Brand", `upper(${field("Brand")})`],
    ["Product-Rev Type", `upper(${field("Product-Rev Type")})`],
    ["Reference document", referenceBucket],
    ["filename", "filename"],
  ];
  const result = await client.query<RawRow>(
    `${base} SELECT
    ${dimensions.map(([name, expression]) => `${expression} AS "${name}"`).join(",")}, 'PHP'::text AS "CACur",
    sum(replace(${field("Value TranCurr")},',','')::numeric)::text AS "Value TranCurr",
    sum(coalesce(nullif(replace(${field("Total Quantity")},',',''),''),'0')::numeric)::text AS "Total Quantity",
    min(sequentialid::text) AS sequentialid, min(dateread)::text AS dateread, min(rownum)::text AS rownum
    FROM source GROUP BY ${dimensions.map((_, i) => i + 1).join(",")} ORDER BY ${dimensions.map((_, i) => i + 1).join(",")} LIMIT 100001`,
    [names],
  );
  if (result.rows.length > 100000)
    throw new GlueRawSourceValidationError(
      "KE24 grouped output exceeds the accounting snapshot limit.",
    );
  return { rows: result.rows, rowCount };
}
