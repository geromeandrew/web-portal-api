import { prepaidMigrationSql } from "./migrations.js";

/** Additive 010. Old snapshots keep the original computation profile. New
 * legacy_sql_v1 snapshots follow C012/C013/C014/C121/C131/C132/C133 literally,
 * including C013's revenue-type-only denominator join. No invented rates,
 * reference records or historical financial rows are written by this migration.
 */
export function prepaidAccountingParityMigrationSql(schema: string) {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw Error("Invalid schema");
  const s = `"${schema}"`;
  const original = prepaidMigrationSql(schema);
  const begin = `CREATE FUNCTION ${s}.prepaid_build_outputs(p_revision uuid)`;
  const end = `CREATE FUNCTION ${s}.prepaid_freeze_layout`;
  let build = original.slice(original.indexOf(begin), original.indexOf(end));
  const v1 = build.replace(
    ".prepaid_build_outputs(p_revision uuid)",
    ".prepaid_build_outputs_v1(p_revision uuid)",
  );
  const replace = (from: string, to: string) => {
    if (!build.includes(from))
      throw Error("Accounting migration template drift");
    build = build.replace(from, to);
  };
  replace(
    ".prepaid_build_outputs(p_revision uuid)",
    ".prepaid_build_legacy_outputs(p_revision uuid)",
  );
  build = build.replaceAll(
    ".prepaid_reference_expanded",
    ".prepaid_legacy_reference_expanded",
  );
  // C014 already implements fallback exclusion. Limit ambiguity to reference
  // keys actually used by this region; unrelated mappings cannot block Freeze.
  const ambiguity = build.indexOf(
    " IF EXISTS(SELECT 1 FROM",
    build.indexOf("REFERENCE_MAPPING_MISSING"),
  );
  const allocation = build.indexOf(" INSERT INTO", ambiguity);
  if (ambiguity < 0 || allocation < 0)
    throw Error("Accounting validation template drift");
  build =
    build.slice(0, ambiguity) +
    `
 IF EXISTS(SELECT 1 FROM ${s}.prepaid_legacy_reference_expanded r
   WHERE r.snapshot_id=snap AND EXISTS(SELECT 1 FROM ${s}.prepaid_ke24 k
     JOIN ${s}.prepaid_allocation_mapping m ON m.allocation_type=k.brand||'_'||k.cfu||'_'||k.revenue_type||CASE WHEN k.brand||'_'||k.cfu||'_'||k.revenue_type IN('GP_CB_BB','GP_SG_MT') AND left(k.reference_document,1)='8' THEN '_8' ELSE '' END
     WHERE k.snapshot_id=snap AND split_part(m.revenue_type,'_',2)=upper(rg)
       AND r.cost_element=k.cost_element AND r.brand=k.brand AND r.cfu=k.cfu AND r.revenue_type=k.revenue_type AND upper(r.sub_product)=upper(k.sub_product))
   GROUP BY r.cost_element,r.brand,r.cfu,r.revenue_type,upper(r.sub_product)
   HAVING count(DISTINCT(r.tax_rate,r.average_rate,r.uom))>1)
 THEN findings:=findings||'[{"code":"REFERENCE_MAPPING_AMBIGUOUS"}]'::jsonb; END IF;
` +
    build.slice(allocation);
  replace(
    "r.sub_product=k.sub_product",
    "upper(r.sub_product)=upper(k.sub_product)",
  );
  const cteStart = build.indexOf(" WITH grouped AS(");
  const cteEnd = build.indexOf(" amounts AS(", cteStart);
  if (cteStart < 0 || cteEnd < 0)
    throw Error("Accounting allocation template drift");
  build =
    build.slice(0, cteStart) +
    `
 WITH grouped AS MATERIALIZED (
   SELECT k.period,k.profit_center,k.cost_element,k.sub_product,k.uom source_uom,
     k.brand,k.cfu,k.revenue_type original_type,m.revenue_type,
     sum(k.quantity) hits,sum(k.amount) amount
   FROM ${s}.prepaid_ke24 k JOIN ${s}.prepaid_allocation_mapping m
     ON m.allocation_type=k.brand||'_'||k.cfu||'_'||k.revenue_type||CASE WHEN k.brand||'_'||k.cfu||'_'||k.revenue_type IN('GP_CB_BB','GP_SG_MT') AND left(k.reference_document,1)='8' THEN '_8' ELSE '' END
   WHERE k.snapshot_id=snap AND split_part(m.revenue_type,'_',2)=upper(rg)
   GROUP BY k.period,k.profit_center,k.cost_element,k.sub_product,k.uom,k.brand,k.cfu,k.revenue_type,m.revenue_type
 ), denominators AS MATERIALIZED (
   SELECT period,profit_center,revenue_type,sum(amount) denominator FROM grouped
   GROUP BY period,profit_center,revenue_type
 ), reference_rows AS MATERIALIZED (
   SELECT DISTINCT cost_element,brand,cfu,revenue_type,sub_product,tax_rate,average_rate,uom,posting_key
   FROM ${s}.prepaid_legacy_reference_expanded WHERE snapshot_id=snap
 ), legacy_grouped AS (
   SELECT d.period,d.profit_center,d.cost_element,d.sub_product,d.revenue_type,
     ref.uom,ref.tax_rate,ref.average_rate,n.denominator,
     sum(d.hits) hits,sum(d.amount) amount
   FROM grouped d JOIN denominators n ON n.revenue_type=d.revenue_type
   LEFT JOIN reference_rows ref ON ref.cost_element=d.cost_element AND ref.brand=d.brand
     AND ref.cfu=d.cfu AND ref.revenue_type=d.original_type AND upper(ref.sub_product)=upper(d.sub_product)
   GROUP BY d.period,d.profit_center,d.cost_element,d.sub_product,d.revenue_type,
     ref.uom,ref.tax_rate,ref.average_rate,n.denominator
 ), referenced AS (
   SELECT d.*,CASE WHEN denominator=0 THEN NULL WHEN amount/denominator<.00001 THEN 0 ELSE amount/denominator END allocation,
     CASE split_part(d.revenue_type,'_',1)||'_'||split_part(d.revenue_type,'_',3)
       WHEN 'HY_MT' THEN l.hy_mt_gross WHEN 'GP_MT' THEN l.gp_mt_gross ELSE l.gp_bb_gross END gross
   FROM legacy_grouped d JOIN ${s}.prepaid_layout_rows l ON l.revision_id=p_revision AND l.layout_number=18
 ),
` +
    build.slice(cteEnd);
  // C145 multiplies already-rounded source quantities by the BB split; C146
  // sums them without a second whole-number rounding (0.5 must remain 0.5).
  replace("round(sum(a.hits2*split.factor),0)", "sum(a.hits2*split.factor)");
  return `
CREATE VIEW ${s}.prepaid_legacy_reference_expanded AS
WITH original AS NOT MATERIALIZED (
 SELECT snapshot_id,lpad(data->>'cost_element',10,'0') cost_element,
   upper(data->>'brand') brand,upper(data->>'cfu') cfu,upper(data->>'revenue_type') revenue_type,
   data->>'sub_product' sub_product,(data->>'tax_rate')::numeric tax_rate,
   (data->>'average_rate')::numeric average_rate,data->>'uom' uom,
   coalesce(data->>'posting_key','') posting_key
 FROM ${s}.prepaid_stage_reference
), fallback_targets AS (
 SELECT o.*,t.cfu target_cfu,t.revenue_type target_type
 FROM original o CROSS JOIN LATERAL (
   SELECT CASE o.cfu WHEN 'CB' THEN 'SG' ELSE 'CB' END cfu,'BB' revenue_type WHERE o.brand='GP' AND o.revenue_type='BB' AND o.cfu IN('CB','SG')
   UNION SELECT 'SG','MT' WHERE o.brand='GP' AND o.revenue_type='BB' AND o.cfu IN('CB','SG')
   UNION SELECT cfu,'BB' FROM (VALUES('CB'),('SG')) v(cfu) WHERE o.brand='GP' AND o.cfu='SG' AND o.revenue_type='MT'
 ) t
)
SELECT snapshot_id,cost_element,brand,cfu,revenue_type,sub_product,tax_rate,average_rate,uom,0 priority,posting_key FROM original
UNION
SELECT o.snapshot_id,o.cost_element,o.brand,o.target_cfu,o.target_type,o.sub_product,o.tax_rate,o.average_rate,o.uom,1,o.posting_key
FROM fallback_targets o WHERE NOT EXISTS(
 SELECT 1 FROM original direct WHERE direct.snapshot_id=o.snapshot_id AND direct.cost_element=o.cost_element
   AND direct.brand=o.brand AND direct.cfu=o.target_cfu AND direct.revenue_type=o.target_type
   AND upper(direct.sub_product)=upper(o.sub_product) AND direct.posting_key=o.posting_key
);
${build}
${v1}
CREATE OR REPLACE FUNCTION ${s}.prepaid_build_outputs(p_revision uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM ${s}.prepaid_region_revisions r JOIN ${s}.prepaid_source_snapshots x ON x.id=r.source_snapshot_id
   WHERE r.id=p_revision AND x.configuration->>'accountingProfile'='legacy_sql_v1')
 THEN PERFORM ${s}.prepaid_build_legacy_outputs(p_revision);
 ELSE PERFORM ${s}.prepaid_build_outputs_v1(p_revision); END IF;
END $$;
`;
}
