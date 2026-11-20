/** Additive, no reference records, approvals or shared-table writes. */
export function prepaidReferenceRefreshMigrationSql(schema: string) {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw Error("Invalid schema");
  return `CREATE TABLE "${schema}".prepaid_reference_refreshes (
    id uuid PRIMARY KEY,
    idempotency_key uuid NOT NULL UNIQUE,
    actor_id uuid NOT NULL REFERENCES "${schema}".app_user(id),
    request jsonb NOT NULL,
    status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','waiting','unknown','completed','failed')),
    phase text NOT NULL DEFAULT 'queued' CHECK(phase IN ('queued','dispatching','running','exporting','publishing','releasing','complete')),
    glue_run_id text,
    source_bytes bytea,
    provenance jsonb,
    result jsonb,
    error text,
    outcome text CHECK(outcome IN ('completed','failed')),
    attempts integer NOT NULL DEFAULT 0,
    available_at timestamptz NOT NULL DEFAULT now(),
    lease_token uuid,
    lease_until timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK(source_bytes IS NULL OR octet_length(source_bytes)<=20971520)
  );
  CREATE UNIQUE INDEX prepaid_reference_refresh_active ON "${schema}".prepaid_reference_refreshes ((true))
    WHERE status NOT IN ('completed','failed');
  CREATE INDEX prepaid_reference_refresh_poll ON "${schema}".prepaid_reference_refreshes(available_at)
    WHERE status IN ('queued','waiting','running');`;
}
