import { randomUUID } from "node:crypto";
import express, { type RequestHandler } from "express";
import { z } from "zod";
import type { AppDependencies } from "../../../app/dependencies.js";
import { createAuthMiddleware } from "../../../auth.js";
import { withTransaction } from "../../../db.js";
import { AppError } from "../../../errors.js";
import { audit, ensureWorkspace } from "../../../workspace.js";
import { uploadDto, type UploadRow } from "../../shared/api/dtos.js";
const XLSX =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const schema = z.object({
  workflow: z.enum(["prepaid", "memo", "aprm"]),
  slot: z.string().min(1).max(160).optional(),
});

export function createUploadsRouter(
  { pool, config, logger }: AppDependencies,
  singleFile: RequestHandler,
) {
  const router = express.Router();
  router.use(createAuthMiddleware(pool, config));
  router.post("/", singleFile, async (request, response) => {
    if (!request.file)
      throw new AppError(400, "FILE_REQUIRED", "Choose a file to upload.");
    const input = schema.parse(request.body);
    if (!config.allowedMimeTypes.includes(request.file.mimetype))
      throw new AppError(
        415,
        "UNSUPPORTED_FILE_TYPE",
        "This file type is not allowed for this portal.",
      );
    if (
      (input.workflow === "prepaid" || input.workflow === "memo") &&
      request.file.mimetype !== XLSX
    )
      throw new AppError(
        415,
        "WORKFLOW_FILE_TYPE",
        "This workflow accepts Excel (.xlsx) files only.",
      );
    if (input.workflow === "prepaid" && !input.slot)
      throw new AppError(
        400,
        "SLOT_REQUIRED",
        "A Prepaid source-file slot is required.",
      );
    const workspaceId = await ensureWorkspace(pool, request.auth!.userId);
    const id = randomUUID();
    const originalName =
      request.file.originalname
        .replace(/[^a-zA-Z0-9._-]+/g, "-")
        .replace(/-+/g, "-") || "upload.bin";
    let remote: { objectKey: string; size: number; contentType: string };
    try {
      const result = await fetch(config.LAMBDA_UPLOAD_URL, {
        method: "POST",
        headers: {
          "Content-Type": request.file.mimetype,
          "X-File-Name": encodeURIComponent(originalName),
          "X-File-Size": String(request.file.size),
          "X-Upload-Id": id,
        },
        body: new Uint8Array(request.file.buffer),
      });
      const payload = (await result.json().catch(() => null)) as {
        upload?: { objectKey?: string; size?: number; contentType?: string };
        error?: string;
      } | null;
      if (!result.ok || !payload?.upload?.objectKey)
        throw new AppError(
          502,
          "LAMBDA_UPLOAD_FAILED",
          payload?.error ?? "The upload service returned an invalid response.",
        );
      remote = {
        objectKey: payload.upload.objectKey,
        size: payload.upload.size ?? request.file.size,
        contentType: payload.upload.contentType ?? request.file.mimetype,
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      logger.error("upload.lambda_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new AppError(
        502,
        "LAMBDA_UNAVAILABLE",
        "The upload service is unavailable. Please try again.",
      );
    }
    const created = await withTransaction(pool, async (client) => {
      if (input.slot)
        await client.query(
          "DELETE FROM uploads WHERE workspace_id = $1 AND workflow = $2 AND slot = $3",
          [workspaceId, input.workflow, input.slot],
        );
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
    response.status(201).json({ upload: uploadDto(created) });
  });
  router.delete("/:id", async (request, response) => {
    const workspaceId = await ensureWorkspace(pool, request.auth!.userId);
    const found = await pool.query<UploadRow>(
      "SELECT id, workflow, slot, original_name, object_key, size, content_type, created_at FROM uploads WHERE id = $1 AND workspace_id = $2",
      [request.params.id, workspaceId],
    );
    const record = found.rows[0];
    if (!record)
      throw new AppError(404, "UPLOAD_NOT_FOUND", "Upload not found.");
    await pool.query("DELETE FROM uploads WHERE id = $1", [record.id]);
    await audit(pool, workspaceId, "upload.metadata_deleted", {
      uploadId: record.id,
      objectKey: record.object_key,
      note: "The Lambda-owned object is retained.",
    });
    response.status(204).end();
  });
  return router;
}
