// Frozen ticket corrections. Preserve identities, assignments and historical data.
export const workspaceFixes025Sql = `
  ALTER TABLE processing_pipeline_upload_batch_files ADD COLUMN IF NOT EXISTS removed_at timestamptz;

  UPDATE app_modules SET is_active = false
  WHERE module_id IN ('aprm_content', 'iccbs_inov', 'iccbs_bayn', 'north');

  UPDATE processing_pipeline_file_requirements requirement
  SET s3_key_prefix = 'isms_ibob_actualization/inbound/', updated_at = now()
  FROM processing_pipelines pipeline
  WHERE requirement.pipeline_id = pipeline.id AND pipeline.code = 'isms_ibob_actzn';

  UPDATE processing_pipeline_file_requirements requirement
  SET acquisition_method = 'sftp_pull', updated_at = now()
  FROM processing_pipelines pipeline
  WHERE requirement.pipeline_id = pipeline.id
    AND pipeline.code IN ('aprm_voice_accrual', 'aprm_voice_delta')
    AND requirement.file_name ~* '^ICEXT_.*_OUTPUT[.]TXT$';

  -- Migration 024 appended the corrected 324 report after the SAP files.
  -- Restore the documented report order without replacing requirement IDs.
  UPDATE processing_pipeline_file_requirements requirement
  SET display_order = CASE
    WHEN requirement.file_name LIKE '307.%' THEN 1
    WHEN requirement.file_name LIKE '317.%' THEN 2
    WHEN requirement.file_name LIKE '324.%' THEN 3
    WHEN requirement.file_name LIKE 'Unconfirmed Advanced%' THEN 4
    WHEN requirement.file_name LIKE 'sap_airc%' THEN 5
    WHEN requirement.file_name LIKE 'sap_aiuc%' THEN 6
    WHEN requirement.file_name LIKE 'sap_glunbilled_unconf%' THEN 8
    ELSE 7 END, updated_at = now()
  FROM processing_pipelines pipeline
  WHERE requirement.pipeline_id = pipeline.id AND pipeline.code = 'bss_eom_glob';
`;
