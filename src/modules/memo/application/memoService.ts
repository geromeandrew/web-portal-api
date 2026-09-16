import type { Pool } from "pg";
import { ensureWorkspace, getState } from "../../../workspace.js";
import { uploadDto, type UploadRow } from "../../shared/api/dtos.js";

export class MemoService {
  constructor(private readonly pool: Pool) {}

  async getState(userId: string) {
    const workspaceId = await ensureWorkspace(this.pool, userId);
    const [errors, uploads] = await Promise.all([
      getState(this.pool, workspaceId, "memo", "errors"),
      this.pool.query<UploadRow>(
        "SELECT id, workflow, slot, original_name, object_key, size, content_type, created_at FROM uploads WHERE workspace_id = $1 AND workflow = 'memo' ORDER BY created_at DESC",
        [workspaceId],
      ),
    ]);
    return { errors, uploads: uploads.rows.map(uploadDto) };
  }

  async getErrorCsv(userId: string) {
    const workspaceId = await ensureWorkspace(this.pool, userId);
    return getState<{ headers: string[]; rows: string[][] }>(
      this.pool,
      workspaceId,
      "memo",
      "errors",
    );
  }
}
