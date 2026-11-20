/** Snapshot-bounded C014 expansion. The original snapshot and each fallback set
 * are materialized once, avoiding a JSON expression merge-join repeatedly
 * scanning thousands of sub-products sharing one account. Financial rows are
 * untouched; this replaces only the new profile's reference lookup. */
export function prepaidReferenceLookupMigrationSql(schema: string) {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw Error("Invalid schema");
  const s = `"${schema}"`;
  return `
CREATE FUNCTION ${s}.prepaid_legacy_reference_for_snapshot(p_snapshot uuid)
RETURNS TABLE(cost_element text,brand text,cfu text,revenue_type text,sub_product text,
 tax_rate numeric,average_rate numeric,uom text,priority integer,posting_key text)
LANGUAGE sql STABLE SET search_path='' AS $$
WITH original AS MATERIALIZED (
 SELECT lpad(data->>'cost_element',10,'0') cost_element,
   upper(data->>'brand') brand,upper(data->>'cfu') cfu,upper(data->>'revenue_type') revenue_type,
   upper(data->>'sub_product') sub_product,(data->>'tax_rate')::numeric tax_rate,
   (data->>'average_rate')::numeric average_rate,data->>'uom' uom,
   coalesce(data->>'posting_key','') posting_key
 FROM ${s}.prepaid_stage_reference WHERE snapshot_id=p_snapshot
), fallback_targets AS MATERIALIZED (
 SELECT o.*,t.target_cfu,t.target_type FROM original o
 JOIN (VALUES('CB','BB','SG','BB'),('SG','BB','CB','BB'),
   ('CB','BB','SG','MT'),('SG','MT','CB','BB'),
   ('SG','BB','SG','MT'),('SG','MT','SG','BB'))
 t(source_cfu,source_type,target_cfu,target_type)
 ON o.brand='GP' AND o.cfu=t.source_cfu AND o.revenue_type=t.source_type
)
SELECT cost_element,brand,cfu,revenue_type,sub_product,tax_rate,average_rate,uom,0,posting_key FROM original
UNION
SELECT o.cost_element,o.brand,o.target_cfu,o.target_type,o.sub_product,o.tax_rate,o.average_rate,o.uom,1,o.posting_key
FROM fallback_targets o WHERE NOT EXISTS(
 SELECT 1 FROM original direct WHERE direct.cost_element=o.cost_element
   AND direct.brand=o.brand AND direct.cfu=o.target_cfu AND direct.revenue_type=o.target_type
   AND direct.sub_product=o.sub_product AND direct.posting_key=o.posting_key
);
$$;
CREATE OR REPLACE VIEW ${s}.prepaid_legacy_reference_expanded AS
SELECT x.id snapshot_id,r.* FROM ${s}.prepaid_source_snapshots x
CROSS JOIN LATERAL ${s}.prepaid_legacy_reference_for_snapshot(x.id) r;
`;
}
