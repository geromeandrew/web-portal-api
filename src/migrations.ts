export const migrations = [{
  id: "001_initial",
  sql: `
    CREATE TABLE IF NOT EXISTS users (
      id uuid PRIMARY KEY,
      email text NOT NULL UNIQUE,
      password_hash text NOT NULL,
      is_bootstrap_admin boolean NOT NULL DEFAULT false,
      is_active boolean NOT NULL DEFAULT true,
      must_change_password boolean NOT NULL DEFAULT false,
      token_version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS workspaces (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS workflow_states (
      id uuid PRIMARY KEY,
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      module text NOT NULL,
      state_key text NOT NULL,
      data jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (workspace_id, module, state_key)
    );
    CREATE TABLE IF NOT EXISTS uploads (
      id uuid PRIMARY KEY,
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      workflow text NOT NULL,
      slot text,
      original_name text NOT NULL,
      object_key text NOT NULL UNIQUE,
      size integer NOT NULL,
      content_type text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uploads_unique_slot ON uploads (workspace_id, workflow, slot) WHERE slot IS NOT NULL;
    CREATE TABLE IF NOT EXISTS workflow_runs (
      id uuid PRIMARY KEY,
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      workflow text NOT NULL,
      status text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS audit_actions (
      id uuid PRIMARY KEY,
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      action text NOT NULL,
      detail jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `,
}];
