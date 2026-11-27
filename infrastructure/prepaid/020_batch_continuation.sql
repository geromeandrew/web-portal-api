-- Scope each billing file to the import that extracted it.
CREATE OR REPLACE FUNCTION dswtdir1_prepaid_dbo.prepaid_billing_row_matches(
    p_filename text, p_read_at timestamp without time zone
) RETURNS boolean
LANGUAGE sql STABLE AS $body$
    SELECT CASE WHEN scope IS NULL THEN true ELSE
        p_read_at >= coalesce(
            (scope->'extracted_at'->>lower(split_part(p_filename, ' - ', 1)))::timestamptz AT TIME ZONE 'UTC',
            (scope->>'started_at')::timestamptz AT TIME ZONE 'UTC'
        )
        AND (scope->'filenames') ? lower(split_part(p_filename, ' - ', 1))
    END
    FROM (SELECT nullif(current_setting('esatp.prepaid_billing_scope', true), '')::jsonb AS scope) AS context;
$body$;
ALTER FUNCTION dswtdir1_prepaid_dbo.prepaid_billing_row_matches(text, timestamp without time zone) OWNER TO esatp_adm;

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
        '^portal-prepaid-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-import(-[0-9a-f]{16})?$'
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
        SELECT dateread, '308' AS report, lower(split_part(filename, ' - ', 1)) AS filename,
               ltrim(btrim(column2), '0') AS cycle
        FROM sdbtdir1_prepaid_dbo.billed_adjustments_header_cycles
        WHERE column1 ILIKE 'Cycle%Code:%'
        UNION ALL
        SELECT dateread, '318', lower(split_part(filename, ' - ', 1)), ltrim(btrim(column2), '0')
        FROM sdbtdir1_prepaid_dbo.billed_charges_header_cycles
        WHERE column1 ILIKE 'Cycle%Code:%'
    )
    SELECT string_agg(file->>'code', ', ' ORDER BY file->>'code')
      INTO v_missing
    FROM jsonb_array_elements(v_billing_files) AS file
    WHERE NOT EXISTS (
        SELECT FROM current_headers h
        WHERE h.report = split_part(file->>'code', '_', 1)
          AND h.filename = lower(file->>'name')
          AND h.dateread >= coalesce((file->>'extractedAt')::timestamptz AT TIME ZONE 'UTC', v_started_at)
          AND h.cycle = ltrim(split_part(file->>'code', '_', 2), '0')
    );
    IF v_missing IS NOT NULL THEN
        RAISE EXCEPTION 'Missing fresh Prepaid billing headers or mismatched report cycles: %', v_missing;
    END IF;

    PERFORM set_config('esatp.prepaid_billing_scope', jsonb_build_object(
        'started_at', v_started_at AT TIME ZONE 'UTC',
        'extracted_at', (SELECT jsonb_object_agg(lower(file->>'name'), file->>'extractedAt')
                         FROM jsonb_array_elements(v_billing_files) AS file
                         WHERE file ? 'extractedAt'),
        'filenames', (SELECT coalesce(jsonb_agg(lower(file->>'name')), '[]'::jsonb) FROM jsonb_array_elements(v_billing_files) AS file),
        'workflows', (SELECT jsonb_agg(DISTINCT file->>'workflow') FROM jsonb_array_elements(v_files) AS file)
    )::text, true);
END;
$body$;
ALTER PROCEDURE dswtdir1_prepaid_dbo.prepaid_scope_billing_import(varchar) OWNER TO esatp_adm;
