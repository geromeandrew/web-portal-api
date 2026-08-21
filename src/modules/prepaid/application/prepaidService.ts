import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { AppError } from "../../../errors.js";
import {
  audit,
  ensureWorkspace,
  getState,
  setState,
} from "../../../workspace.js";
import { uploadDto, type UploadRow } from "../../shared/api/dtos.js";

type Region = "eg" | "sg";

export class PrepaidService {
  constructor(private readonly pool: Pool) {}

  async getState(userId: string) {
    const workspaceId = await ensureWorkspace(this.pool, userId);
    const [egLayout, sgLayout, allocation, jv, report, sourceFiles, uploads] =
      await Promise.all([
        getState(this.pool, workspaceId, "prepaid", "eg-layout"),
        getState(this.pool, workspaceId, "prepaid", "sg-layout"),
        getState(this.pool, workspaceId, "prepaid", "allocation"),
        getState(this.pool, workspaceId, "prepaid", "jv"),
        getState(this.pool, workspaceId, "prepaid", "report"),
        getState(this.pool, workspaceId, "prepaid", "source-files"),
        this.pool.query<UploadRow>(
          "SELECT id, workflow, slot, original_name, object_key, size, content_type, created_at FROM uploads WHERE workspace_id = $1 AND workflow = 'prepaid' ORDER BY created_at DESC",
          [workspaceId],
        ),
      ]);
    return {
      egLayout,
      sgLayout,
      allocation,
      jv,
      report,
      sourceFiles,
      uploads: uploads.rows.map(uploadDto),
    };
  }

  async process(userId: string) {
    const workspaceId = await ensureWorkspace(this.pool, userId);
    const source = await getState<{ expected: string[] }>(
      this.pool,
      workspaceId,
      "prepaid",
      "source-files",
    );
    const found = await this.pool.query<{ slot: string }>(
      "SELECT slot FROM uploads WHERE workspace_id = $1 AND workflow = 'prepaid'",
      [workspaceId],
    );
    const slots = new Set(found.rows.map((row) => row.slot));
    const missing = source.expected.filter((slot) => !slots.has(slot));
    if (missing.length) {
      throw new AppError(
        400,
        "MISSING_SOURCE_FILES",
        "Upload all required Prepaid source files before processing.",
        { missing: missing.join(",") },
      );
    }
    const id = randomUUID();
    await this.pool.query(
      "INSERT INTO workflow_runs (id, workspace_id, workflow, status) VALUES ($1, $2, 'prepaid', 'completed')",
      [id, workspaceId],
    );
    await audit(this.pool, workspaceId, "prepaid.processed", { runId: id });
    return { id, status: "completed", completedAt: new Date().toISOString() };
  }

  async resetLayout(userId: string, region: Region) {
    const workspaceId = await ensureWorkspace(this.pool, userId);
    const current = await getState<{ frozen: boolean; rows: string[][] }>(
      this.pool,
      workspaceId,
      "prepaid",
      `${region}-layout`,
    );
    const layout = { ...current, frozen: false };
    await setState(
      this.pool,
      workspaceId,
      "prepaid",
      `${region}-layout`,
      layout,
    );
    await audit(this.pool, workspaceId, "prepaid.layout.reset", { region });
    return layout;
  }

  async importLayout(userId: string, region: Region) {
    const workspaceId = await ensureWorkspace(this.pool, userId);
    const layout = await getState(
      this.pool,
      workspaceId,
      "prepaid",
      `${region}-layout`,
    );
    await audit(this.pool, workspaceId, "prepaid.layout.imported", { region });
    return layout;
  }

  async freezeLayout(userId: string, region: Region, frozen: boolean) {
    const workspaceId = await ensureWorkspace(this.pool, userId);
    const layout = await getState<{ rows: string[][] }>(
      this.pool,
      workspaceId,
      "prepaid",
      `${region}-layout`,
    );
    const next = { ...layout, frozen };
    await setState(this.pool, workspaceId, "prepaid", `${region}-layout`, next);
    await audit(this.pool, workspaceId, "prepaid.layout.freeze", {
      region,
      frozen,
    });
    return next;
  }

  async validateAllocation(userId: string) {
    const workspaceId = await ensureWorkspace(this.pool, userId);
    const allocation = await getState<{ rows: string[][] }>(
      this.pool,
      workspaceId,
      "prepaid",
      "allocation",
    );
    const next = {
      ...allocation,
      lastValidation: {
        status: "valid",
        validatedAt: new Date().toISOString(),
      },
    };
    await setState(this.pool, workspaceId, "prepaid", "allocation", next);
    await audit(this.pool, workspaceId, "prepaid.allocation.validated");
    return next.lastValidation;
  }

  async getReport(userId: string) {
    const workspaceId = await ensureWorkspace(this.pool, userId);
    return getState<{ csv: string }>(
      this.pool,
      workspaceId,
      "prepaid",
      "report",
    );
  }
}
