-- Preserve the legacy slot numbers for existing reports. Assign an independent
-- slot to each additional cycle during scoped Portal billing processing.
CREATE FUNCTION dswtdir1_prepaid_dbo.prepaid_billing_cycle_number(
    p_filename text, p_legacy_slot integer
) RETURNS integer
LANGUAGE sql STABLE AS $body$
    SELECT CASE
        WHEN p_legacy_slot > 0 THEN p_legacy_slot
        WHEN nullif(current_setting('esatp.prepaid_billing_scope', true), '') IS NULL THEN 0
        ELSE coalesce(10 + substring(lower(split_part(p_filename, ' - ', 1))
            FROM '_bc(0[1-9]|[12][0-9]|3[01])[.]xlsx$')::integer, 0)
    END;
$body$;

CREATE OR REPLACE VIEW sdbtdir1_prepaid_dbo.billed_adjustments_header_cycle_ssis AS
SELECT
        dswtdir1_prepaid_dbo.prepaid_billing_cycle_number(filename,
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
            END) AS cyclenumber,
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
        dswtdir1_prepaid_dbo.prepaid_billing_cycle_number(filename,
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
            END) AS cyclenumber
   FROM sdbtdir1_prepaid_dbo.billed_adjustments_lineitem_cycles
  WHERE lower("Customer Type"::text) !~~ lower('Report%Creator%Amdocs%BI%Team%'::text)
    AND dswtdir1_prepaid_dbo.prepaid_billing_row_matches(filename, dateread);

CREATE OR REPLACE VIEW sdbtdir1_prepaid_dbo.billed_charges_header_cycle_ssis AS
SELECT
        dswtdir1_prepaid_dbo.prepaid_billing_cycle_number(filename,
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
            END) AS cyclenumber,
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
        dswtdir1_prepaid_dbo.prepaid_billing_cycle_number(filename,
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
            END) AS cyclenumber
   FROM sdbtdir1_prepaid_dbo.billed_charges_lineitem_cycles
  WHERE lower("Customer Type"::text) !~~ lower('Report%Creator%Amdocs%BI%Team%'::text)
    AND dswtdir1_prepaid_dbo.prepaid_billing_row_matches(filename, dateread);

-- The shared import totals were built for the ten legacy billing slots.
-- For a batch containing additional cycles, use the scoped PHP rows from
-- both report types. Preserve the existing import calculation for other runs.
CREATE FUNCTION dswtdir1_prepaid_dbo.prepaid_extended_amaxce_total(p_customer_type text)
RETURNS numeric LANGUAGE sql STABLE AS $body$
    SELECT CASE WHEN EXISTS (
        SELECT FROM sdbtdir1_prepaid_dbo.billed_adjustments_header_cycle_ssis WHERE cyclenumber > 10
        UNION ALL
        SELECT FROM sdbtdir1_prepaid_dbo.billed_charges_header_cycle_ssis WHERE cyclenumber > 10
    ) THEN
        coalesce((
            SELECT round(sum(amount::numeric), 2)
            FROM sdbtdir1_prepaid_dbo.billed_adjustments_lineitem_cycle_ssis
            WHERE cyclenumber > 0 AND upper(btrim(currency)) = 'PHP'
              AND upper(btrim("Customer Type")) = p_customer_type
              AND upper(btrim("Adjustment Code")) = 'AMAXCEP'
        ), 0) + coalesce((
            SELECT round(sum("Total Amount"::numeric), 2)
            FROM sdbtdir1_prepaid_dbo.billed_charges_lineitem_cycle_ssis
            WHERE cyclenumber > 0 AND upper(btrim(currency)) = 'PHP'
              AND upper(btrim("Customer Type")) = p_customer_type
              AND upper(btrim("Charge Code/Tax Code")) = 'AMAXCEP'
        ), 0)
    END;
$body$;

ALTER PROCEDURE dswtdir1_prepaid_dbo.sp_prepaid1_eglayout_import_01_copa_pgx()
    RENAME TO sp_prepaid1_eglayout_import_01_copa_legacy_pgx;
CREATE PROCEDURE dswtdir1_prepaid_dbo.sp_prepaid1_eglayout_import_01_copa_pgx()
LANGUAGE plpgsql AS $body$
DECLARE
    v_amount numeric;
BEGIN
    CALL dswtdir1_prepaid_dbo.sp_prepaid1_eglayout_import_01_copa_legacy_pgx();
    IF current_setting('esatp.prepaid_billing_scope', true) <> '' THEN
        v_amount := dswtdir1_prepaid_dbo.prepaid_extended_amaxce_total('E');
        IF v_amount IS NOT NULL THEN
            UPDATE dswtdir1_prepaid_dbo.dcPrepaidSystems SET HY_EG_MT_Gross = v_amount
            WHERE "REVENUES BEFORE RECLASS" = 'AMAXCE';
        END IF;
    END IF;
END;
$body$;
ALTER PROCEDURE dswtdir1_prepaid_dbo.sp_prepaid1_eglayout_import_01_copa_pgx() OWNER TO esatp_adm;

ALTER PROCEDURE dswtdir1_prepaid_dbo.sp_prepaid1_sglayout_import_01_copa_pgx()
    RENAME TO sp_prepaid1_sglayout_import_01_copa_legacy_pgx;
CREATE PROCEDURE dswtdir1_prepaid_dbo.sp_prepaid1_sglayout_import_01_copa_pgx()
LANGUAGE plpgsql AS $body$
DECLARE
    v_amount numeric;
BEGIN
    CALL dswtdir1_prepaid_dbo.sp_prepaid1_sglayout_import_01_copa_legacy_pgx();
    IF current_setting('esatp.prepaid_billing_scope', true) <> '' THEN
        v_amount := dswtdir1_prepaid_dbo.prepaid_extended_amaxce_total('S');
        IF v_amount IS NOT NULL THEN
            UPDATE dswtdir1_prepaid_dbo.dcPrepaidSystems_SG SET HY_SG_MT_Gross = v_amount
            WHERE "REVENUES BEFORE RECLASS" = 'AMAXCE';
        END IF;
    END IF;
END;
$body$;
ALTER PROCEDURE dswtdir1_prepaid_dbo.sp_prepaid1_sglayout_import_01_copa_pgx() OWNER TO esatp_adm;
