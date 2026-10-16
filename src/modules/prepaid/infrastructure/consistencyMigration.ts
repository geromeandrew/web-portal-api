/** Additive provenance only: never rewrites ready snapshots or frozen reports. */
export function prepaidConsistencyMigrationSql(schema: string) {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error("Invalid schema");
  const s = `"${schema}"`;
  return `
CREATE TABLE ${s}.prepaid_snapshot_context (
 snapshot_id uuid PRIMARY KEY REFERENCES ${s}.prepaid_source_snapshots(id),
 session_id uuid NOT NULL REFERENCES ${s}.prepaid_upload_sessions(id),
 source_version integer NOT NULL CHECK(source_version>=0),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER prepaid_context_guard BEFORE UPDATE OR DELETE ON ${s}.prepaid_snapshot_context
 FOR EACH ROW EXECUTE FUNCTION ${s}.prepaid_guard_audit();
-- Recover provenance only from completed, exact persisted preparation evidence.
INSERT INTO ${s}.prepaid_snapshot_context(snapshot_id,session_id,source_version)
SELECT x.id,j.session_id,j.source_version
FROM ${s}.prepaid_source_snapshots x
JOIN ${s}.prepaid_preparation_jobs j ON j.id::text=x.manifest->>'preparationId'
JOIN ${s}.prepaid_upload_sessions u ON u.id=j.session_id
JOIN ${s}.prepaid_runs r ON r.id=x.run_id
WHERE x.status='ready' AND x.manifest->>'contractVersion'='2'
 AND j.status='completed' AND x.manifest->>'sessionId'=u.id::text
 AND x.manifest->>'workspaceId'=r.workspace_id::text AND u.workspace_id=r.workspace_id
 AND x.manifest->>'sourceVersion'=j.source_version::text
 AND x.manifest->>'executionArn'=j.execution_arn
 AND x.source_files=j.source_files AND x.configuration=u.configuration;
`;
}
