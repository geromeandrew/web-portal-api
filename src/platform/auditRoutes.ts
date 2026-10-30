/** Public method/path inventory: no request values are logged before validation. */
export const auditRoutes = [
  ["GET", "/api/auth/me", "auth.session_validated"],
  ["GET", "/api/admin/modules", "admin.modules.read"],
  ["GET", "/api/admin/users", "admin.users.read"],
  ["POST", "/api/admin/users", "user.created"],
  ["PATCH", "/api/admin/users/:userId", "user.updated"],
  ["PUT", "/api/admin/users/:userId/modules/:moduleId", "module.assigned"],
  ["DELETE", "/api/admin/users/:userId/modules/:moduleId", "module.removed"],
  ["GET", "/api/processing-pipelines", "pipeline.catalog.read"],
  [
    "GET",
    "/api/processing-pipelines/:pipelineCode",
    "pipeline.configuration.read",
  ],
  [
    "GET",
    "/api/processing-pipelines/:pipelineCode/requirements",
    "pipeline.requirements.read",
  ],
  [
    "GET",
    "/api/processing-pipelines/:pipelineCode/execution-details",
    "processing.configuration.read",
  ],
  [
    "GET",
    "/api/processing-pipelines/:pipelineCode/batch-execution-details",
    "processing.batch_configuration.read",
  ],
  [
    "GET",
    "/api/processing-pipelines/:pipelineCode/files",
    "file.inventory.read",
  ],
  [
    "POST",
    "/api/processing-pipelines/:pipelineCode/upload-batches",
    "upload.batch.created",
  ],
  [
    "GET",
    "/api/processing-pipelines/:pipelineCode/upload-batches",
    "upload.history.read",
  ],
  [
    "GET",
    "/api/processing-pipelines/:pipelineCode/files/content",
    "file.transfer",
  ],
  ["POST", "/api/processing-pipelines/:pipelineCode/files", "file.upload"],
  ["DELETE", "/api/processing-pipelines/:pipelineCode/files", "file.delete"],
  ["POST", "/api/processing-pipelines/:pipelineCode/runs", "processing.start"],
  [
    "POST",
    "/api/processing-pipelines/:pipelineCode/batch-runs",
    "processing.batch_start",
  ],
  [
    "GET",
    "/api/processing-pipelines/:pipelineCode/runs/:runId",
    "processing.status.read",
  ],
  ["GET", "/api/workflows/prepaid/state", "prepaid.state.read"],
  ["GET", "/api/workflows/prepaid/history", "prepaid.history.read"],
  ["DELETE", "/api/workflows/prepaid/uploads", "prepaid.uploads.clear"],
  ["POST", "/api/workflows/prepaid/process", "prepaid.process"],
  [
    "POST",
    "/api/workflows/prepaid/layouts/:region/reset",
    "prepaid.layout.reset",
  ],
  [
    "POST",
    "/api/workflows/prepaid/layouts/:region/import",
    "prepaid.layout.imported",
  ],
  [
    "PATCH",
    "/api/workflows/prepaid/layouts/:region/freeze",
    "prepaid.layout.freeze",
  ],
  [
    "POST",
    "/api/workflows/prepaid/allocation/validate",
    "prepaid.allocation.validated",
  ],
  ["GET", "/api/workflows/prepaid/report.csv", "report.transfer"],
] as const;
const classified = auditRoutes.map(([method, path, action]) => ({
  method,
  path,
  action,
  pattern: new RegExp(
    "^" +
      path
        .split("/")
        .map((p) => (p.startsWith(":") ? "[^/]+" : p.replaceAll(".", "\\.")))
        .join("/") +
      "/?$",
    "i",
  ),
}));
export function classifyAuditRoute(method: string, path: string) {
  return classified.find(
    (route) =>
      (route.method === method ||
        (method === "HEAD" && route.method === "GET")) &&
      route.pattern.test(path),
  );
}
