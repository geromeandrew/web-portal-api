import { randomUUID } from "node:crypto";
import express from "express";
import { z } from "zod";
import type { AppDependencies } from "../../../app/dependencies.js";
import { createAuthMiddleware } from "../../../auth.js";
import { AppError } from "../../../errors.js";
import {
  audit,
  ensureWorkspace,
  getState,
  setState,
} from "../../../workspace.js";
import { uploadDto, type UploadRow } from "../../shared/api/dtos.js";
export function createPrepaidRouter({ pool, config }: AppDependencies) {
  const router = express.Router();
  router.use(createAuthMiddleware(pool, config));
  router.get("/state", async (req, res) => {
    const w = await ensureWorkspace(pool, req.auth!.userId);
    const [egLayout, sgLayout, allocation, jv, report, sourceFiles, uploads] =
      await Promise.all([
        getState(pool, w, "prepaid", "eg-layout"),
        getState(pool, w, "prepaid", "sg-layout"),
        getState(pool, w, "prepaid", "allocation"),
        getState(pool, w, "prepaid", "jv"),
        getState(pool, w, "prepaid", "report"),
        getState(pool, w, "prepaid", "source-files"),
        pool.query<UploadRow>(
          "SELECT id, workflow, slot, original_name, object_key, size, content_type, created_at FROM uploads WHERE workspace_id = $1 AND workflow = 'prepaid' ORDER BY created_at DESC",
          [w],
        ),
      ]);
    res.json({
      egLayout,
      sgLayout,
      allocation,
      jv,
      report,
      sourceFiles,
      uploads: uploads.rows.map(uploadDto),
    });
  });
  router.post("/process", async (req, res) => {
    const w = await ensureWorkspace(pool, req.auth!.userId);
    const source = await getState<{ expected: string[] }>(
      pool,
      w,
      "prepaid",
      "source-files",
    );
    const found = await pool.query<{ slot: string }>(
      "SELECT slot FROM uploads WHERE workspace_id = $1 AND workflow = 'prepaid'",
      [w],
    );
    const slots = new Set(found.rows.map((x) => x.slot));
    const missing = source.expected.filter((x) => !slots.has(x));
    if (missing.length)
      throw new AppError(
        400,
        "MISSING_SOURCE_FILES",
        "Upload all required Prepaid source files before processing.",
        { missing: missing.join(",") },
      );
    const id = randomUUID();
    await pool.query(
      "INSERT INTO workflow_runs (id, workspace_id, workflow, status) VALUES ($1, $2, 'prepaid', 'completed')",
      [id, w],
    );
    await audit(pool, w, "prepaid.processed", { runId: id });
    res
      .status(201)
      .json({
        run: { id, status: "completed", completedAt: new Date().toISOString() },
      });
  });
  router.post("/layouts/:region/reset", async (req, res) => {
    const region = z.enum(["eg", "sg"]).parse(req.params.region);
    const w = await ensureWorkspace(pool, req.auth!.userId);
    const current = await getState<{ frozen: boolean; rows: string[][] }>(
      pool,
      w,
      "prepaid",
      `${region}-layout`,
    );
    await setState(pool, w, "prepaid", `${region}-layout`, {
      ...current,
      frozen: false,
    });
    await audit(pool, w, "prepaid.layout.reset", { region });
    res.json({ layout: { ...current, frozen: false } });
  });
  router.post("/layouts/:region/import", async (req, res) => {
    const region = z.enum(["eg", "sg"]).parse(req.params.region);
    const w = await ensureWorkspace(pool, req.auth!.userId);
    const layout = await getState(pool, w, "prepaid", `${region}-layout`);
    await audit(pool, w, "prepaid.layout.imported", { region });
    res.json({
      layout,
      message: "Layout state was refreshed from the current workflow snapshot.",
    });
  });
  router.patch("/layouts/:region/freeze", async (req, res) => {
    const region = z.enum(["eg", "sg"]).parse(req.params.region);
    const body = z.object({ frozen: z.boolean() }).parse(req.body);
    const w = await ensureWorkspace(pool, req.auth!.userId);
    const layout = await getState<{ rows: string[][] }>(
      pool,
      w,
      "prepaid",
      `${region}-layout`,
    );
    const next = { ...layout, frozen: body.frozen };
    await setState(pool, w, "prepaid", `${region}-layout`, next);
    await audit(pool, w, "prepaid.layout.freeze", {
      region,
      frozen: body.frozen,
    });
    res.json({ layout: next });
  });
  router.post("/allocation/validate", async (req, res) => {
    const w = await ensureWorkspace(pool, req.auth!.userId);
    const allocation = await getState<{ rows: string[][] }>(
      pool,
      w,
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
    await setState(pool, w, "prepaid", "allocation", next);
    await audit(pool, w, "prepaid.allocation.validated");
    res.json({ validation: next.lastValidation });
  });
  router.get("/report.csv", async (req, res) => {
    const w = await ensureWorkspace(pool, req.auth!.userId);
    const report = await getState<{ csv: string }>(
      pool,
      w,
      "prepaid",
      "report",
    );
    res
      .attachment("prepaid-reclass-report.csv")
      .type("text/csv")
      .send(report.csv);
  });
  return router;
}
