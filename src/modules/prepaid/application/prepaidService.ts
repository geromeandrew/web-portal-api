import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { AppError } from "../../../errors.js";
import type { ProcessingPipelineStorage } from "../../../processingPipelineStorage.js";
import {
  audit,
  ensureWorkspace,
  getState,
  setState,
} from "../../../workspace.js";
import { uploadDto, type UploadRow } from "../../shared/api/dtos.js";

type Region = "eg" | "sg";
type AuditRow = {
  id: string;
  action: string;
  detail: Record<string, unknown> | string;
  created_at: Date;
};

function auditDetail(detail: AuditRow["detail"]) {
  if (typeof detail === "string") {
    return JSON.parse(detail) as Record<string, unknown>;
  }
  return detail;
}

export class PrepaidService {
  constructor(
    private readonly pool: Pool,
    private readonly processingPipelineStorage: ProcessingPipelineStorage,
  ) {}

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
    const available = await Promise.all(
      source.expected.map(async (fileName) => ({
        fileName,
        exists: await this.processingPipelineStorage.fileExists(
          "prepaid_reclass",
          this.processingPipelineStorage.fileKey("prepaid_reclass", fileName),
        ),
      })),
    );
    const missing = available
      .filter((file) => !file.exists)
      .map((file) => file.fileName);
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

  async getHistory(userId: string) {
    const workspaceId = await ensureWorkspace(this.pool, userId);
    const result = await this.pool.query<AuditRow>(
      `SELECT id, action, detail, created_at
       FROM audit_actions
       WHERE workspace_id = $1
         AND (
           (action = 'processing-pipeline.file-uploaded' AND detail->>'pipelineCode' = 'prepaid_reclass')
           OR action = 'prepaid.uploads_cleared'
         )
       ORDER BY created_at DESC
       LIMIT 100`,
      [workspaceId],
    );
    return {
      activities: result.rows.map((row) => {
        const detail = auditDetail(row.detail);
        return {
          id: row.id,
          action:
            row.action === "processing-pipeline.file-uploaded"
              ? "uploaded"
              : "cleared",
          fileName:
            typeof detail.expectedFileName === "string"
              ? detail.expectedFileName
              : null,
          slot:
            typeof detail.expectedFileName === "string"
              ? detail.expectedFileName
              : null,
          removedCount:
            typeof detail.removedCount === "number"
              ? detail.removedCount
              : null,
          occurredAt: row.created_at.toISOString(),
        };
      }),
    };
  }

  async clearUploads(userId: string) {
    const workspaceId = await ensureWorkspace(this.pool, userId);
    const source = await getState<{ expected: string[] }>(
      this.pool,
      workspaceId,
      "prepaid",
      "source-files",
    );
    let removedCount = 0;
    for (const fileName of source.expected) {
      const key = this.processingPipelineStorage.fileKey(
        "prepaid_reclass",
        fileName,
      );
      if (
        await this.processingPipelineStorage.fileExists("prepaid_reclass", key)
      ) {
        await this.processingPipelineStorage.deleteFile("prepaid_reclass", key);
        removedCount += 1;
      }
    }
    if (removedCount) {
      await audit(this.pool, workspaceId, "prepaid.uploads_cleared", {
        pipelineCode: "prepaid_reclass",
        removedCount,
      });
    }
    return { removedCount };
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
