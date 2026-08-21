import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { Config } from "../../../config.js";
import { withTransaction } from "../../../db.js";
import { AppError } from "../../../errors.js";
import type { Logger } from "../../../platform/logger.js";
import { audit, ensureWorkspace } from "../../../workspace.js";
import { uploadDto, type UploadRow } from "../../shared/api/dtos.js";

const XLSX =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export type UploadInput = {
  workflow: "prepaid" | "memo" | "aprm";
  slot?: string;
};

export class UploadService {
  constructor(
    private readonly pool: Pool,
    private readonly config: Config,
    private readonly logger: Logger,
  ) {}

  async create(userId: string, file: Express.Multer.File, input: UploadInput) {
    this.validateFile(file, input);
    const workspaceId = await ensureWorkspace(this.pool, userId);
    const id = randomUUID();
    const originalName = this.sanitizeFileName(file.originalname);
    const remote = await this.uploadToLambda(id, file, originalName);

    const created = await withTransaction(this.pool, async (client) => {
      if (input.slot) {
        await client.query(
          "DELETE FROM uploads WHERE workspace_id = $1 AND workflow = $2 AND slot = $3",
          [workspaceId, input.workflow, input.slot],
        );
      }
      const inserted = await client.query<UploadRow>(
        "INSERT INTO uploads (id, workspace_id, workflow, slot, original_name, object_key, size, content_type) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, workflow, slot, original_name, object_key, size, content_type, created_at",
        [
          id,
          workspaceId,
          input.workflow,
          input.slot ?? null,
          originalName,
          remote.objectKey,
          remote.size,
          remote.contentType,
        ],
      );
      await audit(client, workspaceId, "upload.created", {
        uploadId: id,
        workflow: input.workflow,
        slot: input.slot,
      });
      return inserted.rows[0];
    });
    return uploadDto(created);
  }

  async remove(userId: string, id: string) {
    const workspaceId = await ensureWorkspace(this.pool, userId);
    const found = await this.pool.query<UploadRow>(
      "SELECT id, workflow, slot, original_name, object_key, size, content_type, created_at FROM uploads WHERE id = $1 AND workspace_id = $2",
      [id, workspaceId],
    );
    const record = found.rows[0];
    if (!record) {
      throw new AppError(404, "UPLOAD_NOT_FOUND", "Upload not found.");
    }
    await this.pool.query("DELETE FROM uploads WHERE id = $1", [record.id]);
    await audit(this.pool, workspaceId, "upload.metadata_deleted", {
      uploadId: record.id,
      objectKey: record.object_key,
      note: "The Lambda-owned object is retained.",
    });
  }

  private validateFile(file: Express.Multer.File, input: UploadInput) {
    if (!this.config.allowedMimeTypes.includes(file.mimetype)) {
      throw new AppError(
        415,
        "UNSUPPORTED_FILE_TYPE",
        "This file type is not allowed for this portal.",
      );
    }
    if (
      (input.workflow === "prepaid" || input.workflow === "memo") &&
      file.mimetype !== XLSX
    ) {
      throw new AppError(
        415,
        "WORKFLOW_FILE_TYPE",
        "This workflow accepts Excel (.xlsx) files only.",
      );
    }
    if (input.workflow === "prepaid" && !input.slot) {
      throw new AppError(
        400,
        "SLOT_REQUIRED",
        "A Prepaid source-file slot is required.",
      );
    }
  }

  private async uploadToLambda(
    id: string,
    file: Express.Multer.File,
    originalName: string,
  ) {
    try {
      const result = await fetch(this.config.LAMBDA_UPLOAD_URL, {
        method: "POST",
        headers: {
          "Content-Type": file.mimetype,
          "X-File-Name": encodeURIComponent(originalName),
          "X-File-Size": String(file.size),
          "X-Upload-Id": id,
        },
        body: new Uint8Array(file.buffer),
      });
      const payload = (await result.json().catch(() => null)) as {
        upload?: { objectKey?: string; size?: number; contentType?: string };
        error?: string;
      } | null;
      if (!result.ok || !payload?.upload?.objectKey) {
        throw new AppError(
          502,
          "LAMBDA_UPLOAD_FAILED",
          payload?.error ?? "The upload service returned an invalid response.",
        );
      }
      return {
        objectKey: payload.upload.objectKey,
        size: payload.upload.size ?? file.size,
        contentType: payload.upload.contentType ?? file.mimetype,
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      this.logger.error("upload.lambda_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new AppError(
        502,
        "LAMBDA_UNAVAILABLE",
        "The upload service is unavailable. Please try again.",
      );
    }
  }

  private sanitizeFileName(name: string) {
    return (
      name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-") || "upload.bin"
    );
  }
}
