// Frozen migration inputs: do not import the live pipeline catalogue here.
const cycles = [
  "01",
  "06",
  "08",
  "10",
  "11",
  "13",
  "16",
  "18",
  "21",
  "24",
  "27",
];
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
export const criticalFixes024Corrections = [
  ...(
    [
      ["glob", "G", "Globe"],
      ["bayn", "B", "Bayan"],
      ["inov", "I", "Innove"],
    ] as const
  ).flatMap(([code, entity, schema]) =>
    cycles.map((cycle) => ({
      pipeline: `bss_billcycle_${code}`,
      name: `sap_glbilled_${entity}_${cycle}.txt`,
      previous: `sap_glbilled_${entity}_${cycle}.XLSX`,
      package: `MyBss_${schema}_sapglbilled.dtsx`,
      schema: `sdbTDIR2_${schema}`,
      machine:
        code === "glob"
          ? "globe_billcycle_sapglbilled_preload"
          : code === "bayn"
            ? "bayan_billcycle_sapglbilled_preload"
            : null,
      cycle,
    })),
  ),
  ...cycles.map((cycle) => ({
    pipeline: "bss_billcycle_glob",
    name: `308. Billed Adjustments Monthly Summary Report_G_${cycle}.XLSX`,
    previous: "",
    package: "MyBss_Globe_308_Billed_Adjustments.dtsx",
    schema: "sdbTDIR2_Globe",
    machine: "globe_billcycle_308_preload",
    cycle,
  })),
  {
    pipeline: "bss_eom_glob",
    name: "324. Unearned MSF Summary Report_G.XLSX",
    previous: "Unearned MSF Summary Report_G.XLSX",
    package: "MyBss_Globe_324_Unearned_MSF.dtsx",
    schema: "sdbTDIR2_Globe",
    machine: null,
    cycle: "",
  },
];

export const criticalFixes024Sql =
  criticalFixes024Corrections
    .map(
      (row, index) => `
  INSERT INTO processing_pipeline_file_requirements
    (pipeline_id, file_name, match_type, legacy_package_name, display_order, is_active,
     acquisition_method, source_file_pull_rename_rules, s3_key_prefix, database_schema_destination)
  SELECT id, ${quote(row.name)}, 'exact', ${quote(row.package)}, ${index + 1}, true,
    'web_upload', ${quote(row.name.endsWith(".txt") ? "Preserve SAP text content and save as sap_glbilled_<Entity>_<BillCycle>.txt." : "Use the configured canonical filename.")},
    ${quote(`${row.pipeline}/inbound/`)}, ${quote(row.schema)}
  FROM processing_pipelines WHERE code = ${quote(row.pipeline)}
  ON CONFLICT (pipeline_id, file_name) DO UPDATE SET
    is_active = true, match_type = EXCLUDED.match_type,
    legacy_package_name = EXCLUDED.legacy_package_name,
    source_file_pull_rename_rules = EXCLUDED.source_file_pull_rename_rules, updated_at = now();

  INSERT INTO processing_pipeline_file_destinations (file_requirement_id, table_name, display_order)
  SELECT corrected.id, destination.table_name, destination.display_order
  FROM processing_pipeline_file_requirements corrected
  JOIN processing_pipelines pipeline ON pipeline.id = corrected.pipeline_id
  JOIN processing_pipeline_file_requirements old ON old.pipeline_id = pipeline.id AND old.file_name = ${quote(row.previous)}
  JOIN processing_pipeline_file_destinations destination ON destination.file_requirement_id = old.id
  WHERE pipeline.code = ${quote(row.pipeline)} AND corrected.file_name = ${quote(row.name)}
  ON CONFLICT (file_requirement_id, table_name) DO NOTHING;

  ${
    row.machine
      ? `
  INSERT INTO processing_pipeline_file_step_function_mappings
    (file_requirement_id, state_machine_id, batch_cycle, execution_input, is_active)
  SELECT requirement.id, machine.id, ${quote(row.cycle)}, ${quote(JSON.stringify({ cycle: row.cycle }))}::jsonb, true
  FROM processing_pipeline_file_requirements requirement
  JOIN processing_pipelines pipeline ON pipeline.id = requirement.pipeline_id
  JOIN processing_pipeline_step_function_state_machines machine ON machine.code = ${quote(row.machine)}
  WHERE pipeline.code = ${quote(row.pipeline)} AND requirement.file_name = ${quote(row.name)}
  ON CONFLICT (file_requirement_id) DO UPDATE SET state_machine_id = EXCLUDED.state_machine_id,
    batch_cycle = EXCLUDED.batch_cycle, execution_input = EXCLUDED.execution_input,
    is_active = true, updated_at = now();`
      : ""
  }

  INSERT INTO processing_pipeline_batch_step_function_mapping_files
    (batch_mapping_id, file_requirement_id, display_order)
  SELECT member.batch_mapping_id, corrected.id, member.display_order
  FROM processing_pipeline_file_requirements corrected
  JOIN processing_pipelines pipeline ON pipeline.id = corrected.pipeline_id
  JOIN processing_pipeline_file_requirements old ON old.pipeline_id = pipeline.id AND old.file_name = ${quote(row.previous)}
  JOIN processing_pipeline_batch_step_function_mapping_files member ON member.file_requirement_id = old.id
  WHERE pipeline.code = ${quote(row.pipeline)} AND corrected.file_name = ${quote(row.name)}
  ON CONFLICT (batch_mapping_id, file_requirement_id) DO UPDATE SET display_order = EXCLUDED.display_order;

  DELETE FROM processing_pipeline_batch_step_function_mapping_files member
  USING processing_pipeline_file_requirements old, processing_pipelines pipeline
  WHERE member.file_requirement_id = old.id AND old.pipeline_id = pipeline.id
    AND pipeline.code = ${quote(row.pipeline)} AND old.file_name = ${quote(row.previous)};

  UPDATE processing_pipeline_file_step_function_mappings mapping SET is_active = false, updated_at = now()
  FROM processing_pipeline_file_requirements old, processing_pipelines pipeline
  WHERE mapping.file_requirement_id = old.id AND old.pipeline_id = pipeline.id
    AND pipeline.code = ${quote(row.pipeline)} AND old.file_name = ${quote(row.previous)};

  UPDATE processing_pipeline_file_requirements requirement SET is_active = false, updated_at = now()
  FROM processing_pipelines pipeline WHERE pipeline.id = requirement.pipeline_id
    AND pipeline.code = ${quote(row.pipeline)} AND requirement.file_name = ${quote(row.previous)};
`,
    )
    .join("\n") +
  `
  INSERT INTO processing_pipeline_file_destinations (file_requirement_id, table_name, display_order)
  SELECT requirement.id, '308_Billed_Adjustments_ssis', 1
  FROM processing_pipeline_file_requirements requirement
  JOIN processing_pipelines pipeline ON pipeline.id = requirement.pipeline_id
  WHERE pipeline.code = 'bss_billcycle_glob' AND requirement.is_active AND requirement.file_name LIKE '308.%'
  ON CONFLICT (file_requirement_id, table_name) DO NOTHING;

  CREATE INDEX IF NOT EXISTS processing_pipeline_upload_batches_pipeline_history
    ON processing_pipeline_upload_batches (pipeline_id, created_at DESC);
`;
