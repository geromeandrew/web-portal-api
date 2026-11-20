/** Raw targets verified against Aurora and the four supplied Glue workflows.
 * These are NOT the immutable prepaid_stage_* tables. Preserve legacy names,
 * widths and identity behavior: existing producers depend on them.
 */
export const prepaidRawSchema = "sdbtdir1_prepaid_dbo";
type Column = {
  name: string;
  type: string;
  notNull?: boolean;
  identity?: boolean;
};
const varchar = (name: string, width = 255): Column => ({
  name,
  type: `character varying(${width})`,
});
const numbered = (start: number, end: number, width = 255) =>
  Array.from({ length: end - start + 1 }, (_, i) =>
    varchar(`column${start + i}`, width),
  );
const metadata = (identity: boolean, filenameRequired = false): Column[] => [
  { name: "rownum", type: "integer", identity, notNull: identity },
  { name: "sequentialid", type: "uuid" },
  { name: "dateread", type: "timestamp without time zone" },
  { ...varchar("filename"), notNull: filenameRequired },
];
export const prepaidRawTables: Record<string, Column[]> = {
  dccallcard_sg: [
    varchar("column1"),
    varchar("trade"),
    ...numbered(3, 6),
    varchar("INTERNAL  (BASED ON SALES)"),
    ...numbered(8, 11),
    varchar("total"),
    ...numbered(13, 26),
    ...metadata(true),
  ],
  dcload_api: [
    ...[
      "type",
      "App ID",
      "Wallet ID",
      "Company Name",
      "Dev Email",
      "Top up Amount",
      "TOP UP Date",
      "OR Number",
      "OR Date",
      "Payment Type",
      "Date deposited",
      "Gcash Number",
      "Credit Card Reference",
    ].map((name) => varchar(name)),
    ...numbered(14, 26),
    ...metadata(true),
  ],
  dcload_api_sg: [
    ...[
      "type",
      "Transactional Discount",
      "App ID",
      "Wallet ID",
      "Company Name",
      "Dev Email",
      "Top up Amount",
      "TOP UP Date",
      "OR Number",
      "OR Date",
      "Payment Type",
      "Date deposited",
      "Gcash Number",
      "Transaction ID",
      "Luke OR Referece",
    ].map((name) => varchar(name)),
    ...numbered(16, 27),
    ...metadata(true),
  ],
  billed_adjustments_header_cycles: [
    ...numbered(1, 10, 500),
    ...metadata(false, true),
  ],
  billed_adjustments_lineitem_cycles: [
    ...[
      "Customer Type",
      "Customer Sub Type",
      "Subscriber Type",
      "Adjustment Type",
      "Adjustment Code",
      "Adjustment Reason",
      "Legal Entity",
      "currency",
    ].map((name) => varchar(name, 500)),
    { name: "amount", type: "double precision" },
    varchar("Write-Off Activity Indicator", 500),
    ...metadata(false, true),
  ],
};
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** Fail on drift instead of silently modifying a populated producer table. */
export function prepaidRawSourceValidationSql(
  rawSchema = prepaidRawSchema,
  verifyIndex = true,
) {
  if (!/^[a-z_][a-z0-9_]*$/.test(rawSchema))
    throw new Error("Invalid raw source schema");
  const expected = Object.entries(prepaidRawTables).flatMap(
    ([table, columns]) =>
      columns.map((c, i) => ({
        table,
        name: c.name,
        type: c.type,
        position: i + 1,
        not_null: !!c.notNull,
        identity: c.identity ? "a" : "",
      })),
  );
  return `DO $prepaid_raw_check$
DECLARE expected record; actual record;
BEGIN
 FOR expected IN SELECT * FROM jsonb_to_recordset(${literal(JSON.stringify(expected))}::jsonb)
   AS x("table" text,name text,type text,position integer,not_null boolean,identity text)
 LOOP
   SELECT a.attname::text name,format_type(a.atttypid,a.atttypmod) type,
     a.attnum position,a.attnotnull not_null,a.attidentity::text identity,c.relkind::text kind
   INTO actual FROM pg_namespace n JOIN pg_class c ON c.relnamespace=n.oid
     JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
   WHERE n.nspname=${literal(rawSchema)} AND c.relname=expected."table" AND a.attname=expected.name;
   IF NOT FOUND OR actual.kind<>'r' OR actual.type<>expected.type
     OR actual.position<>expected.position OR actual.not_null<>expected.not_null
     OR actual.identity<>expected.identity THEN
     RAISE EXCEPTION 'Prepaid raw source schema mismatch: %.% column %. Existing objects have not been altered; review the producer contract.',
       ${literal(rawSchema)},expected."table",expected.name;
   END IF;
 END LOOP;
END $prepaid_raw_check$;
${
  verifyIndex
    ? `DO $prepaid_raw_index$
BEGIN
 IF NOT EXISTS (
   SELECT 1 FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid
   JOIN pg_namespace n ON n.oid=t.relnamespace
   JOIN pg_attribute a ON a.attrelid=t.oid AND a.attname='sequentialid'
   WHERE n.nspname=${literal(rawSchema)} AND t.relname='billed_adjustments_lineitem_cycles'
    AND i.indisunique AND i.indisvalid AND i.indpred IS NULL AND i.indexprs IS NULL
    AND i.indnkeyatts=1 AND i.indkey[0]=a.attnum
 ) THEN RAISE EXCEPTION 'Prepaid raw source schema mismatch: missing valid unique sequentialid index on %.billed_adjustments_lineitem_cycles',${literal(rawSchema)};
 END IF;
END $prepaid_raw_index$;`
    : ""
}`;
}

/** Additive migration 005. Never drops/renames/truncates/retypes existing tables. */
export function prepaidRawSourceMigrationSql(
  _portalSchema: string,
  rawSchema = prepaidRawSchema,
) {
  const initialValidation = prepaidRawSourceValidationSql(rawSchema, false);
  const s = quote(rawSchema);
  return `CREATE SCHEMA IF NOT EXISTS ${s};
${Object.entries(prepaidRawTables)
  .map(
    ([table, columns]) =>
      `CREATE TABLE IF NOT EXISTS ${s}.${quote(table)} (\n${columns
        .map(
          (c) =>
            `  ${quote(c.name)} ${c.type}${c.identity ? " GENERATED ALWAYS AS IDENTITY" : ""}${c.notNull ? " NOT NULL" : ""}`,
        )
        .join(",\n")}\n);`,
  )
  .join("\n")}
${initialValidation}
CREATE UNIQUE INDEX IF NOT EXISTS "IX_billed_adjustments_lineitem_cycles_ClusteredIndex-20231012-2"
 ON ${s}.billed_adjustments_lineitem_cycles(sequentialid);
${prepaidRawSourceValidationSql(rawSchema)}`;
}
