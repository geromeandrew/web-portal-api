/** Additive 012. Existing snapshots retain strict validation. Explicit new
 * legacy_all_matches snapshots use every C014 reference match and C133's
 * zero-rate quantity, with diagnostic warnings rather than arbitrary rates.
 * Reconciliation, source coverage, layout and journal guards remain blocking.
 */
export function prepaidReferencePolicyMigrationSql(schema: string) {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw Error("Invalid schema");
  const s = `"${schema}"`;
  return `
CREATE OR REPLACE FUNCTION ${s}.prepaid_build_outputs(p_revision uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE config jsonb;
BEGIN
 SELECT x.configuration INTO config FROM ${s}.prepaid_region_revisions r
 JOIN ${s}.prepaid_source_snapshots x ON x.id=r.source_snapshot_id WHERE r.id=p_revision;
 IF config->>'accountingProfile'='legacy_sql_v1' THEN
   PERFORM ${s}.prepaid_build_legacy_outputs(p_revision);
   IF config->>'referenceValidationPolicy'='legacy_all_matches'
     AND config->'referenceExport'->>'approved'='true' THEN
     -- C014/C013 already retained all matching rates; C133 already used
     -- NULLIF(AVERATE,0) / COALESCE(...,0). Never remove or choose rate rows.
     UPDATE ${s}.prepaid_validation_results v SET
       findings=(SELECT coalesce(jsonb_agg(
         CASE WHEN f.value->>'code' IN ('REFERENCE_MAPPING_AMBIGUOUS','AVERAGE_RATE_ZERO')
         THEN f.value||jsonb_build_object('severity','warning','policy','legacy_all_matches')
         ELSE f.value END ORDER BY f.ordinality),'[]'::jsonb)
         FROM jsonb_array_elements(v.findings) WITH ORDINALITY f(value,ordinality)),
       valid=NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v.findings) f
         WHERE coalesce(f->>'code','') NOT IN ('REFERENCE_MAPPING_AMBIGUOUS','AVERAGE_RATE_ZERO'))
     WHERE v.revision_id=p_revision;
   END IF;
 ELSE
   PERFORM ${s}.prepaid_build_outputs_v1(p_revision);
 END IF;
END $$;
`;
}
