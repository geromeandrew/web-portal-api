export function prepaidFullBatchMigrationSql(schema: string) {
  return `
CREATE TABLE "${schema}".prepaid_full_batches (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES "${schema}".prepaid_upload_sessions(id),
  files jsonb NOT NULL,
  phase text NOT NULL CHECK (phase IN ('import','eg','sg','cleanup','release')),
  status text NOT NULL CHECK (status IN ('queued','running','review','failed','closed')),
  inputs_staged boolean NOT NULL DEFAULT false,
  executions jsonb NOT NULL DEFAULT '{}',
  layouts jsonb NOT NULL DEFAULT '{}',
  error text,
  next_check timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX prepaid_full_batches_active
  ON "${schema}".prepaid_full_batches ((true)) WHERE status <> 'closed';
`;
}
