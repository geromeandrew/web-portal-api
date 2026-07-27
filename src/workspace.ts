import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { allocationRows, egLayoutRows, jvRows, memoErrors, memoHeaders, prepaidSourceFiles, sgLayoutRows } from "./workspace/defaultData.js";

type Queryable = Pool | PoolClient;

const defaultStates = [
  { module: "prepaid", key: "eg-layout", data: { frozen: false, rows: egLayoutRows } },
  { module: "prepaid", key: "sg-layout", data: { frozen: true, rows: sgLayoutRows } },
  { module: "prepaid", key: "allocation", data: { rows: allocationRows, lastValidation: null } },
  { module: "prepaid", key: "jv", data: { rows: jvRows } },
  { module: "prepaid", key: "report", data: { name: "Prepaid Report", csv: "Revenue before reclass,Total gross,Total net\nGP-EG-MT,-34738196.06,-31016246.48" } },
  { module: "prepaid", key: "source-files", data: { expected: prepaidSourceFiles } },
  { module: "memo", key: "errors", data: { headers: memoHeaders, rows: memoErrors } },
];

export async function ensureWorkspace(db: Queryable, userId: string) {
  const existing = await db.query<{ id: string }>("SELECT id FROM workspaces WHERE user_id = $1", [userId]);
  if (existing.rows[0]) return existing.rows[0].id;
  const workspaceId = randomUUID();
  await db.query("INSERT INTO workspaces (id, user_id) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING", [workspaceId, userId]);
  const workspace = await db.query<{ id: string }>("SELECT id FROM workspaces WHERE user_id = $1", [userId]);
  const id = workspace.rows[0].id;
  for (const state of defaultStates) {
    await db.query(
      "INSERT INTO workflow_states (id, workspace_id, module, state_key, data) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (workspace_id, module, state_key) DO NOTHING",
      [randomUUID(), id, state.module, state.key, JSON.stringify(state.data)],
    );
  }
  return id;
}

export async function getState<T>(db: Queryable, workspaceId: string, module: string, key: string): Promise<T> {
  const result = await db.query<{ data: T }>("SELECT data FROM workflow_states WHERE workspace_id = $1 AND module = $2 AND state_key = $3", [workspaceId, module, key]);
  if (!result.rows[0]) throw new Error(`Missing ${module}/${key} state.`);
  return result.rows[0].data;
}

export async function setState(db: Queryable, workspaceId: string, module: string, key: string, data: unknown) {
  await db.query("UPDATE workflow_states SET data = $1, updated_at = now() WHERE workspace_id = $2 AND module = $3 AND state_key = $4", [JSON.stringify(data), workspaceId, module, key]);
}

export async function audit(db: Queryable, workspaceId: string, action: string, detail: unknown = {}) {
  await db.query("INSERT INTO audit_actions (id, workspace_id, action, detail) VALUES ($1, $2, $3, $4)", [randomUUID(), workspaceId, action, JSON.stringify(detail)]);
}
