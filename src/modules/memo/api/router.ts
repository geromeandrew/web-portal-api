import express from "express";
import type { AppDependencies } from "../../../app/dependencies.js";
import { createAuthMiddleware } from "../../../auth.js";
import { ensureWorkspace, getState } from "../../../workspace.js";
import { toCsv } from "../../shared/domain/csv.js";
import { uploadDto, type UploadRow } from "../../shared/api/dtos.js";
export function createMemoRouter({ pool, config }: AppDependencies) {
  const router = express.Router();
  router.use(createAuthMiddleware(pool, config));
  router.get("/state", async (req, res) => {
    const w = await ensureWorkspace(pool, req.auth!.userId);
    const [errors, uploads] = await Promise.all([
      getState(pool, w, "memo", "errors"),
      pool.query<UploadRow>(
        "SELECT id, workflow, slot, original_name, object_key, size, content_type, created_at FROM uploads WHERE workspace_id = $1 AND workflow = 'memo' ORDER BY created_at DESC",
        [w],
      ),
    ]);
    res.json({ errors, uploads: uploads.rows.map(uploadDto) });
  });
  router.get("/errors.csv", async (req, res) => {
    const w = await ensureWorkspace(pool, req.auth!.userId);
    const errors = await getState<{ headers: string[]; rows: string[][] }>(
      pool,
      w,
      "memo",
      "errors",
    );
    res
      .attachment("memoapp-exceptions.csv")
      .type("text/csv")
      .send(toCsv(errors.headers, errors.rows));
  });
  return router;
}
