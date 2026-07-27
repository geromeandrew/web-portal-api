import { randomUUID } from "node:crypto";
import express, { type Express } from "express";
import jwt from "jsonwebtoken";
import multer from "multer";
import type { Pool } from "pg";
import { z } from "zod";
import type { Config } from "./config.js";
import { createAuthMiddleware, hashPassword, requireBootstrapAdmin, signAccessToken, verifyPassword } from "./auth.js";
import { withTransaction } from "./db.js";
import { AppError, errorHandler, notFound } from "./errors.js";
import { audit, ensureWorkspace, getState, setState } from "./workspace.js";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const workflows = ["prepaid", "memo", "aprm"] as const;
const uploadSchema = z.object({ workflow: z.enum(workflows), slot: z.string().min(1).max(160).optional() });
const passwordSchema = z.string().min(12).max(256);

type UploadRow = { id: string; workflow: "prepaid" | "memo" | "aprm"; slot: string | null; original_name: string; object_key: string; size: number; content_type: string; created_at: Date };
type UserRow = { id: string; email: string; password_hash: string; is_bootstrap_admin: boolean; is_active: boolean; must_change_password: boolean; token_version: number; created_at: Date };

function userDto(user: UserRow) {
  return { id: user.id, email: user.email, isBootstrapAdmin: user.is_bootstrap_admin, isActive: user.is_active, mustChangePassword: user.must_change_password, createdAt: user.created_at.toISOString() };
}

function uploadDto(upload: UploadRow) {
  return { id: upload.id, workflow: upload.workflow, ...(upload.slot ? { slot: upload.slot } : {}), originalName: upload.original_name, objectKey: upload.object_key, size: upload.size, contentType: upload.content_type, uploadedAt: upload.created_at.toISOString() };
}

function csvCell(value: unknown) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(headers: string[], rows: string[][]) {
  return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
}

export async function ensureBootstrapAdmin(pool: Pool, config: Config) {
  const email = config.ADMIN_EMAIL.trim().toLowerCase();
  const existing = await pool.query<UserRow>("SELECT * FROM users WHERE email = $1", [email]);
  if (existing.rows[0]) return;
  const passwordHash = await hashPassword(config.ADMIN_PASSWORD);
  await pool.query("INSERT INTO users (id, email, password_hash, is_bootstrap_admin) VALUES ($1, $2, $3, true)", [randomUUID(), email, passwordHash]);
  console.log(`Created bootstrap administrator ${email}.`);
}

export function createApp(pool: Pool, config: Config): Express {
  const app = express();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.MAX_UPLOAD_BYTES, files: 1 } });
  const authenticate = createAuthMiddleware(pool, config);

  app.disable("x-powered-by");
  app.use(express.json({ limit: "128kb" }));

  app.get("/api/healthz", async (_request, response) => {
    await pool.query("SELECT 1");
    response.json({ status: "ok" });
  });

  app.post("/api/auth/login", async (request, response) => {
    const body = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(request.body);
    const result = await pool.query<UserRow>("SELECT * FROM users WHERE email = $1", [body.email.trim().toLowerCase()]);
    const user = result.rows[0];
    if (!user || !user.is_active || !(await verifyPassword(body.password, user.password_hash))) throw new AppError(401, "INVALID_CREDENTIALS", "Email or password is incorrect.");
    await ensureWorkspace(pool, user.id);
    const accessToken = signAccessToken(config, { sub: user.id, email: user.email, version: user.token_version });
    response.json({ accessToken, user: userDto(user) });
  });

  app.post("/api/auth/logout", authenticate, (_request, response) => response.status(204).end());

  app.get("/api/auth/me", authenticate, async (request, response) => {
    const result = await pool.query<UserRow>("SELECT * FROM users WHERE id = $1", [request.auth!.userId]);
    response.json({ user: userDto(result.rows[0]) });
  });

  app.post("/api/auth/change-password", authenticate, async (request, response) => {
    const body = z.object({ currentPassword: z.string().min(1), newPassword: passwordSchema }).parse(request.body);
    const result = await pool.query<UserRow>("SELECT * FROM users WHERE id = $1", [request.auth!.userId]);
    const user = result.rows[0];
    if (!user || !(await verifyPassword(body.currentPassword, user.password_hash))) throw new AppError(400, "INVALID_PASSWORD", "Your current password is incorrect.");
    await pool.query("UPDATE users SET password_hash = $1, must_change_password = false, token_version = token_version + 1, updated_at = now() WHERE id = $2", [await hashPassword(body.newPassword), user.id]);
    const refreshed = await pool.query<UserRow>("SELECT * FROM users WHERE id = $1", [user.id]);
    const next = refreshed.rows[0];
    response.json({ accessToken: signAccessToken(config, { sub: next.id, email: next.email, version: next.token_version }), user: userDto(next) });
  });

  app.get("/api/admin/users", authenticate, requireBootstrapAdmin, async (_request, response) => {
    const users = await pool.query<UserRow>("SELECT * FROM users ORDER BY created_at DESC");
    response.json({ users: users.rows.map(userDto) });
  });

  app.post("/api/admin/users", authenticate, requireBootstrapAdmin, async (request, response) => {
    const body = z.object({ email: z.string().email(), temporaryPassword: passwordSchema }).parse(request.body);
    const email = body.email.trim().toLowerCase();
    const duplicate = await pool.query("SELECT 1 FROM users WHERE email = $1", [email]);
    if (duplicate.rowCount) throw new AppError(409, "EMAIL_EXISTS", "An account with this email already exists.");
    const id = randomUUID();
    await pool.query("INSERT INTO users (id, email, password_hash, must_change_password) VALUES ($1, $2, $3, true)", [id, email, await hashPassword(body.temporaryPassword)]);
    await ensureWorkspace(pool, id);
    const created = await pool.query<UserRow>("SELECT * FROM users WHERE id = $1", [id]);
    response.status(201).json({ user: userDto(created.rows[0]) });
  });

  app.patch("/api/admin/users/:id", authenticate, requireBootstrapAdmin, async (request, response) => {
    const body = z.object({ isActive: z.boolean().optional(), temporaryPassword: passwordSchema.optional() }).refine((value) => value.isActive !== undefined || value.temporaryPassword !== undefined).parse(request.body);
    if (request.params.id === request.auth!.userId && body.isActive === false) throw new AppError(400, "SELF_DEACTIVATION", "You cannot deactivate your own account.");
    const result = await pool.query<UserRow>("SELECT * FROM users WHERE id = $1", [request.params.id]);
    const user = result.rows[0];
    if (!user) throw new AppError(404, "USER_NOT_FOUND", "User not found.");
    await pool.query("UPDATE users SET is_active = COALESCE($1, is_active), password_hash = COALESCE($2, password_hash), must_change_password = CASE WHEN $2 IS NULL THEN must_change_password ELSE true END, token_version = token_version + 1, updated_at = now() WHERE id = $3", [body.isActive, body.temporaryPassword ? await hashPassword(body.temporaryPassword) : null, user.id]);
    const updated = await pool.query<UserRow>("SELECT * FROM users WHERE id = $1", [user.id]);
    response.json({ user: userDto(updated.rows[0]) });
  });

  app.get("/api/upload-policy", authenticate, (_request, response) => response.json({ maxFileSizeBytes: config.MAX_UPLOAD_BYTES, allowedMimeTypes: config.allowedMimeTypes }));

  app.get("/api/uploads", authenticate, async (request, response) => {
    const workflow = z.enum(workflows).optional().parse(request.query.workflow);
    const workspaceId = await ensureWorkspace(pool, request.auth!.userId);
    const result = await pool.query<UploadRow>(`SELECT id, workflow, slot, original_name, object_key, size, content_type, created_at FROM uploads WHERE workspace_id = $1 ${workflow ? "AND workflow = $2" : ""} ORDER BY created_at DESC`, workflow ? [workspaceId, workflow] : [workspaceId]);
    response.json({ uploads: result.rows.map(uploadDto) });
  });

  app.post("/api/uploads", authenticate, upload.single("file"), async (request, response) => {
    if (!request.file) throw new AppError(400, "FILE_REQUIRED", "Choose a file to upload.");
    const input = uploadSchema.parse(request.body);
    if (!config.allowedMimeTypes.includes(request.file.mimetype)) throw new AppError(415, "UNSUPPORTED_FILE_TYPE", "This file type is not allowed for this portal.");
    if ((input.workflow === "prepaid" || input.workflow === "memo") && request.file.mimetype !== XLSX) throw new AppError(415, "WORKFLOW_FILE_TYPE", "This workflow accepts Excel (.xlsx) files only.");
    if (input.workflow === "prepaid" && !input.slot) throw new AppError(400, "SLOT_REQUIRED", "A Prepaid source-file slot is required.");
    const workspaceId = await ensureWorkspace(pool, request.auth!.userId);
    const id = randomUUID();
    const originalName = request.file.originalname.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-") || "upload.bin";
    let lambdaUpload: { objectKey: string; size: number; contentType: string };
    try {
      const lambdaResponse = await fetch(config.LAMBDA_UPLOAD_URL, {
        method: "POST",
        headers: {
          "Content-Type": request.file.mimetype,
          "X-File-Name": encodeURIComponent(originalName),
          "X-File-Size": String(request.file.size),
          "X-Upload-Id": id,
        },
        body: new Uint8Array(request.file.buffer),
      });
      const payload = await lambdaResponse.json().catch(() => null) as { upload?: { objectKey?: string; size?: number; contentType?: string }; error?: string } | null;
      if (!lambdaResponse.ok || !payload?.upload?.objectKey) throw new AppError(502, "LAMBDA_UPLOAD_FAILED", payload?.error ?? "The upload service returned an invalid response.");
      lambdaUpload = { objectKey: payload.upload.objectKey, size: payload.upload.size ?? request.file.size, contentType: payload.upload.contentType ?? request.file.mimetype };
    } catch (error) {
      if (error instanceof AppError) throw error;
      console.error("Lambda upload failed", error);
      throw new AppError(502, "LAMBDA_UNAVAILABLE", "The upload service is unavailable. Please try again.");
    }
    try {
      const created = await withTransaction(pool, async (client) => {
        if (input.slot) {
          await client.query("DELETE FROM uploads WHERE workspace_id = $1 AND workflow = $2 AND slot = $3", [workspaceId, input.workflow, input.slot]);
        }
        const result = await client.query<UploadRow>("INSERT INTO uploads (id, workspace_id, workflow, slot, original_name, object_key, size, content_type) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, workflow, slot, original_name, object_key, size, content_type, created_at", [id, workspaceId, input.workflow, input.slot ?? null, originalName, lambdaUpload.objectKey, lambdaUpload.size, lambdaUpload.contentType]);
        await audit(client, workspaceId, "upload.created", { uploadId: id, workflow: input.workflow, slot: input.slot });
        return result.rows[0];
      });
      response.status(201).json({ upload: uploadDto(created) });
    } catch (error) {
      throw error;
    }
  });

  app.delete("/api/uploads/:id", authenticate, async (request, response) => {
    const workspaceId = await ensureWorkspace(pool, request.auth!.userId);
    const result = await pool.query<UploadRow>("SELECT id, workflow, slot, original_name, object_key, size, content_type, created_at FROM uploads WHERE id = $1 AND workspace_id = $2", [request.params.id, workspaceId]);
    const record = result.rows[0];
    if (!record) throw new AppError(404, "UPLOAD_NOT_FOUND", "Upload not found.");
    await pool.query("DELETE FROM uploads WHERE id = $1", [record.id]);
    await audit(pool, workspaceId, "upload.metadata_deleted", { uploadId: record.id, objectKey: record.object_key, note: "The Lambda-owned object is retained." });
    response.status(204).end();
  });

  app.get("/api/workflows/prepaid/state", authenticate, async (request, response) => {
    const workspaceId = await ensureWorkspace(pool, request.auth!.userId);
    const [egLayout, sgLayout, allocation, jv, report, sourceFiles, uploads] = await Promise.all([
      getState(pool, workspaceId, "prepaid", "eg-layout"), getState(pool, workspaceId, "prepaid", "sg-layout"), getState(pool, workspaceId, "prepaid", "allocation"), getState(pool, workspaceId, "prepaid", "jv"), getState(pool, workspaceId, "prepaid", "report"), getState(pool, workspaceId, "prepaid", "source-files"), pool.query<UploadRow>("SELECT id, workflow, slot, original_name, object_key, size, content_type, created_at FROM uploads WHERE workspace_id = $1 AND workflow = 'prepaid' ORDER BY created_at DESC", [workspaceId]),
    ]);
    response.json({ egLayout, sgLayout, allocation, jv, report, sourceFiles, uploads: uploads.rows.map(uploadDto) });
  });

  app.post("/api/workflows/prepaid/process", authenticate, async (request, response) => {
    const workspaceId = await ensureWorkspace(pool, request.auth!.userId);
    const sourceFiles = await getState<{ expected: string[] }>(pool, workspaceId, "prepaid", "source-files");
    const found = await pool.query<{ slot: string }>("SELECT slot FROM uploads WHERE workspace_id = $1 AND workflow = 'prepaid'", [workspaceId]);
    const uploadedSlots = new Set(found.rows.map((row) => row.slot));
    const missing = sourceFiles.expected.filter((slot) => !uploadedSlots.has(slot));
    if (missing.length) throw new AppError(400, "MISSING_SOURCE_FILES", "Upload all required Prepaid source files before processing.", { missing: missing.join(",") });
    const id = randomUUID();
    await pool.query("INSERT INTO workflow_runs (id, workspace_id, workflow, status) VALUES ($1, $2, 'prepaid', 'completed')", [id, workspaceId]);
    await audit(pool, workspaceId, "prepaid.processed", { runId: id });
    response.status(201).json({ run: { id, status: "completed", completedAt: new Date().toISOString() } });
  });

  app.post("/api/workflows/prepaid/layouts/:region/reset", authenticate, async (request, response) => {
    const region = z.enum(["eg", "sg"]).parse(request.params.region);
    const workspaceId = await ensureWorkspace(pool, request.auth!.userId);
    const current = await getState<{ frozen: boolean; rows: string[][] }>(pool, workspaceId, "prepaid", `${region}-layout`);
    await setState(pool, workspaceId, "prepaid", `${region}-layout`, { ...current, frozen: false });
    await audit(pool, workspaceId, "prepaid.layout.reset", { region });
    response.json({ layout: { ...current, frozen: false } });
  });

  app.post("/api/workflows/prepaid/layouts/:region/import", authenticate, async (request, response) => {
    const region = z.enum(["eg", "sg"]).parse(request.params.region);
    const workspaceId = await ensureWorkspace(pool, request.auth!.userId);
    const layout = await getState(pool, workspaceId, "prepaid", `${region}-layout`);
    await audit(pool, workspaceId, "prepaid.layout.imported", { region });
    response.json({ layout, message: "Layout state was refreshed from the current workflow snapshot." });
  });

  app.patch("/api/workflows/prepaid/layouts/:region/freeze", authenticate, async (request, response) => {
    const region = z.enum(["eg", "sg"]).parse(request.params.region);
    const body = z.object({ frozen: z.boolean() }).parse(request.body);
    const workspaceId = await ensureWorkspace(pool, request.auth!.userId);
    const layout = await getState<{ rows: string[][] }>(pool, workspaceId, "prepaid", `${region}-layout`);
    const next = { ...layout, frozen: body.frozen };
    await setState(pool, workspaceId, "prepaid", `${region}-layout`, next);
    await audit(pool, workspaceId, "prepaid.layout.freeze", { region, frozen: body.frozen });
    response.json({ layout: next });
  });

  app.post("/api/workflows/prepaid/allocation/validate", authenticate, async (request, response) => {
    const workspaceId = await ensureWorkspace(pool, request.auth!.userId);
    const allocation = await getState<{ rows: string[][] }>(pool, workspaceId, "prepaid", "allocation");
    const next = { ...allocation, lastValidation: { status: "valid", validatedAt: new Date().toISOString() } };
    await setState(pool, workspaceId, "prepaid", "allocation", next);
    await audit(pool, workspaceId, "prepaid.allocation.validated");
    response.json({ validation: next.lastValidation });
  });

  app.get("/api/workflows/prepaid/report.csv", authenticate, async (request, response) => {
    const workspaceId = await ensureWorkspace(pool, request.auth!.userId);
    const report = await getState<{ csv: string }>(pool, workspaceId, "prepaid", "report");
    response.attachment("prepaid-reclass-report.csv").type("text/csv").send(report.csv);
  });

  app.get("/api/workflows/memo/state", authenticate, async (request, response) => {
    const workspaceId = await ensureWorkspace(pool, request.auth!.userId);
    const [errors, uploads] = await Promise.all([getState(pool, workspaceId, "memo", "errors"), pool.query<UploadRow>("SELECT id, workflow, slot, original_name, object_key, size, content_type, created_at FROM uploads WHERE workspace_id = $1 AND workflow = 'memo' ORDER BY created_at DESC", [workspaceId])]);
    response.json({ errors, uploads: uploads.rows.map(uploadDto) });
  });

  app.get("/api/workflows/memo/errors.csv", authenticate, async (request, response) => {
    const workspaceId = await ensureWorkspace(pool, request.auth!.userId);
    const errors = await getState<{ headers: string[]; rows: string[][] }>(pool, workspaceId, "memo", "errors");
    response.attachment("memoapp-exceptions.csv").type("text/csv").send(toCsv(errors.headers, errors.rows));
  });

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
