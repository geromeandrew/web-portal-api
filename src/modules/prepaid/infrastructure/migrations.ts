/** Only creates new Prepaid-owned objects. Never modifies legacy/Portal objects. */
export function prepaidMigrationSql(schema: string) {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema))
    throw new Error("Invalid Prepaid database schema");
  const s = `"${schema}"`;
  const tables = [
    "ke24",
    "callcard",
    "loadup",
    "loadapi",
    "recharge",
    "adjustments",
    "charges",
    "reference",
  ];
  return `
CREATE TABLE ${s}.prepaid_integrations (
  id boolean PRIMARY KEY DEFAULT true CHECK(id), configuration jsonb NOT NULL,
  updated_by uuid NOT NULL REFERENCES ${s}.app_user(id), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ${s}.prepaid_runs (
  id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES ${s}.workspaces(id),
  period text NOT NULL CHECK(period ~ '^\\d{4}-(0[1-9]|1[0-2])$'),
  created_by uuid NOT NULL REFERENCES ${s}.app_user(id), created_at timestamptz NOT NULL DEFAULT now(),
  configuration jsonb NOT NULL, UNIQUE(workspace_id,period)
);
CREATE TABLE ${s}.prepaid_workspace_selection (
  workspace_id uuid PRIMARY KEY REFERENCES ${s}.workspaces(id), run_id uuid NOT NULL REFERENCES ${s}.prepaid_runs(id)
);
CREATE TABLE ${s}.prepaid_source_files (
  id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES ${s}.prepaid_runs(id), source_code text NOT NULL,
  original_name text NOT NULL, object_key text NOT NULL UNIQUE, sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes bigint NOT NULL CHECK(size_bytes>0), active boolean NOT NULL DEFAULT true,
  uploaded_by uuid NOT NULL REFERENCES ${s}.app_user(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX prepaid_active_source ON ${s}.prepaid_source_files(run_id,source_code) WHERE active;
CREATE TABLE ${s}.prepaid_upstream_sources (
  id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES ${s}.prepaid_runs(id), manifest_key text NOT NULL,
  manifest jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), active boolean NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX prepaid_active_upstream ON ${s}.prepaid_upstream_sources(run_id) WHERE active;
CREATE TABLE ${s}.prepaid_source_snapshots (
  id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES ${s}.prepaid_runs(id), status text NOT NULL CHECK(status IN ('pending','ready','failed')),
  source_files jsonb NOT NULL, upstream_source jsonb, configuration jsonb NOT NULL, manifest jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
CREATE UNIQUE INDEX prepaid_pending_ingestion ON ${s}.prepaid_source_snapshots(run_id) WHERE status='pending';
${tables
  .map(
    (t) => `CREATE TABLE ${s}.prepaid_stage_${t} (
  snapshot_id uuid NOT NULL REFERENCES ${s}.prepaid_source_snapshots(id), row_number bigint NOT NULL,
  data jsonb NOT NULL, PRIMARY KEY(snapshot_id,row_number)
);`,
  )
  .join("\n")}
CREATE VIEW ${s}.prepaid_ke24 AS SELECT snapshot_id,row_number,data->>'period' period,upper(data->>'brand') brand,
  upper(data->>'cfu') cfu,upper(data->>'revenue_type') revenue_type,lpad(data->>'cost_element',10,'0') cost_element,
  data->>'profit_center' profit_center,data->>'sub_product' sub_product,data->>'uom' uom,
  data->>'reference_document' reference_document,(data->>'amount')::numeric(38,10) amount,
  (data->>'quantity')::numeric(38,10) quantity FROM ${s}.prepaid_stage_ke24;
CREATE VIEW ${s}.prepaid_reference AS SELECT snapshot_id,row_number,lpad(data->>'cost_element',10,'0') cost_element,
  upper(data->>'brand') brand,upper(data->>'cfu') cfu,upper(data->>'revenue_type') revenue_type,
  data->>'sub_product' sub_product,(data->>'tax_rate')::numeric tax_rate,
  (data->>'average_rate')::numeric average_rate,data->>'uom' uom FROM ${s}.prepaid_stage_reference;
CREATE TABLE ${s}.prepaid_region_revisions (
  id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES ${s}.prepaid_runs(id), region text NOT NULL CHECK(region IN ('eg','sg')),
  revision integer NOT NULL CHECK(revision>0), version integer NOT NULL DEFAULT 0,
  status text NOT NULL CHECK(status IN ('draft','frozen','superseded')),
  source_snapshot_id uuid REFERENCES ${s}.prepaid_source_snapshots(id), predecessor_id uuid REFERENCES ${s}.prepaid_region_revisions(id),
  imported boolean NOT NULL DEFAULT false, frozen_at timestamptz, frozen_by uuid REFERENCES ${s}.app_user(id),
  tax_rate numeric NOT NULL DEFAULT .12, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(run_id,region,revision)
);
CREATE UNIQUE INDEX prepaid_one_draft ON ${s}.prepaid_region_revisions(run_id,region) WHERE status='draft';
CREATE TABLE ${s}.prepaid_layout_templates (
  region text NOT NULL CHECK(region IN ('eg','sg')), layout_number integer NOT NULL,
  label text NOT NULL, tier integer CHECK(tier IN (1,2,3,4)), editable boolean NOT NULL DEFAULT false,
  PRIMARY KEY(region,layout_number)
);
INSERT INTO ${s}.prepaid_layout_templates(region,layout_number,label,tier,editable)
SELECT region,n, CASE
 WHEN n=1 THEN 'GP-'||upper(region)||'-MT' WHEN n=2 THEN 'HY-'||upper(region)||'-MT'
 WHEN n=3 THEN 'GP-'||upper(region)||'-NBB' WHEN n=4 THEN 'Total COPA'
 WHEN n=7 THEN 'TOTAL TOPUP SALES' WHEN n=15 THEN 'Total top-up sales'
 WHEN n=18 THEN 'ADDITIONAL REVENUE TO BE BOOKED' WHEN n=21 THEN 'RECLASSIFICATION'
 WHEN n=22 THEN 'GP_CM_MT' WHEN n=23 THEN 'GP_CB_BB'
 WHEN n=24 THEN CASE WHEN region='eg' THEN 'GP_SG_BB' ELSE 'GP_SG_MT' END
 WHEN n=27 THEN 'Variance'
 WHEN region='eg' THEN CASE n WHEN 8 THEN 'CALLCARD' WHEN 9 THEN 'LOAD UP' WHEN 10 THEN 'LOAD/REWARDS API'
   WHEN 11 THEN 'RECHARGE INSTRUCTION (recharge report)' WHEN 12 THEN 'AMAXCE' WHEN 13 THEN 'Adjustments' ELSE '' END
 ELSE CASE n WHEN 8 THEN 'LOAD UP' WHEN 9 THEN 'LOAD/REWARDS API' WHEN 10 THEN 'AMAXCE'
   WHEN 11 THEN 'RECHARGE INSTRUCTION (recharge report)' WHEN 12 THEN 'Callcard sales - Trade'
   WHEN 13 THEN 'Callcard sales - internal' WHEN 14 THEN 'Adjustments' ELSE '' END END,
 CASE WHEN n BETWEEN 1 AND 3 THEN 1 WHEN (region='eg' AND n BETWEEN 8 AND 13) OR (region='sg' AND n BETWEEN 8 AND 14) THEN 2
 WHEN n=18 THEN 3 WHEN n BETWEEN 22 AND 24 THEN 4 ELSE NULL END,
 CASE WHEN region='eg' THEN n IN (8,9,10,13,22,23,24) ELSE n IN (8,9,12,13,14,22,23,24) END
FROM (VALUES('eg'),('sg')) r(region) CROSS JOIN generate_series(0,27) n;
CREATE TABLE ${s}.prepaid_layout_rows (
  revision_id uuid NOT NULL REFERENCES ${s}.prepaid_region_revisions(id), layout_number integer NOT NULL,
  label text NOT NULL, tier integer, editable boolean NOT NULL,
  gp_mt_gross numeric(33,2),hy_mt_gross numeric(33,2),gp_bb_gross numeric(33,2),total_gross numeric(33,2),
  gp_mt_net numeric(33,2),hy_mt_net numeric(33,2),gp_bb_net numeric(33,2),total_net numeric(33,2),
  PRIMARY KEY(revision_id,layout_number)
);
CREATE TABLE ${s}.prepaid_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),revision_id uuid NOT NULL REFERENCES ${s}.prepaid_region_revisions(id),
  actor_id uuid NOT NULL REFERENCES ${s}.app_user(id), reason text NOT NULL,changes jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ${s}.prepaid_allocations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,revision_id uuid NOT NULL REFERENCES ${s}.prepaid_region_revisions(id),
  period text NOT NULL,profit_center text NOT NULL,cost_element text NOT NULL,sub_product text NOT NULL,
  uom text NOT NULL,tax_rate numeric NOT NULL,average_rate numeric NOT NULL,revenue_type text NOT NULL,
  allocation_type text NOT NULL DEFAULT '',variant text NOT NULL CHECK(variant IN ('mt','bb')),
  posting_key integer NOT NULL CHECK(posting_key IN (40,50)), hits numeric,amount numeric,
  denominator numeric,allocation numeric,gross numeric,hits2 numeric NOT NULL,amount2 numeric NOT NULL
);
CREATE INDEX prepaid_allocations_revision ON ${s}.prepaid_allocations(revision_id,variant,id);
CREATE TABLE ${s}.prepaid_validation_results (
  revision_id uuid PRIMARY KEY REFERENCES ${s}.prepaid_region_revisions(id), findings jsonb NOT NULL,
  valid boolean NOT NULL, validated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ${s}.prepaid_reconciliation_rows (
  revision_id uuid NOT NULL REFERENCES ${s}.prepaid_region_revisions(id),revenue_type text NOT NULL,
  allocation_type text NOT NULL,tax_rate numeric NOT NULL,gross numeric,amount numeric NOT NULL,
  tax_amount numeric NOT NULL,total_gross numeric NOT NULL,difference numeric,
  PRIMARY KEY(revision_id,revenue_type,allocation_type,tax_rate)
);
CREATE TABLE ${s}.prepaid_jv_lines (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,revision_id uuid NOT NULL REFERENCES ${s}.prepaid_region_revisions(id),
  posting_key integer NOT NULL CHECK(posting_key IN (40,50)),amount numeric(33,2) NOT NULL CHECK(amount>=0),
  quantity numeric NOT NULL,fields jsonb NOT NULL
);
CREATE TABLE ${s}.prepaid_deliveries (
  id uuid PRIMARY KEY,revision_id uuid NOT NULL UNIQUE REFERENCES ${s}.prepaid_region_revisions(id),
  predecessor_delivery_id uuid REFERENCES ${s}.prepaid_deliveries(id),target text NOT NULL,period text NOT NULL,
  region text NOT NULL, status text NOT NULL CHECK(status IN ('queued','waiting','sending','delivered','failed','unknown','cancelled','reversed')),
  correction boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz
);
CREATE TABLE ${s}.prepaid_delivery_slots (
  target text NOT NULL,period text NOT NULL,region text NOT NULL,run_id uuid NOT NULL REFERENCES ${s}.prepaid_runs(id),
  last_delivery_id uuid REFERENCES ${s}.prepaid_deliveries(id),PRIMARY KEY(target,period,region)
);
CREATE TABLE ${s}.prepaid_exports (
  id uuid PRIMARY KEY,revision_id uuid NOT NULL REFERENCES ${s}.prepaid_region_revisions(id),delivery_id uuid REFERENCES ${s}.prepaid_deliveries(id),
  kind text NOT NULL CHECK(kind IN ('replacement','reversal')),object_key text NOT NULL UNIQUE,
  sha256 text NOT NULL,byte_size bigint NOT NULL,profile text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(delivery_id,kind)
);
CREATE TABLE ${s}.prepaid_jobs (
  id uuid PRIMARY KEY,run_id uuid NOT NULL REFERENCES ${s}.prepaid_runs(id),revision_id uuid REFERENCES ${s}.prepaid_region_revisions(id),
  kind text NOT NULL CHECK(kind IN ('ingest','delivery')),payload jsonb NOT NULL,
  status text NOT NULL CHECK(status IN ('queued','running','waiting','completed','failed','cancelled','unknown')),
  phase text NOT NULL DEFAULT 'initial',execution_arn text,execution_name text NOT NULL UNIQUE,
  lease_token uuid,lease_until timestamptz,available_at timestamptz NOT NULL DEFAULT now(),attempts integer NOT NULL DEFAULT 0,
  error jsonb,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX prepaid_jobs_claim ON ${s}.prepaid_jobs(available_at,lease_until) WHERE status IN ('queued','running','waiting');
CREATE TABLE ${s}.prepaid_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,run_id uuid NOT NULL REFERENCES ${s}.prepaid_runs(id),
  actor_id uuid REFERENCES ${s}.app_user(id),revision_id uuid REFERENCES ${s}.prepaid_region_revisions(id),job_id uuid REFERENCES ${s}.prepaid_jobs(id),
  action text NOT NULL,detail jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX prepaid_events_history ON ${s}.prepaid_events(run_id,id DESC);

CREATE FUNCTION ${s}.prepaid_assert_draft(p_revision uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 PERFORM 1 FROM ${s}.prepaid_region_revisions WHERE id=p_revision AND status='draft' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'PREPAID_DRAFT_REQUIRED' USING ERRCODE='P0001'; END IF;
END $$;
CREATE FUNCTION ${s}.prepaid_initialize_layout(p_revision uuid) RETURNS void LANGUAGE sql AS $$
 INSERT INTO ${s}.prepaid_layout_rows(revision_id,layout_number,label,tier,editable)
 SELECT p_revision,t.layout_number,t.label,t.tier,t.editable FROM ${s}.prepaid_layout_templates t
 JOIN ${s}.prepaid_region_revisions r ON r.id=p_revision AND r.region=t.region;
$$;
CREATE FUNCTION ${s}.prepaid_recompute_layout(p_revision uuid,p_reclass boolean DEFAULT false) RETURNS void LANGUAGE plpgsql AS $$
DECLARE multiplier numeric;
BEGIN
 PERFORM ${s}.prepaid_assert_draft(p_revision);
 SELECT 1+tax_rate INTO multiplier FROM ${s}.prepaid_region_revisions WHERE id=p_revision;
 UPDATE ${s}.prepaid_layout_rows SET gp_mt_gross=round(gp_mt_net*multiplier,2),hy_mt_gross=round(hy_mt_net*multiplier,2),gp_bb_gross=round(gp_bb_net*multiplier,2) WHERE revision_id=p_revision AND tier=1;
 UPDATE ${s}.prepaid_layout_rows SET gp_mt_net=round(gp_mt_gross/multiplier,2),hy_mt_net=round(hy_mt_gross/multiplier,2),gp_bb_net=round(gp_bb_gross/multiplier,2) WHERE revision_id=p_revision AND tier IN(2,4);
 UPDATE ${s}.prepaid_layout_rows SET total_gross=coalesce(gp_mt_gross,0)+coalesce(hy_mt_gross,0)+coalesce(gp_bb_gross,0),total_net=coalesce(gp_mt_net,0)+coalesce(hy_mt_net,0)+coalesce(gp_bb_net,0) WHERE revision_id=p_revision AND tier IS NOT NULL;
 UPDATE ${s}.prepaid_layout_rows l SET gp_mt_gross=x.a,hy_mt_gross=x.b,gp_bb_gross=x.c,total_gross=x.a+x.b+x.c,gp_mt_net=x.d,hy_mt_net=x.e,gp_bb_net=x.f,total_net=x.d+x.e+x.f
 FROM(SELECT CASE tier WHEN 1 THEN 4 ELSE 15 END n, sum(coalesce(gp_mt_gross,0)) a,sum(coalesce(hy_mt_gross,0)) b,sum(coalesce(gp_bb_gross,0)) c,sum(coalesce(gp_mt_net,0)) d,sum(coalesce(hy_mt_net,0)) e,sum(coalesce(gp_bb_net,0)) f FROM ${s}.prepaid_layout_rows WHERE revision_id=p_revision AND tier IN(1,2) GROUP BY tier)x WHERE l.revision_id=p_revision AND l.layout_number=x.n;
 UPDATE ${s}.prepaid_layout_rows l SET gp_mt_gross=x.a,hy_mt_gross=x.b,gp_bb_gross=x.c,total_gross=x.a+x.b+x.c,gp_mt_net=x.d,hy_mt_net=x.e,gp_bb_net=x.f,total_net=x.d+x.e+x.f
 FROM(SELECT sum(gp_mt_gross) a,sum(hy_mt_gross) b,sum(gp_bb_gross) c,sum(gp_mt_net) d,sum(hy_mt_net) e,sum(gp_bb_net) f FROM ${s}.prepaid_layout_rows WHERE revision_id=p_revision AND layout_number IN(4,15))x WHERE l.revision_id=p_revision AND l.layout_number=18;
 IF p_reclass THEN
 UPDATE ${s}.prepaid_layout_rows l SET gp_mt_gross=-x.gp_mt_gross,hy_mt_gross=-x.hy_mt_gross FROM ${s}.prepaid_layout_rows x WHERE l.revision_id=p_revision AND x.revision_id=p_revision AND l.layout_number=22 AND x.layout_number=18;
 UPDATE ${s}.prepaid_layout_rows SET gp_mt_net=round(gp_mt_gross/multiplier,2),hy_mt_net=round(hy_mt_gross/multiplier,2),gp_bb_net=round(gp_bb_gross/multiplier,2),total_gross=coalesce(gp_mt_gross,0)+coalesce(hy_mt_gross,0)+coalesce(gp_bb_gross,0) WHERE revision_id=p_revision AND tier=4;
 UPDATE ${s}.prepaid_layout_rows SET total_net=coalesce(gp_mt_net,0)+coalesce(hy_mt_net,0)+coalesce(gp_bb_net,0) WHERE revision_id=p_revision AND tier=4;
 END IF;
 UPDATE ${s}.prepaid_layout_rows l SET gp_mt_gross=x.a+y.gp_mt_gross,hy_mt_gross=x.b+y.hy_mt_gross,gp_bb_gross=x.c+y.gp_bb_gross,total_gross=x.a+x.b+x.c+y.total_gross,gp_mt_net=x.d+y.gp_mt_net,hy_mt_net=x.e+y.hy_mt_net,gp_bb_net=x.f+y.gp_bb_net,total_net=x.d+x.e+x.f+y.total_net
 FROM(SELECT sum(coalesce(gp_mt_gross,0)) a,sum(coalesce(hy_mt_gross,0)) b,sum(coalesce(gp_bb_gross,0)) c,sum(coalesce(gp_mt_net,0)) d,sum(coalesce(hy_mt_net,0)) e,sum(coalesce(gp_bb_net,0)) f FROM ${s}.prepaid_layout_rows WHERE revision_id=p_revision AND tier=4)x,${s}.prepaid_layout_rows y WHERE l.revision_id=p_revision AND l.layout_number=27 AND y.revision_id=p_revision AND y.layout_number=18;
 DELETE FROM ${s}.prepaid_allocations WHERE revision_id=p_revision;
 DELETE FROM ${s}.prepaid_reconciliation_rows WHERE revision_id=p_revision;
 DELETE FROM ${s}.prepaid_jv_lines WHERE revision_id=p_revision;
 DELETE FROM ${s}.prepaid_validation_results WHERE revision_id=p_revision;
END $$;
CREATE FUNCTION ${s}.prepaid_import_layout(p_revision uuid,p_snapshot uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE rg text;
BEGIN
 PERFORM ${s}.prepaid_assert_draft(p_revision);
 SELECT region INTO rg FROM ${s}.prepaid_region_revisions WHERE id=p_revision;
 IF NOT EXISTS(SELECT 1 FROM ${s}.prepaid_source_snapshots x JOIN ${s}.prepaid_region_revisions r ON r.id=p_revision AND r.run_id=x.run_id WHERE x.id=p_snapshot AND x.status='ready') THEN RAISE EXCEPTION 'PREPAID_SOURCE_NOT_READY'; END IF;
 UPDATE ${s}.prepaid_region_revisions SET source_snapshot_id=p_snapshot,imported=true,version=version+1 WHERE id=p_revision;
 UPDATE ${s}.prepaid_layout_rows SET gp_mt_gross=NULL,hy_mt_gross=NULL,gp_bb_gross=NULL,gp_mt_net=NULL,hy_mt_net=NULL,gp_bb_net=NULL,total_gross=NULL,total_net=NULL WHERE revision_id=p_revision;
 UPDATE ${s}.prepaid_layout_rows SET gp_mt_gross=0,hy_mt_gross=0,gp_bb_gross=0,gp_mt_net=0,hy_mt_net=0,gp_bb_net=0 WHERE revision_id=p_revision AND tier IS NOT NULL;
 UPDATE ${s}.prepaid_layout_rows l SET gp_mt_net=x.a FROM(SELECT CASE cfu WHEN 'EG' THEN 'eg' ELSE 'sg' END region,case WHEN brand='GP' AND revenue_type='MT' THEN 1 WHEN brand='HY' AND revenue_type='MT' THEN 2 WHEN brand='GP' AND revenue_type='NBB' THEN 3 END n,round(sum(amount),2) a FROM ${s}.prepaid_ke24 WHERE snapshot_id=p_snapshot AND cfu IN('EG','SG') GROUP BY cfu,brand,revenue_type)x WHERE l.revision_id=p_revision AND x.region=rg AND l.layout_number=x.n AND x.n IN(1,3);
 UPDATE ${s}.prepaid_layout_rows l SET hy_mt_net=x.a FROM(SELECT round(sum(amount),2) a FROM ${s}.prepaid_ke24 WHERE snapshot_id=p_snapshot AND brand='HY' AND cfu=upper(rg) AND revenue_type='MT')x WHERE l.revision_id=p_revision AND l.layout_number=2;
 UPDATE ${s}.prepaid_layout_rows l SET gp_mt_gross=coalesce(x.a,0) FROM(SELECT round(sum((data->>'amount')::numeric),2) a FROM ${s}.prepaid_stage_loadup WHERE snapshot_id=p_snapshot AND data->>'region'=rg)x WHERE l.revision_id=p_revision AND l.label='LOAD UP';
 UPDATE ${s}.prepaid_layout_rows l SET gp_mt_gross=coalesce(x.a,0) FROM(SELECT round(sum((data->>'amount')::numeric),2) a FROM ${s}.prepaid_stage_loadapi WHERE snapshot_id=p_snapshot AND data->>'region'=rg)x WHERE l.revision_id=p_revision AND l.label='LOAD/REWARDS API';
 UPDATE ${s}.prepaid_layout_rows l SET hy_mt_gross=coalesce(x.a,0) FROM(SELECT round(sum((data->>'amount')::numeric),2) a FROM ${s}.prepaid_stage_recharge WHERE snapshot_id=p_snapshot AND upper(data->>'customer_type')=CASE rg WHEN 'eg' THEN 'E' ELSE 'S' END AND upper(data->>'method')='PS' AND upper(data->>'channel')='RP')x WHERE l.revision_id=p_revision AND l.label='RECHARGE INSTRUCTION (recharge report)';
 UPDATE ${s}.prepaid_layout_rows l SET hy_mt_gross=x.a FROM(SELECT coalesce((SELECT round(sum((data->>'amount')::numeric),2) FROM ${s}.prepaid_stage_adjustments WHERE snapshot_id=p_snapshot AND upper(data->>'code')='AMAXCEP' AND upper(data->>'customer_type')=CASE rg WHEN 'eg' THEN 'E' ELSE 'S' END),0)+coalesce((SELECT round(sum((data->>'amount')::numeric),2) FROM ${s}.prepaid_stage_charges WHERE snapshot_id=p_snapshot AND upper(data->>'code')='AMAXCEP' AND upper(data->>'customer_type')=CASE rg WHEN 'eg' THEN 'E' ELSE 'S' END),0) a)x WHERE l.revision_id=p_revision AND l.label='AMAXCE';
 UPDATE ${s}.prepaid_layout_rows l SET gp_mt_gross=coalesce(x.a,0) FROM(SELECT sum(round((data->>'amount')::numeric,0)) a FROM ${s}.prepaid_stage_callcard WHERE snapshot_id=p_snapshot AND data->>'region'='eg')x WHERE l.revision_id=p_revision AND rg='eg' AND l.label='CALLCARD';
 UPDATE ${s}.prepaid_layout_rows l SET gp_mt_gross=coalesce(x.a,0) FROM(SELECT data->>'kind' kind,round(sum((data->>'amount')::numeric),2) a FROM ${s}.prepaid_stage_callcard WHERE snapshot_id=p_snapshot AND data->>'region'='sg' GROUP BY data->>'kind')x WHERE l.revision_id=p_revision AND rg='sg' AND l.label=CASE x.kind WHEN 'trade' THEN 'Callcard sales - Trade' ELSE 'Callcard sales - internal' END;
 PERFORM ${s}.prepaid_recompute_layout(p_revision,true);
END $$;
CREATE FUNCTION ${s}.prepaid_save_layout_cells(p_revision uuid,p_actor uuid,p_reason text,p_changes jsonb) RETURNS void LANGUAGE plpgsql AS $$
DECLARE change jsonb; old_value numeric; audit_changes jsonb := '[]';
BEGIN
 PERFORM ${s}.prepaid_assert_draft(p_revision);
 IF NOT EXISTS(SELECT 1 FROM ${s}.prepaid_region_revisions WHERE id=p_revision AND imported) THEN RAISE EXCEPTION 'PREPAID_IMPORT_REQUIRED'; END IF;
 IF length(trim(p_reason))=0 OR jsonb_array_length(p_changes)=0 THEN RAISE EXCEPTION 'PREPAID_CHANGE_REASON_REQUIRED'; END IF;
 FOR change IN SELECT value FROM jsonb_array_elements(p_changes) LOOP
  IF change->>'field' NOT IN('gp_mt_gross','hy_mt_gross','gp_bb_gross') OR NOT EXISTS(SELECT 1 FROM ${s}.prepaid_layout_rows WHERE revision_id=p_revision AND layout_number=(change->>'layoutNumber')::int AND editable) THEN RAISE EXCEPTION 'PREPAID_CELL_READ_ONLY'; END IF;
  EXECUTE format('SELECT %I FROM ${s}.prepaid_layout_rows WHERE revision_id=$1 AND layout_number=$2',change->>'field') INTO old_value USING p_revision,(change->>'layoutNumber')::int;
  EXECUTE format('UPDATE ${s}.prepaid_layout_rows SET %I=$1 WHERE revision_id=$2 AND layout_number=$3',change->>'field') USING (change->>'value')::numeric,p_revision,(change->>'layoutNumber')::int;
  audit_changes := audit_changes || jsonb_build_array(change || jsonb_build_object('previous',old_value::text));
 END LOOP;
 INSERT INTO ${s}.prepaid_adjustments(revision_id,actor_id,reason,changes) VALUES(p_revision,p_actor,p_reason,audit_changes);
 UPDATE ${s}.prepaid_region_revisions SET version=version+1 WHERE id=p_revision;
 PERFORM ${s}.prepaid_recompute_layout(p_revision);
END $$;
CREATE FUNCTION ${s}.prepaid_reset_layout(p_revision uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 PERFORM ${s}.prepaid_assert_draft(p_revision);
 UPDATE ${s}.prepaid_region_revisions SET imported=false,version=version+1 WHERE id=p_revision;
 UPDATE ${s}.prepaid_layout_rows SET gp_mt_gross=NULL,hy_mt_gross=NULL,gp_bb_gross=NULL,gp_mt_net=NULL,hy_mt_net=NULL,gp_bb_net=NULL,total_gross=NULL,total_net=NULL WHERE revision_id=p_revision;
 DELETE FROM ${s}.prepaid_allocations WHERE revision_id=p_revision;
 DELETE FROM ${s}.prepaid_reconciliation_rows WHERE revision_id=p_revision;
 DELETE FROM ${s}.prepaid_jv_lines WHERE revision_id=p_revision;
 DELETE FROM ${s}.prepaid_validation_results WHERE revision_id=p_revision;
END $$;
CREATE VIEW ${s}.prepaid_allocation_mapping AS SELECT * FROM (VALUES
 ('GP_EG_MT','GP_CM_MT'),('HY_EG_MT','GP_CM_MT'),('GP_EG_BB','GP_CB_BB'),('GP_EG_BB','GP_SG_BB'),('GP_EG_BB','GP_CB_BB_8'),('GP_EG_BB','GP_SG_BB_8'),
 ('GP_SG_MT','GP_CM_MT'),('HY_SG_MT','GP_CM_MT'),('GP_SG_BB','GP_CB_BB'),('GP_SG_BB','GP_SG_MT')) t(revenue_type,allocation_type);
CREATE VIEW ${s}.prepaid_reference_expanded AS
 SELECT snapshot_id,cost_element,brand,cfu,revenue_type,sub_product,tax_rate,average_rate,uom,0 priority FROM ${s}.prepaid_reference
 UNION ALL SELECT snapshot_id,cost_element,brand,CASE cfu WHEN 'CB' THEN 'SG' ELSE 'CB' END,'BB',sub_product,tax_rate,average_rate,uom,1 FROM ${s}.prepaid_reference WHERE brand='GP' AND cfu IN('CB','SG') AND revenue_type='BB'
 UNION ALL SELECT snapshot_id,cost_element,brand,'SG','MT',sub_product,tax_rate,average_rate,uom,1 FROM ${s}.prepaid_reference WHERE brand='GP' AND cfu IN('CB','SG') AND revenue_type='BB'
 UNION ALL SELECT snapshot_id,cost_element,brand,c.target,'BB',sub_product,tax_rate,average_rate,uom,1 FROM ${s}.prepaid_reference CROSS JOIN(VALUES('CB'),('SG'))c(target) WHERE brand='GP' AND cfu='SG' AND revenue_type='MT';
CREATE FUNCTION ${s}.prepaid_build_outputs(p_revision uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE snap uuid; rg text; per text; findings jsonb:='[]'; missing_count int; debit numeric; credit numeric; variance numeric; dt text; label_month text;
BEGIN
 PERFORM ${s}.prepaid_assert_draft(p_revision);
 SELECT r.source_snapshot_id,r.region,x.period INTO snap,rg,per FROM ${s}.prepaid_region_revisions r JOIN ${s}.prepaid_runs x ON x.id=r.run_id WHERE r.id=p_revision AND r.imported;
 IF snap IS NULL THEN RAISE EXCEPTION 'PREPAID_IMPORT_REQUIRED'; END IF;
 DELETE FROM ${s}.prepaid_allocations WHERE revision_id=p_revision;
 DELETE FROM ${s}.prepaid_reconciliation_rows WHERE revision_id=p_revision;
 DELETE FROM ${s}.prepaid_jv_lines WHERE revision_id=p_revision;
 SELECT count(*) INTO missing_count FROM ${s}.prepaid_ke24 k JOIN ${s}.prepaid_allocation_mapping m ON m.allocation_type=k.brand||'_'||k.cfu||'_'||k.revenue_type||CASE WHEN k.brand||'_'||k.cfu||'_'||k.revenue_type IN('GP_CB_BB','GP_SG_MT') AND left(k.reference_document,1)='8' THEN '_8' ELSE '' END
 WHERE k.snapshot_id=snap AND split_part(m.revenue_type,'_',2)=upper(rg) AND NOT EXISTS(SELECT 1 FROM ${s}.prepaid_reference_expanded r WHERE r.snapshot_id=snap AND r.cost_element=k.cost_element AND r.brand=k.brand AND r.cfu=k.cfu AND r.revenue_type=k.revenue_type AND r.sub_product=k.sub_product);
 IF missing_count>0 THEN findings:=findings||jsonb_build_array(jsonb_build_object('code','REFERENCE_MAPPING_MISSING','count',missing_count)); END IF;
 IF EXISTS(SELECT 1 FROM ${s}.prepaid_reference_expanded r WHERE r.snapshot_id=snap AND NOT EXISTS(SELECT 1 FROM ${s}.prepaid_reference_expanded direct WHERE direct.snapshot_id=r.snapshot_id AND direct.cost_element=r.cost_element AND direct.brand=r.brand AND direct.cfu=r.cfu AND direct.revenue_type=r.revenue_type AND direct.sub_product=r.sub_product AND direct.priority<r.priority) GROUP BY snapshot_id,cost_element,brand,cfu,revenue_type,sub_product,priority HAVING count(DISTINCT(tax_rate,average_rate,uom))>1) THEN findings:=findings||'[ {"code":"REFERENCE_MAPPING_AMBIGUOUS"} ]'::jsonb; END IF;
 INSERT INTO ${s}.prepaid_allocations(revision_id,period,profit_center,cost_element,sub_product,uom,tax_rate,average_rate,revenue_type,variant,posting_key,hits,amount,denominator,allocation,gross,hits2,amount2)
 WITH grouped AS(
 SELECT k.period,k.profit_center,k.cost_element,k.sub_product,k.uom source_uom,k.brand,k.cfu,k.revenue_type original_type,m.revenue_type,
 sum(k.quantity) hits,sum(k.amount) amount FROM ${s}.prepaid_ke24 k JOIN ${s}.prepaid_allocation_mapping m
 ON m.allocation_type=k.brand||'_'||k.cfu||'_'||k.revenue_type||CASE WHEN k.brand||'_'||k.cfu||'_'||k.revenue_type IN('GP_CB_BB','GP_SG_MT') AND left(k.reference_document,1)='8' THEN '_8' ELSE '' END
 WHERE k.snapshot_id=snap AND split_part(m.revenue_type,'_',2)=upper(rg)
 GROUP BY k.period,k.profit_center,k.cost_element,k.sub_product,k.uom,k.brand,k.cfu,k.revenue_type,m.revenue_type),
 denominators AS(SELECT *,sum(amount) OVER(PARTITION BY period,revenue_type) denominator FROM grouped),
 referenced AS(SELECT d.*,ref.tax_rate,ref.average_rate,ref.uom,CASE WHEN denominator=0 THEN NULL WHEN amount/denominator<.00001 THEN 0 ELSE amount/denominator END allocation,
 CASE split_part(d.revenue_type,'_',1)||'_'||split_part(d.revenue_type,'_',3) WHEN 'HY_MT' THEN l.hy_mt_gross WHEN 'GP_MT' THEN l.gp_mt_gross ELSE l.gp_bb_gross END gross
 FROM denominators d JOIN ${s}.prepaid_layout_rows l ON l.revision_id=p_revision AND l.layout_number=18
 JOIN LATERAL(SELECT r.tax_rate,r.average_rate,r.uom FROM ${s}.prepaid_reference_expanded r WHERE r.snapshot_id=snap AND r.cost_element=d.cost_element AND r.brand=d.brand AND r.cfu=d.cfu AND r.revenue_type=d.original_type AND r.sub_product=d.sub_product ORDER BY priority,tax_rate,average_rate,uom LIMIT 1)ref ON true),
 amounts AS(SELECT *,round(gross*allocation/(1+tax_rate),2) amount2,round(coalesce(gross*allocation/(1+tax_rate)/nullif(average_rate,0),0),0) hits2 FROM referenced)
 SELECT p_revision,period,profit_center,cost_element,sub_product,uom,tax_rate,average_rate,revenue_type,lower(split_part(revenue_type,'_',3)),CASE WHEN amount2<0 THEN 40 ELSE 50 END,hits,amount,denominator,allocation,gross,hits2,amount2 FROM amounts WHERE amount2 IS NOT NULL;
 IF EXISTS(SELECT 1 FROM ${s}.prepaid_allocations WHERE revision_id=p_revision AND average_rate=0 AND amount2<>0) THEN findings:=findings||'[{"code":"AVERAGE_RATE_ZERO"}]'::jsonb; END IF;
 -- Prevent missing/zero-denominator bases from disappearing behind an empty output.
 IF EXISTS(SELECT 1 FROM ${s}.prepaid_layout_rows l CROSS JOIN LATERAL(VALUES('GP_'||upper(rg)||'_MT',l.gp_mt_gross),('HY_'||upper(rg)||'_MT',l.hy_mt_gross),('GP_'||upper(rg)||'_BB',l.gp_bb_gross)) v(revenue_type,gross) WHERE l.revision_id=p_revision AND l.layout_number=18 AND v.gross<>0 AND NOT EXISTS(SELECT 1 FROM ${s}.prepaid_allocations a WHERE a.revision_id=p_revision AND a.revenue_type=v.revenue_type)) THEN findings:=findings||'[{"code":"ALLOCATION_BASE_MISSING_OR_ZERO"}]'::jsonb; END IF;
 INSERT INTO ${s}.prepaid_allocations(revision_id,period,profit_center,cost_element,sub_product,uom,tax_rate,average_rate,revenue_type,allocation_type,variant,posting_key,hits2,amount2)
 SELECT p_revision,a.period,a.profit_center,a.cost_element,a.sub_product,a.uom,a.tax_rate,a.average_rate,'',m.allocation_type,a.variant,
 CASE WHEN sum(a.amount2*split.factor)<0 THEN 50 ELSE 40 END,round(sum(a.hits2*split.factor),0),sum(a.amount2*split.factor)
 FROM ${s}.prepaid_allocations a JOIN ${s}.prepaid_allocation_mapping m ON m.revenue_type=a.revenue_type AND right(m.allocation_type,2)<>'_8'
 JOIN ${s}.prepaid_layout_rows l ON l.revision_id=p_revision AND l.label=m.allocation_type
 CROSS JOIN LATERAL(SELECT CASE WHEN a.variant='mt' THEN 1 WHEN a.gross=0 THEN 0 ELSE coalesce(-l.gp_bb_gross/a.gross,0) END factor)split
 WHERE a.revision_id=p_revision AND a.allocation_type=''
 GROUP BY a.period,a.profit_center,a.cost_element,a.sub_product,a.uom,a.tax_rate,a.average_rate,m.allocation_type,a.variant;
 INSERT INTO ${s}.prepaid_reconciliation_rows SELECT p_revision,revenue_type,allocation_type,tax_rate,max(gross),sum(amount2),sum(amount2)*tax_rate,sum(amount2)*(1+tax_rate),CASE WHEN allocation_type='' THEN max(gross)-sum(amount2)*(1+tax_rate) ELSE NULL END FROM ${s}.prepaid_allocations WHERE revision_id=p_revision GROUP BY revenue_type,allocation_type,tax_rate;
 IF EXISTS(SELECT 1 FROM ${s}.prepaid_allocations WHERE revision_id=p_revision AND allocation_type='' GROUP BY revenue_type HAVING round(max(gross)-sum(amount2*(1+tax_rate)),2)<>0) THEN findings:=findings||'[{"code":"RECONCILIATION_DIFFERENCE"}]'::jsonb; END IF;
 SELECT total_gross INTO variance FROM ${s}.prepaid_layout_rows WHERE revision_id=p_revision AND layout_number=27;
 IF variance IS NULL OR variance<>0 THEN findings:=findings||jsonb_build_array(jsonb_build_object('code','LAYOUT_VARIANCE','amount',variance::text)); END IF;
 dt:=to_char((per||'-01')::date+interval '1 month - 1 day','MM/DD/YYYY'); label_month:=to_char((per||'-01')::date,'MM/YY');
 INSERT INTO ${s}.prepaid_jv_lines(revision_id,posting_key,amount,quantity,fields)
 SELECT p_revision,posting_key,abs(round(amount2,2)),abs(hits2),jsonb_build_object(
 'Batch Number','1','Doc Date',dt,'Posting Date',dt,'DocType','SA','Company Code','GLOB','Currency','PHP','Date',dt,'Fiscal Period',substring(per,6,2),
 'Reference Document Number','TOP-UP','Text',label_month||' '||upper(rg)||' REVS','Posting Key',posting_key::text,'Special G/L indicator','',
 'Account or Matchcode for theNext Line Item',cost_element,'Reconciliation G/L account','','Amount in local currency',abs(round(amount2,2))::text,
 'Tax on Sales/Purchases Code','','I/O Number','','Cost center','','Profit center',profit_center,'Pegging flag','',
 'Text2',label_month||' '||upper(rg)||' PREPAID REVS','exchange rate','','trading partner','','Partner profit center','','Quantity',abs(hits2)::text,'UOM',uom,
 'BRAND',split_part(CASE WHEN allocation_type='' THEN revenue_type ELSE allocation_type END,'_',1),
 'CFU',split_part(CASE WHEN allocation_type='' THEN revenue_type ELSE allocation_type END,'_',2),'sub-product -B',sub_product,
 'Franchise Area','','Business Centre','','Revenue/Sales Type',split_part(CASE WHEN allocation_type='' THEN revenue_type ELSE allocation_type END,'_',3),
 'Event/Segment','','Payment Term','','Payment Method','','MVNO PARTNER','','TECHNOLOGY','','PLAN TYPE','','CORE PRODUCT','','REVENUE ITEM CODE','')
 FROM ${s}.prepaid_allocations WHERE revision_id=p_revision AND abs(amount2)>=.01 ORDER BY profit_center,cost_element,sub_product,revenue_type,allocation_type,tax_rate,uom;
 SELECT coalesce(sum(amount) FILTER(WHERE posting_key=40),0),coalesce(sum(amount) FILTER(WHERE posting_key=50),0) INTO debit,credit FROM ${s}.prepaid_jv_lines WHERE revision_id=p_revision;
 IF debit<>credit THEN findings:=findings||jsonb_build_array(jsonb_build_object('code','JV_NOT_BALANCED','debit',debit::text,'credit',credit::text)); END IF;
 INSERT INTO ${s}.prepaid_validation_results VALUES(p_revision,findings,jsonb_array_length(findings)=0,now()) ON CONFLICT(revision_id) DO UPDATE SET findings=excluded.findings,valid=excluded.valid,validated_at=now();
END $$;
CREATE FUNCTION ${s}.prepaid_freeze_layout(p_revision uuid,p_actor uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 PERFORM ${s}.prepaid_build_outputs(p_revision);
 IF NOT EXISTS(SELECT 1 FROM ${s}.prepaid_validation_results WHERE revision_id=p_revision AND valid) THEN RAISE EXCEPTION 'PREPAID_VALIDATION_FAILED'; END IF;
 UPDATE ${s}.prepaid_region_revisions SET status='frozen',version=version+1,frozen_at=now(),frozen_by=p_actor WHERE id=p_revision;
END $$;
CREATE FUNCTION ${s}.prepaid_reversal_lines(p_revision uuid) RETURNS SETOF jsonb LANGUAGE sql STABLE AS $$
 SELECT fields||jsonb_build_object('Posting Key',CASE posting_key WHEN 40 THEN '50' ELSE '40' END,'Text',fields->>'Text'||' REVERSAL','Text2',fields->>'Text2'||' REVERSAL') FROM ${s}.prepaid_jv_lines WHERE revision_id=p_revision ORDER BY id;
$$;
CREATE FUNCTION ${s}.prepaid_guard_frozen_rows() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rid uuid;
BEGIN
 rid:=CASE WHEN TG_OP='DELETE' THEN OLD.revision_id ELSE NEW.revision_id END;
 IF EXISTS(SELECT 1 FROM ${s}.prepaid_region_revisions WHERE id=rid AND status<>'draft') THEN RAISE EXCEPTION 'PREPAID_FROZEN_IMMUTABLE'; END IF;
 IF TG_OP='UPDATE' AND OLD.revision_id<>NEW.revision_id THEN RAISE EXCEPTION 'PREPAID_REVISION_IMMUTABLE'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
${["layout_rows", "allocations", "reconciliation_rows", "jv_lines", "validation_results", "adjustments"].map((t) => `CREATE TRIGGER prepaid_frozen_guard BEFORE INSERT OR UPDATE OR DELETE ON ${s}.prepaid_${t} FOR EACH ROW EXECUTE FUNCTION ${s}.prepaid_guard_frozen_rows();`).join("\n")}
CREATE FUNCTION ${s}.prepaid_guard_ready_staging() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sid uuid;
BEGIN
 sid:=CASE WHEN TG_OP='DELETE' THEN OLD.snapshot_id ELSE NEW.snapshot_id END;
 IF NOT EXISTS(SELECT 1 FROM ${s}.prepaid_source_snapshots WHERE id=sid AND status='pending') THEN RAISE EXCEPTION 'PREPAID_SNAPSHOT_IMMUTABLE'; END IF;
 IF TG_OP='UPDATE' AND OLD.snapshot_id<>NEW.snapshot_id THEN RAISE EXCEPTION 'PREPAID_SNAPSHOT_IMMUTABLE'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
${tables.map((t) => `CREATE TRIGGER prepaid_snapshot_guard BEFORE INSERT OR UPDATE OR DELETE ON ${s}.prepaid_stage_${t} FOR EACH ROW EXECUTE FUNCTION ${s}.prepaid_guard_ready_staging();`).join("\n")}
CREATE FUNCTION ${s}.prepaid_guard_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status<>'draft' THEN RAISE EXCEPTION 'PREPAID_FROZEN_IMMUTABLE'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER prepaid_revision_guard BEFORE UPDATE OR DELETE ON ${s}.prepaid_region_revisions FOR EACH ROW EXECUTE FUNCTION ${s}.prepaid_guard_revision();
CREATE FUNCTION ${s}.prepaid_guard_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status='ready' THEN RAISE EXCEPTION 'PREPAID_SNAPSHOT_IMMUTABLE'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER prepaid_ready_guard BEFORE UPDATE OR DELETE ON ${s}.prepaid_source_snapshots FOR EACH ROW EXECUTE FUNCTION ${s}.prepaid_guard_snapshot();
CREATE FUNCTION ${s}.prepaid_guard_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'PREPAID_AUDIT_APPEND_ONLY'; END $$;
CREATE TRIGGER prepaid_event_guard BEFORE UPDATE OR DELETE ON ${s}.prepaid_events FOR EACH ROW EXECUTE FUNCTION ${s}.prepaid_guard_audit();
CREATE TRIGGER prepaid_adjustment_guard BEFORE UPDATE OR DELETE ON ${s}.prepaid_adjustments FOR EACH ROW EXECUTE FUNCTION ${s}.prepaid_guard_audit();
`;
}
