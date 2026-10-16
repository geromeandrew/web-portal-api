/** Additive migration: the installed 001 migration is deliberately unchanged. */
export function prepaidWorkspaceMigrationSql(schema: string) {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error("Invalid schema");
  const s = `"${schema}"`;
  return `
CREATE TABLE ${s}.prepaid_upload_sessions (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES ${s}.workspaces(id),
 active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 0,
 status text NOT NULL DEFAULT 'collecting' CHECK(status IN ('collecting','pending','ready','failed')),
 configuration jsonb NOT NULL, run_id uuid REFERENCES ${s}.prepaid_runs(id),
 error text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX prepaid_active_session ON ${s}.prepaid_upload_sessions(workspace_id) WHERE active;
CREATE TABLE ${s}.prepaid_session_files (
 id uuid PRIMARY KEY, session_id uuid NOT NULL REFERENCES ${s}.prepaid_upload_sessions(id),
 source_code text NOT NULL, original_name text NOT NULL, object_key text NOT NULL UNIQUE,
 sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'), size_bytes bigint NOT NULL CHECK(size_bytes>0),
 uploaded_by uuid NOT NULL REFERENCES ${s}.app_user(id), active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX prepaid_active_session_file ON ${s}.prepaid_session_files(session_id,source_code) WHERE active;
CREATE TABLE ${s}.prepaid_preparation_jobs (
 id uuid PRIMARY KEY, session_id uuid NOT NULL REFERENCES ${s}.prepaid_upload_sessions(id),
 source_version integer NOT NULL, attempt integer NOT NULL, source_files jsonb NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','waiting','completed','failed','cancelled')),
 execution_name text NOT NULL UNIQUE, execution_arn text, execution_input jsonb,
 lease_token uuid, lease_until timestamptz, available_at timestamptz NOT NULL DEFAULT now(),
 error text, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(session_id,source_version,attempt)
);
CREATE UNIQUE INDEX prepaid_one_preparation ON ${s}.prepaid_preparation_jobs(session_id) WHERE status IN ('queued','running','waiting');
CREATE TABLE ${s}.prepaid_frozen_report_formats (
 revision_id uuid PRIMARY KEY REFERENCES ${s}.prepaid_region_revisions(id),
 format jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER prepaid_report_format_guard BEFORE UPDATE OR DELETE ON ${s}.prepaid_frozen_report_formats
 FOR EACH ROW EXECUTE FUNCTION ${s}.prepaid_guard_audit();
`;
}
