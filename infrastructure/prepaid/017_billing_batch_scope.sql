-- Snapshot of the four SQL definitions included by apply_billing_batch_scope.sql.

-- Limit billing reads only inside a scoped import transaction.
CREATE OR REPLACE FUNCTION dswtdir1_prepaid_dbo.prepaid_billing_row_matches(
    p_filename text, p_read_at timestamp without time zone
) RETURNS boolean
LANGUAGE sql STABLE AS $body$
    SELECT CASE WHEN scope IS NULL THEN true ELSE
        p_read_at >= (scope->>'started_at')::timestamp
        AND (scope->'filenames') ? lower(split_part(p_filename, ' - ', 1))
    END
    FROM (SELECT nullif(current_setting('esatp.prepaid_billing_scope', true), '')::jsonb AS scope) AS context;
$body$;
ALTER FUNCTION dswtdir1_prepaid_dbo.prepaid_billing_row_matches(text, timestamp without time zone) OWNER TO esatp_adm;

CREATE OR REPLACE FUNCTION dswtdir1_prepaid_dbo.prepaid_import_source_enabled(p_source text)
RETURNS boolean LANGUAGE sql STABLE AS $body$
    SELECT coalesce(nullif(current_setting('esatp.prepaid_billing_scope', true), '')::jsonb->'workflows' ? p_source, true);
$body$;
ALTER FUNCTION dswtdir1_prepaid_dbo.prepaid_import_source_enabled(text) OWNER TO esatp_adm;

-- Derive scope from the portal run that owns this import. Glue passes the
-- execution name via the shared caller's CODE/BYPASS argument.
CREATE OR REPLACE PROCEDURE dswtdir1_prepaid_dbo.prepaid_scope_billing_import(p_execution_name varchar)
LANGUAGE plpgsql AS $body$
DECLARE
    v_batch_id uuid;
    v_files jsonb;
    v_started_at timestamp without time zone;
    v_billing_files jsonb;
    v_missing text;
BEGIN
    IF p_execution_name IS NULL OR p_execution_name !~
        '^portal-prepaid-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-import$'
    THEN
        RAISE EXCEPTION 'Expected a portal Prepaid import execution name';
    END IF;
    v_batch_id := substring(p_execution_name FROM 16 FOR 36)::uuid;

    SELECT files, (executions->'import'->>'startedAt')::timestamptz AT TIME ZONE 'UTC'
      INTO v_files, v_started_at
    FROM web_portal.prepaid_full_batches
    WHERE id = v_batch_id AND inputs_staged AND phase = 'import' AND status = 'running'
      AND split_part(executions->'import'->>'arn', ':', 8) = p_execution_name;
    IF v_started_at IS NULL THEN
        RAISE EXCEPTION 'No active Prepaid batch matches %', p_execution_name;
    END IF;

    SELECT coalesce(jsonb_agg(file), '[]'::jsonb)
      INTO v_billing_files
    FROM jsonb_array_elements(v_files) AS file
    WHERE file->>'workflow' IN ('adjustments_308', 'charges_318');

    WITH current_headers AS (
        SELECT '308' AS report, lower(split_part(filename, ' - ', 1)) AS filename,
               ltrim(btrim(column2), '0') AS cycle
        FROM sdbtdir1_prepaid_dbo.billed_adjustments_header_cycles
        WHERE dateread >= v_started_at AND column1 ILIKE 'Cycle%Code:%'
        UNION ALL
        SELECT '318', lower(split_part(filename, ' - ', 1)), ltrim(btrim(column2), '0')
        FROM sdbtdir1_prepaid_dbo.billed_charges_header_cycles
        WHERE dateread >= v_started_at AND column1 ILIKE 'Cycle%Code:%'
    )
    SELECT string_agg(file->>'code', ', ' ORDER BY file->>'code')
      INTO v_missing
    FROM jsonb_array_elements(v_billing_files) AS file
    WHERE NOT EXISTS (
        SELECT FROM current_headers h
        WHERE h.report = split_part(file->>'code', '_', 1)
          AND h.filename = lower(file->>'name')
          AND h.cycle = ltrim(split_part(file->>'code', '_', 2), '0')
    );
    IF v_missing IS NOT NULL THEN
        RAISE EXCEPTION 'Missing fresh Prepaid billing headers or mismatched report cycles: %', v_missing;
    END IF;

    PERFORM set_config('esatp.prepaid_billing_scope', jsonb_build_object(
        'started_at', v_started_at,
        'filenames', (SELECT coalesce(jsonb_agg(lower(file->>'name')), '[]'::jsonb) FROM jsonb_array_elements(v_billing_files) AS file),
        'workflows', (SELECT jsonb_agg(DISTINCT file->>'workflow') FROM jsonb_array_elements(v_files) AS file)
    )::text, true);
END;
$body$;
ALTER PROCEDURE dswtdir1_prepaid_dbo.prepaid_scope_billing_import(varchar) OWNER TO esatp_adm;

CREATE OR REPLACE PROCEDURE dswtdir1_prepaid_dbo.sp_prepaid1_eglayout_import_pgx(IN par_cyclecode varchar)
LANGUAGE plpgsql AS $body$
BEGIN
    CALL dswtdir1_prepaid_dbo.prepaid_scope_billing_import(par_cyclecode);
    IF NOT dswtdir1_prepaid_dbo.prepaid_import_source_enabled('ke24')
       OR jsonb_array_length(current_setting('esatp.prepaid_billing_scope')::jsonb->'workflows') < 10 THEN
        CALL dswtdir1_prepaid_dbo.sp_prepaid1_eglayout_resetlayout_pgx();
    END IF;
    CALL dswtdir1_prepaid_dbo.sp_prepaid1_eglayout_import_pgx();
    PERFORM set_config('esatp.prepaid_billing_scope', '', true);
END;
$body$;
ALTER PROCEDURE dswtdir1_prepaid_dbo.sp_prepaid1_eglayout_import_pgx(varchar) OWNER TO esatp_adm;

CREATE OR REPLACE PROCEDURE dswtdir1_prepaid_dbo.sp_prepaid1_sglayout_import_pgx(IN par_cyclecode varchar)
LANGUAGE plpgsql AS $body$
BEGIN
    CALL dswtdir1_prepaid_dbo.prepaid_scope_billing_import(par_cyclecode);
    IF NOT dswtdir1_prepaid_dbo.prepaid_import_source_enabled('ke24')
       OR jsonb_array_length(current_setting('esatp.prepaid_billing_scope')::jsonb->'workflows') < 10 THEN
        CALL dswtdir1_prepaid_dbo.sp_prepaid1_sglayout_resetlayout_pgx();
    END IF;
    CALL dswtdir1_prepaid_dbo.sp_prepaid1_sglayout_import_pgx();
    PERFORM set_config('esatp.prepaid_billing_scope', '', true);
END;
$body$;
ALTER PROCEDURE dswtdir1_prepaid_dbo.sp_prepaid1_sglayout_import_pgx(varchar) OWNER TO esatp_adm;

-- The billing reader may store the uploaded basename followed by ' - ' and its
-- generated workbook name. Match the uploaded basename case-insensitively, and
-- retain the legacy assignments for BC01, BC06, BC10, BC11, BC13, BC16,
-- BC18, BC21, BC24 and BC27. Both header and detail views use the same rule.
CREATE OR REPLACE VIEW sdbtdir1_prepaid_dbo.billed_adjustments_header_cycle_ssis AS
SELECT
        CASE lower(split_part(filename, ' - ', 1))
            WHEN '308. billed adjustments monthly summary report_g_bc01.xlsx' THEN 1
            WHEN '308. billed adjustments monthly summary report_g_bc06.xlsx' THEN 2
            WHEN '308. billed adjustments monthly summary report_g_bc10.xlsx' THEN 3
            WHEN '308. billed adjustments monthly summary report_g_bc11.xlsx' THEN 4
            WHEN '308. billed adjustments monthly summary report_g_bc13.xlsx' THEN 5
            WHEN '308. billed adjustments monthly summary report_g_bc16.xlsx' THEN 6
            WHEN '308. billed adjustments monthly summary report_g_bc18.xlsx' THEN 7
            WHEN '308. billed adjustments monthly summary report_g_bc21.xlsx' THEN 8
            WHEN '308. billed adjustments monthly summary report_g_bc24.xlsx' THEN 9
            WHEN '308. billed adjustments monthly summary report_g_bc27.xlsx' THEN 10
            ELSE 0
        END AS cyclenumber,
    max(
        CASE
            WHEN lower(column1::text) ~~ lower('Cycle%Code:%'::text) THEN column2
            ELSE NULL::character varying
        END::text) AS cycle_code,
    max(
        CASE
            WHEN lower(column1::text) ~~ lower('Cycle%Year:%'::text) THEN column2
            ELSE NULL::character varying
        END::text) AS cycle_year,
    max(
        CASE
            WHEN lower(column1::text) ~~ lower('Cycle%Instance:%'::text) THEN column2
            ELSE NULL::character varying
        END::text) AS cycle_instance
   FROM sdbtdir1_prepaid_dbo.billed_adjustments_header_cycles x
  WHERE lower(column1::text) ~~ lower('Cycle%'::text)
    AND dswtdir1_prepaid_dbo.prepaid_billing_row_matches(filename, dateread)
  GROUP BY filename;

CREATE OR REPLACE VIEW sdbtdir1_prepaid_dbo.billed_adjustments_lineitem_cycle_ssis AS
SELECT "Customer Type",
    "Customer Sub Type",
    "Subscriber Type",
    "Adjustment Type",
    "Adjustment Code",
    "Adjustment Reason",
    "Legal Entity",
    currency,
    amount,
    "Write-Off Activity Indicator",
        CASE lower(split_part(filename, ' - ', 1))
            WHEN '308. billed adjustments monthly summary report_g_bc01.xlsx' THEN 1
            WHEN '308. billed adjustments monthly summary report_g_bc06.xlsx' THEN 2
            WHEN '308. billed adjustments monthly summary report_g_bc10.xlsx' THEN 3
            WHEN '308. billed adjustments monthly summary report_g_bc11.xlsx' THEN 4
            WHEN '308. billed adjustments monthly summary report_g_bc13.xlsx' THEN 5
            WHEN '308. billed adjustments monthly summary report_g_bc16.xlsx' THEN 6
            WHEN '308. billed adjustments monthly summary report_g_bc18.xlsx' THEN 7
            WHEN '308. billed adjustments monthly summary report_g_bc21.xlsx' THEN 8
            WHEN '308. billed adjustments monthly summary report_g_bc24.xlsx' THEN 9
            WHEN '308. billed adjustments monthly summary report_g_bc27.xlsx' THEN 10
            ELSE 0
        END AS cyclenumber
   FROM sdbtdir1_prepaid_dbo.billed_adjustments_lineitem_cycles
  WHERE lower("Customer Type"::text) !~~ lower('Report%Creator%Amdocs%BI%Team%'::text)
    AND dswtdir1_prepaid_dbo.prepaid_billing_row_matches(filename, dateread);

CREATE OR REPLACE VIEW sdbtdir1_prepaid_dbo.billed_charges_header_cycle_ssis AS
SELECT
        CASE lower(split_part(filename, ' - ', 1))
            WHEN '318. billed charges summary report_g_bc01.xlsx' THEN 1
            WHEN '318. billed charges summary report_g_bc06.xlsx' THEN 2
            WHEN '318. billed charges summary report_g_bc10.xlsx' THEN 3
            WHEN '318. billed charges summary report_g_bc11.xlsx' THEN 4
            WHEN '318. billed charges summary report_g_bc13.xlsx' THEN 5
            WHEN '318. billed charges summary report_g_bc16.xlsx' THEN 6
            WHEN '318. billed charges summary report_g_bc18.xlsx' THEN 7
            WHEN '318. billed charges summary report_g_bc21.xlsx' THEN 8
            WHEN '318. billed charges summary report_g_bc24.xlsx' THEN 9
            WHEN '318. billed charges summary report_g_bc27.xlsx' THEN 10
            ELSE 0
        END AS cyclenumber,
    max(
        CASE
            WHEN lower(column1::text) ~~ lower('Cycle%Code:%'::text) THEN column2
            ELSE NULL::character varying
        END::text) AS cycle_code,
    max(
        CASE
            WHEN lower(column1::text) ~~ lower('Cycle%Year:%'::text) THEN column2
            ELSE NULL::character varying
        END::text) AS cycle_year,
    max(
        CASE
            WHEN lower(column1::text) ~~ lower('Cycle%Instance:%'::text) THEN column2
            ELSE NULL::character varying
        END::text) AS cycle_instance
   FROM sdbtdir1_prepaid_dbo.billed_charges_header_cycles x
  WHERE lower(column1::text) ~~ lower('Cycle%'::text)
    AND dswtdir1_prepaid_dbo.prepaid_billing_row_matches(filename, dateread)
  GROUP BY filename;

CREATE OR REPLACE VIEW sdbtdir1_prepaid_dbo.billed_charges_lineitem_cycle_ssis AS
SELECT "Customer Type",
    "Customer SubType",
    "Subscriber Type",
    "Revenue Type",
    "Charge Code/Tax Code",
    "Charge Type/Tax Type",
    "Discount Plan Code",
    "Total Amount",
    "Document Demand Type",
    "Legal Entity",
    currency,
        CASE lower(split_part(filename, ' - ', 1))
            WHEN '318. billed charges summary report_g_bc01.xlsx' THEN 1
            WHEN '318. billed charges summary report_g_bc06.xlsx' THEN 2
            WHEN '318. billed charges summary report_g_bc10.xlsx' THEN 3
            WHEN '318. billed charges summary report_g_bc11.xlsx' THEN 4
            WHEN '318. billed charges summary report_g_bc13.xlsx' THEN 5
            WHEN '318. billed charges summary report_g_bc16.xlsx' THEN 6
            WHEN '318. billed charges summary report_g_bc18.xlsx' THEN 7
            WHEN '318. billed charges summary report_g_bc21.xlsx' THEN 8
            WHEN '318. billed charges summary report_g_bc24.xlsx' THEN 9
            WHEN '318. billed charges summary report_g_bc27.xlsx' THEN 10
            ELSE 0
        END AS cyclenumber
   FROM sdbtdir1_prepaid_dbo.billed_charges_lineitem_cycles
  WHERE lower("Customer Type"::text) !~~ lower('Report%Creator%Amdocs%BI%Team%'::text)
    AND dswtdir1_prepaid_dbo.prepaid_billing_row_matches(filename, dateread);

CREATE OR REPLACE PROCEDURE dswtdir1_prepaid_dbo.sp_prepaid1_eglayout_import_01_copa_pgx()
LANGUAGE plpgsql
AS $body$
BEGIN
Update dswtdir1_prepaid_dbo.dcPrepaidSystems
    Set    GP_EG_MT_Net = CASE WHEN dswtdir1_prepaid_dbo.prepaid_import_source_enabled('ke24') THEN (Select NetAmount
                           from   dswtdir1_prepaid_dbo.webdcKE24_EC_COPAValues
                           where  "Revenues Before Reclass" = 'GP-EG-MT') END
    where  dcPrepaidSystems."Layout Number" = 1;

Update dswtdir1_prepaid_dbo.dcPrepaidSystems
    Set    HY_EG_MT_Net = CASE WHEN dswtdir1_prepaid_dbo.prepaid_import_source_enabled('ke24') THEN (Select NetAmount
                           from   dswtdir1_prepaid_dbo.webdcKE24_EC_COPAValues
                           where  "Revenues Before Reclass" = 'HY-EG-MT') END
    where  dcPrepaidSystems."Layout Number" = 2;

Update dswtdir1_prepaid_dbo.dcPrepaidSystems
    Set    GP_EG_MT_Net = CASE WHEN dswtdir1_prepaid_dbo.prepaid_import_source_enabled('ke24') THEN (Select NetAmount
                           from   dswtdir1_prepaid_dbo.webdcKE24_EC_COPAValues
                           where  "Revenues Before Reclass" = 'GP-EG-NBB') END
    where  dcPrepaidSystems."Layout Number" = 3;

Update dswtdir1_prepaid_dbo.dcPrepaidSystems
    Set    GP_EG_MT_Gross = CASE WHEN dswtdir1_prepaid_dbo.prepaid_import_source_enabled('callcard_eg') THEN (Select TotalGrossAmount
                             from   sdbtdir1_prepaid_dbo.WebdcCallCard_TotalGrossAmout
                             where  Business = 'EG') END
    where  dcPrepaidSystems."REVENUES BEFORE RECLASS" = 'CALLCARD';

Update dswtdir1_prepaid_dbo.dcPrepaidSystems
    Set    GP_EG_MT_Gross = CASE WHEN dswtdir1_prepaid_dbo.prepaid_import_source_enabled('load_up_eg') THEN (Select Amount
                             from   sdbtdir1_prepaid_dbo.WebdcLoadUp_TotalAmount
                             where  Type = 'EG') END
    where  dcPrepaidSystems."REVENUES BEFORE RECLASS" = 'LOAD UP';

Update dswtdir1_prepaid_dbo.dcPrepaidSystems
    Set    GP_EG_MT_Gross = CASE WHEN dswtdir1_prepaid_dbo.prepaid_import_source_enabled('load_api_eg') THEN (Select Amount
                             from   sdbtdir1_prepaid_dbo.WebdcLoadAPI_TotalAmount
                             where  Type = 'EG') END
    where  dcPrepaidSystems."REVENUES BEFORE RECLASS" = 'LOAD/REWARDS API';

Update dswtdir1_prepaid_dbo.dcPrepaidSystems
    Set    HY_EG_MT_Gross = CASE WHEN dswtdir1_prepaid_dbo.prepaid_import_source_enabled('monthly_recharge') THEN (Select Amount
                             from   sdbtdir1_prepaid_dbo.WebRechargeSumamry_TotalAmount) END
    where  dcPrepaidSystems."REVENUES BEFORE RECLASS" = 'RECHARGE INSTRUCTION (recharge report)';

Update dswtdir1_prepaid_dbo.dcPrepaidSystems
    Set    HY_EG_MT_Gross = CASE WHEN dswtdir1_prepaid_dbo.prepaid_import_source_enabled('adjustments_308') OR dswtdir1_prepaid_dbo.prepaid_import_source_enabled('charges_318') THEN (Select Amount
                             from   sdbtdir1_prepaid_dbo.WebAmaxee_TotalAmount) END
    where  dcPrepaidSystems."REVENUES BEFORE RECLASS" = 'AMAXCE';
END;
$body$;
ALTER PROCEDURE dswtdir1_prepaid_dbo.sp_prepaid1_eglayout_import_01_copa_pgx() OWNER TO esatp_adm;

CREATE OR REPLACE PROCEDURE dswtdir1_prepaid_dbo.sp_prepaid1_sglayout_import_01_copa_pgx()
LANGUAGE plpgsql
AS $body$
BEGIN
Update dswtdir1_prepaid_dbo.dcPrepaidSystems_SG
    Set    GP_SG_MT_Net = CASE WHEN dswtdir1_prepaid_dbo.prepaid_import_source_enabled('ke24') THEN (Select NetAmount
                           from   dswtdir1_prepaid_dbo.webdcKE24_EC_COPAValues
                           where  "Revenues Before Reclass" = 'GP-SG-MT') END
    where  dcPrepaidSystems_SG."Layout Number" = 1;

Update dswtdir1_prepaid_dbo.dcPrepaidSystems_SG
    Set    HY_SG_MT_Net = CASE WHEN dswtdir1_prepaid_dbo.prepaid_import_source_enabled('ke24') THEN (Select NetAmount
                           from   dswtdir1_prepaid_dbo.webdcKE24_EC_COPAValues
                           where  "Revenues Before Reclass" = 'HY-SG-MT') END
    where  dcPrepaidSystems_SG."Layout Number" = 2;

Update dswtdir1_prepaid_dbo.dcPrepaidSystems_SG
    Set    GP_SG_MT_Net = CASE WHEN dswtdir1_prepaid_dbo.prepaid_import_source_enabled('ke24') THEN (Select NetAmount
                           from   dswtdir1_prepaid_dbo.webdcKE24_EC_COPAValues
                           where  "Revenues Before Reclass" = 'GP-SG-NBB') END
    where  dcPrepaidSystems_SG."Layout Number" = 3;

Update dswtdir1_prepaid_dbo.dcPrepaidSystems_SG
    Set    GP_SG_MT_Gross = CASE WHEN dswtdir1_prepaid_dbo.prepaid_import_source_enabled('callcard_sg') THEN (Select Cast(Cast(TRADE AS double precision) AS Decimal(33, 2))
                             from   dswtdir1_prepaid_dbo.WebdcCallCard_SG_TotalGrossAmout
                             where  MonthNo = (select Max(MonthNo)
                                               from   dswtdir1_prepaid_dbo.WebdcCallCard_SG_TotalGrossAmout)) END
    where  dcPrepaidSystems_SG."REVENUES BEFORE RECLASS" = 'Callcard sales - Trade';

Update dswtdir1_prepaid_dbo.dcPrepaidSystems_SG
    Set    GP_SG_MT_Gross = CASE WHEN dswtdir1_prepaid_dbo.prepaid_import_source_enabled('callcard_sg') THEN (Select Cast(Cast("INTERNAL  (BASED ON SALES)" AS double precision) AS Decimal(33, 2))
                             from   dswtdir1_prepaid_dbo.WebdcCallCard_SG_TotalGrossAmout
                             where  MonthNo = (select Max(MonthNo)
                                               from   dswtdir1_prepaid_dbo.WebdcCallCard_SG_TotalGrossAmout)) END
    where  dswtdir1_prepaid_dbo.dcPrepaidSystems_SG."REVENUES BEFORE RECLASS" = 'Callcard sales - internal';

Update dswtdir1_prepaid_dbo.dcPrepaidSystems_SG
    Set    GP_SG_MT_Gross = CASE WHEN dswtdir1_prepaid_dbo.prepaid_import_source_enabled('load_up_sg') THEN (Select Amount
                             from   sdbtdir1_prepaid_dbo.WebdcLoadUp_SG_TotalAmount
                             where  Type = 'SG') END
    where  dcPrepaidSystems_SG."REVENUES BEFORE RECLASS" = 'LOAD UP';

Update dswtdir1_prepaid_dbo.dcPrepaidSystems_SG
    Set    GP_SG_MT_Gross = CASE WHEN dswtdir1_prepaid_dbo.prepaid_import_source_enabled('load_api_sg') THEN (Select Amount
                             from   sdbtdir1_prepaid_dbo.WebdcLoadAPI_SG_TotalAmount
                             where  Type = 'SG') END
    where  dcPrepaidSystems_SG."REVENUES BEFORE RECLASS" = 'LOAD/REWARDS API';

Update dswtdir1_prepaid_dbo.dcPrepaidSystems_SG
    Set    HY_SG_MT_Gross = CASE WHEN dswtdir1_prepaid_dbo.prepaid_import_source_enabled('monthly_recharge') THEN (Select Amount
                             from   sdbtdir1_prepaid_dbo.WebRechargeSumamry_SG_TotalAmount) END
    where  dcPrepaidSystems_SG."REVENUES BEFORE RECLASS" = 'RECHARGE INSTRUCTION (recharge report)';

Update dswtdir1_prepaid_dbo.dcPrepaidSystems_SG
    Set    HY_SG_MT_Gross = CASE WHEN dswtdir1_prepaid_dbo.prepaid_import_source_enabled('adjustments_308') OR dswtdir1_prepaid_dbo.prepaid_import_source_enabled('charges_318') THEN (Select Amount
                             from   sdbtdir1_prepaid_dbo.WebAmaxee_SG_TotalAmount) END
    where  dcPrepaidSystems_SG."REVENUES BEFORE RECLASS" = 'AMAXCE';
END;
$body$;
ALTER PROCEDURE dswtdir1_prepaid_dbo.sp_prepaid1_sglayout_import_01_copa_pgx() OWNER TO esatp_adm;
