import { prepaidReferencePolicyMigrationSql } from "./referencePolicyMigration.js";

/** 014: explain legacy cutoff/rounding without weakening source, variance or JV guards.
 * The original C132/C133 SELECTs reproduce the current sample totals exactly.
 * Only a conserved pre-cutoff basis with exact legacy formulas is advisory.
 * Multiple-rate fan-out/non-conserved denominators remain blocking. */
export function prepaidValidationReviewMigrationSql(schema: string) {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw Error("Invalid schema");
  const s = `"${schema}"`;
  const approved = `(config->'referenceExport'->>'approved'='true' OR
    (config->'referenceVersion'->>'approved'='true' AND EXISTS(
      SELECT 1 FROM ${s}.prepaid_reference_versions v WHERE v.sha256=config->'referenceVersion'->>'sha256'
        AND v.sealed AND v.row_count=(config->'referenceVersion'->>'rowCount')::integer)))`;
  const dispatcher = prepaidReferencePolicyMigrationSql(schema)
    .replace("config->'referenceExport'->>'approved'='true'", approved)
    .replace(
      "END $$;",
      () => `PERFORM ${s}.prepaid_review_validation(p_revision);\nEND $$;`,
    );
  return `
CREATE FUNCTION ${s}.prepaid_review_validation(p_revision uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE config jsonb; differences jsonb; legacy_explained boolean;
BEGIN
 SELECT x.configuration INTO config FROM ${s}.prepaid_region_revisions r
 JOIN ${s}.prepaid_source_snapshots x ON x.id=r.source_snapshot_id WHERE r.id=p_revision;
 IF config->>'accountingProfile' IS DISTINCT FROM 'legacy_sql_v1' OR config->>'referenceValidationPolicy' IS DISTINCT FROM 'legacy_all_matches'
   OR NOT coalesce(${approved},false) THEN RETURN; END IF;
 WITH amounts AS (
   SELECT revenue_type,max(gross) expected_gross,sum(amount2*(1+tax_rate)) allocated_gross,
     round(max(gross)-sum(amount2*(1+tax_rate)),2) difference,
     count(*) FILTER(WHERE amount/nullif(denominator,0)<0.00001) clipped_rows,
     count(DISTINCT denominator)=1 AND min(denominator)<>0 AND sum(amount)=max(denominator)
     AND bool_and(allocation IS NOT DISTINCT FROM CASE WHEN denominator=0 THEN NULL
       WHEN amount/denominator<0.00001 THEN 0 ELSE amount/denominator END)
     AND bool_and(amount2 IS NOT DISTINCT FROM round(gross*allocation/(1+tax_rate),2)) explained
   FROM ${s}.prepaid_allocations WHERE revision_id=p_revision AND allocation_type='' GROUP BY revenue_type
 ) SELECT coalesce(jsonb_agg(jsonb_build_object('revenueType',revenue_type,
     'expectedGross',expected_gross::text,'allocatedGross',round(allocated_gross,2)::text,
     'difference',difference::text,'clippedRows',clipped_rows,'legacyExplained',explained)
     ORDER BY revenue_type),'[]'::jsonb),coalesce(bool_and(explained),false)
 INTO differences,legacy_explained FROM amounts WHERE difference<>0;
 UPDATE ${s}.prepaid_validation_results v SET findings=(
   SELECT coalesce(jsonb_agg(CASE WHEN f->>'code'='RECONCILIATION_DIFFERENCE' THEN
     f||jsonb_build_object('details',differences)||CASE WHEN legacy_explained THEN
       jsonb_build_object('severity','warning','policy','legacy_all_matches','basis','legacy_threshold_and_rounding')
       ELSE '{}'::jsonb END ELSE f END),'[]'::jsonb)
   FROM jsonb_array_elements(v.findings) f) WHERE revision_id=p_revision;
 UPDATE ${s}.prepaid_validation_results SET valid=NOT EXISTS(
   SELECT 1 FROM jsonb_array_elements(findings) f WHERE coalesce(f->>'severity','error')<>'warning')
 WHERE revision_id=p_revision;
END $$;
${dispatcher}`;
}
