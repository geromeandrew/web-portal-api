/** Additive 006: child execution evidence, isolated by preparation request. */
export function prepaidSourceExtractionMigrationSql(schema: string) {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw Error("Invalid schema");
  const s = `"${schema}"`;
  return `CREATE TABLE ${s}.prepaid_source_extractions (
    id uuid PRIMARY KEY, preparation_id uuid NOT NULL REFERENCES ${s}.prepaid_preparation_jobs(id),
    workflow text NOT NULL CHECK(workflow IN ('callcard_sg','load_api_eg','load_api_sg','adjustments_308')),
    execution_name text NOT NULL UNIQUE, execution_input jsonb NOT NULL,
    execution_arn text UNIQUE, status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','waiting','completed','failed')),
    receipt jsonb, error text, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
    UNIQUE(preparation_id,workflow)
  );
  CREATE INDEX prepaid_source_extractions_preparation ON ${s}.prepaid_source_extractions(preparation_id,status);`;
}
