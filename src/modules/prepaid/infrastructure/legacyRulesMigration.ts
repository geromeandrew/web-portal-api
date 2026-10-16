/** Verified legacy helpers; activation does not rewrite historical financial rows. */
export function prepaidLegacyRulesMigrationSql(schema: string) {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw Error("Invalid schema");
  const s = `"${schema}"`;
  return `
CREATE TABLE ${s}.prepaid_source_totals (
 revision_id uuid NOT NULL REFERENCES ${s}.prepaid_region_revisions(id),
 snapshot_id uuid NOT NULL REFERENCES ${s}.prepaid_source_snapshots(id),
 layout_number integer NOT NULL CHECK(layout_number IN(8,9,10)),
 original_gross numeric(33,2) NOT NULL,
 PRIMARY KEY(revision_id,snapshot_id,layout_number)
);
CREATE TRIGGER prepaid_totals_audit BEFORE UPDATE OR DELETE ON ${s}.prepaid_source_totals
 FOR EACH ROW EXECUTE FUNCTION ${s}.prepaid_guard_audit();
CREATE TRIGGER prepaid_totals_frozen BEFORE INSERT OR UPDATE OR DELETE ON ${s}.prepaid_source_totals
 FOR EACH ROW EXECUTE FUNCTION ${s}.prepaid_guard_frozen_rows();

CREATE FUNCTION ${s}.prepaid_capture_source_totals(p_revision uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE snap uuid; rg text;
BEGIN
 PERFORM ${s}.prepaid_assert_draft(p_revision);
 SELECT source_snapshot_id,region INTO snap,rg FROM ${s}.prepaid_region_revisions WHERE id=p_revision AND imported;
 IF snap IS NULL OR rg<>'eg' THEN RETURN; END IF;
 -- Read immutable imported sources, never an already edited layout total.
 INSERT INTO ${s}.prepaid_source_totals(revision_id,snapshot_id,layout_number,original_gross)
 SELECT p_revision,snap,8,coalesce(sum(round((data->>'amount')::numeric,0)),0) FROM ${s}.prepaid_stage_callcard WHERE snapshot_id=snap AND data->>'region'='eg'
 UNION ALL SELECT p_revision,snap,9,coalesce(round(sum((data->>'amount')::numeric),2),0) FROM ${s}.prepaid_stage_loadup WHERE snapshot_id=snap AND data->>'region'='eg'
 UNION ALL SELECT p_revision,snap,10,coalesce(round(sum((data->>'amount')::numeric),2),0) FROM ${s}.prepaid_stage_loadapi WHERE snapshot_id=snap AND data->>'region'='eg'
 ON CONFLICT DO NOTHING;
END $$;

CREATE FUNCTION ${s}.prepaid_preserve_source_totals(p_revision uuid,p_actor uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE snap uuid; changes jsonb;
BEGIN
 PERFORM ${s}.prepaid_assert_draft(p_revision);
 SELECT r.source_snapshot_id INTO snap FROM ${s}.prepaid_region_revisions r JOIN ${s}.prepaid_source_snapshots x ON x.id=r.source_snapshot_id
 WHERE r.id=p_revision AND r.region='eg' AND r.imported AND x.configuration->>'sourceSplitPolicy'='legacy_eg_total';
 IF snap IS NULL THEN RETURN; END IF;
 PERFORM ${s}.prepaid_capture_source_totals(p_revision);
 SELECT coalesce(jsonb_agg(jsonb_build_object('layoutNumber',l.layout_number,'field','gp_mt_gross','previous',l.gp_mt_gross::text,'value',(t.original_gross-coalesce(l.hy_mt_gross,0)-coalesce(l.gp_bb_gross,0))::text,'derived',true)),'[]'::jsonb)
 INTO changes FROM ${s}.prepaid_layout_rows l JOIN ${s}.prepaid_source_totals t ON t.revision_id=l.revision_id AND t.layout_number=l.layout_number AND t.snapshot_id=snap
 WHERE l.revision_id=p_revision AND l.gp_mt_gross IS DISTINCT FROM t.original_gross-coalesce(l.hy_mt_gross,0)-coalesce(l.gp_bb_gross,0);
 UPDATE ${s}.prepaid_layout_rows l SET gp_mt_gross=t.original_gross-coalesce(l.hy_mt_gross,0)-coalesce(l.gp_bb_gross,0)
 FROM ${s}.prepaid_source_totals t WHERE l.revision_id=p_revision AND t.revision_id=l.revision_id AND t.layout_number=l.layout_number AND t.snapshot_id=snap;
 IF jsonb_array_length(changes)>0 THEN
 INSERT INTO ${s}.prepaid_adjustments(revision_id,actor_id,reason,changes) VALUES(p_revision,p_actor,'Legacy EG source-total remainder calculation',changes);
 END IF;
 PERFORM ${s}.prepaid_recompute_layout(p_revision);
END $$;

CREATE VIEW ${s}.prepaid_reference_membership AS
 SELECT snapshot_id,upper(data->>'source_brand') source_brand,upper(data->>'brand')||'_'||upper(data->>'cfu')||'_'||upper(data->>'revenue_type') revenue_type,data->>'sub_product' sub_product
 FROM ${s}.prepaid_stage_reference;
CREATE VIEW ${s}.prepaid_membership_report AS
 SELECT a.* FROM ${s}.prepaid_allocations a JOIN ${s}.prepaid_region_revisions r ON r.id=a.revision_id
 WHERE a.revenue_type<>'' AND NOT EXISTS(SELECT 1 FROM ${s}.prepaid_reference_membership b WHERE b.snapshot_id=r.source_snapshot_id AND b.source_brand='GHP-PREPAID' AND b.revenue_type=a.revenue_type AND b.sub_product=a.sub_product);
CREATE VIEW ${s}.prepaid_membership_report_v2 AS
 SELECT DISTINCT revision_id,revenue_type,sub_product,cost_element FROM ${s}.prepaid_membership_report
 WHERE revenue_type LIKE 'GP%' AND revenue_type NOT LIKE '%BB';
`;
}
