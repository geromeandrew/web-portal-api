import type { RequestHandler } from "express";
import type { Pool } from "pg";
import type { PrepaidRunService } from "../application/runService.js";
import type { PrepaidWorkspaceService } from "../application/workspaceService.js";
import type { PrepaidReferenceRefreshService } from "../application/referenceRefreshService.js";
import type { PrepaidReferenceCatalog } from "../infrastructure/referenceCatalog.js";

/** Services are constructed once and shared by every endpoint registration. */
export type PrepaidRouteContext = {
  pool: Pool;
  service: PrepaidRunService;
  workspace: PrepaidWorkspaceService;
  references: PrepaidReferenceRefreshService;
  catalog: PrepaidReferenceCatalog;
  upload: RequestHandler;
};
