import type { OpenAPIV3 } from "openapi-types";

const json = (schema: OpenAPIV3.SchemaObject): OpenAPIV3.RequestBodyObject => ({
  required: true,
  content: { "application/json": { schema } },
});
const version: OpenAPIV3.SchemaObject = { type: "integer", minimum: 0 };
const reason: OpenAPIV3.SchemaObject = {
  type: "string",
  minLength: 1,
  maxLength: 1000,
};
const command: OpenAPIV3.SchemaObject = {
  type: "object",
  required: ["version"],
  properties: { version, reason },
};
const region: OpenAPIV3.SchemaObject = { type: "string", enum: ["eg", "sg"] };
const paths: OpenAPIV3.PathsObject = {};
function add(
  path: string,
  method: "get" | "post" | "put" | "patch" | "delete",
  summary: string,
  body?: OpenAPIV3.RequestBodyObject,
  status = "200",
  query: OpenAPIV3.ParameterObject[] = [],
) {
  const parameters: OpenAPIV3.ParameterObject[] = [
    ...path.matchAll(/\{(\w+)\}/g),
  ].map((m) => ({
    name: m[1],
    in: "path",
    required: true,
    schema:
      m[1] === "region"
        ? region
        : {
            type: "string",
            ...(m[1].endsWith("Id") ? { format: "uuid" } : {}),
          },
  }));
  const full = `/api/workflows/prepaid${path}`;
  (paths[full] ??= {})[method] = {
    summary,
    description:
      "Requires Prepaid module access and ownership of the run. All money values are decimal strings. Conflicts and stale layout versions return 409. Asynchronous responses require polling the run.",
    parameters: [...parameters, ...query],
    ...(body ? { requestBody: body } : {}),
    responses: {
      [status]: {
        description:
          status === "202"
            ? "Durably queued, not yet completed or delivered."
            : "Success.",
      },
      "400": { description: "Invalid input." },
      "403": {
        description: "Module access or administrator permission denied.",
      },
      "404": { description: "Run or resource not owned/found." },
      "409": {
        description: "State, source, version, validation or delivery conflict.",
      },
      "503": { description: "Prepaid schema not installed." },
    },
  };
}
add(
  "/report-history",
  "get",
  "List owned frozen report snapshots by Singapore upload date",
  undefined,
  "200",
  [
    { name: "date", in: "query", schema: { type: "string", format: "date" } },
    {
      name: "limit",
      in: "query",
      schema: { type: "integer", minimum: 1, maximum: 100, default: 25 },
    },
    {
      name: "offset",
      in: "query",
      schema: { type: "integer", minimum: 0, default: 0 },
    },
  ],
);
add(
  "/runs/{runId}/reset-workspace",
  "post",
  "Atomically reset regional drafts and detach sources; preserve immutable reports and in-flight delivery",
  json({
    type: "object",
    required: ["eg", "sg"],
    properties: { eg: version, sg: version },
  }),
);
add(
  "/runs/{runId}/layouts/{region}/allocation-summary",
  "get",
  "Read SQL-calculated allocation summary",
  undefined,
  "200",
  [
    {
      name: "variant",
      in: "query",
      required: true,
      schema: { type: "string", enum: ["mt", "bb"] },
    },
    {
      name: "revisionId",
      in: "query",
      schema: { type: "string", format: "uuid" },
    },
  ],
);
add(
  "/runs/{runId}/layouts/{region}/reconciliation.csv",
  "get",
  "Download revision-specific reconciliation CSV (archived revision must be frozen)",
  undefined,
  "200",
  [
    {
      name: "revisionId",
      in: "query",
      schema: { type: "string", format: "uuid" },
    },
  ],
);
add(
  "/readiness",
  "get",
  "Read schema/configuration readiness; never starts AWS jobs or verifies SAP connectivity",
);
paths["/api/workflows/prepaid/readiness"]!.get!.description =
  "Requires authentication and Prepaid module access, not run ownership. Returns schemaInstalled, integrationConfigured, readyForUploads, actionable checks, legacyBasis and externalVerification=not_verified. legacyBasis distinguishes supplied SQL Agent/JV evidence from unavailable job steps, cycle data and physical export settings. It is not executable AWS configuration. Configuration is not proof of deployed ingestion or SAP acceptance.";
(
  paths["/api/workflows/prepaid/readiness"]!.get!.responses[
    "200"
  ] as OpenAPIV3.ResponseObject
).content = {
  "application/json": {
    schema: {
      type: "object",
      required: [
        "schemaInstalled",
        "integrationConfigured",
        "readyForUploads",
        "externalVerification",
        "checks",
      ],
      properties: {
        schemaInstalled: { type: "boolean" },
        integrationConfigured: { type: "boolean" },
        readyForUploads: { type: "boolean" },
        externalVerification: { type: "string", enum: ["not_verified"] },
        legacyBasis: {
          type: "object",
          description:
            "Legacy job names, cycle-table evidence and implemented JV content; never auto-approved runtime settings.",
          required: ["ingestion", "freeze", "billingCycles", "journal"],
          properties: {
            ingestion: { type: "object", additionalProperties: true },
            freeze: { type: "object", additionalProperties: true },
            billingCycles: { type: "object", additionalProperties: true },
            journal: { type: "object", additionalProperties: true },
          },
        },
        checks: {
          type: "array",
          items: {
            type: "object",
            required: ["code", "status", "message"],
            properties: {
              code: { type: "string" },
              status: {
                type: "string",
                enum: ["configured", "missing", "invalid", "not_verified"],
              },
              message: { type: "string" },
            },
          },
        },
      },
    },
  },
};
add("/integration", "get", "Read Prepaid integration configuration");
add(
  "/integration",
  "put",
  "Configure approved ingestion and manual report format (administrator only)",
  json({
    type: "object",
    required: ["ingestStateMachine", "expectedCycles", "format"],
    properties: {
      ingestStateMachine: { type: "string" },
      sourceExtraction: {
        type: "object",
        required: ["envPrefix", "sharedWritesApproved"],
        additionalProperties: false,
        description:
          "Optional unchanged four-workflow extraction using only env_prefix. The backend validates/normalizes originals and creates receipts; no Portal* states or script deployment required. Requires explicit approval for shared legacy raw-table writes and coordinated input folders. Does not replace the complete V2 adapter.",
        properties: {
          envPrefix: { type: "string", enum: ["isg-esatp-dv"] },
          sharedWritesApproved: { type: "boolean", enum: [true] },
        },
      },
      sourceSplitPolicy: {
        type: "string",
        enum: ["independent", "legacy_eg_total"],
        description:
          "Opt-in legacy EG source-total conservation; omitted means existing independent edits. Captured per snapshot.",
      },
      deliveryStateMachine: { type: "string" },
      target: { type: "string" },
      upstreamPrefix: { type: "string" },
      expectedCycles: {
        type: "array",
        minItems: 1,
        uniqueItems: true,
        items: { type: "string", pattern: "^[0-9]{2}$" },
      },
      format: {
        type: "object",
        required: [
          "profile",
          "approved",
          "delimiter",
          "lineEnding",
          "encoding",
        ],
        properties: {
          profile: { type: "string" },
          approved: { type: "boolean", enum: [true] },
          delimiter: { type: "string", enum: ["\t", "|", ","] },
          lineEnding: { type: "string", enum: ["\r\n", "\n"] },
          encoding: { type: "string", enum: ["utf8", "utf16le"] },
          reversalSupported: { type: "boolean" },
        },
      },
    },
  }),
);
add(
  "/workspace/extractions",
  "get",
  "Read your four source workflow executions and remaining external dependencies",
);
add("/runs", "get", "List accounting-period runs in your workspace");
add(
  "/runs",
  "post",
  "Create accounting-period run",
  json({
    type: "object",
    required: ["period"],
    properties: {
      period: {
        type: "string",
        pattern: "^[0-9]{4}-(0[1-9]|1[0-2])$",
        example: "2026-09",
      },
    },
  }),
  "201",
);
add(
  "/runs/{runId}",
  "get",
  "Read revisions, sources, ingestion jobs and delivery states",
);
add(
  "/runs/{runId}/select",
  "post",
  "Select active run for compatibility endpoints",
);
add("/runs/{runId}/sources", "get", "Check required files and cycle coverage");
add(
  "/runs/{runId}/sources/{code}",
  "post",
  "Upload an immutable run-scoped source",
  {
    required: true,
    content: {
      "multipart/form-data": {
        schema: {
          type: "object",
          required: ["file"],
          properties: { file: { type: "string", format: "binary" } },
        },
      },
    },
  },
  "201",
);
add(
  "/runs/{runId}/sources/{code}",
  "delete",
  "Detach active source (retains audit and S3 object)",
);
add(
  "/runs/{runId}/upstream",
  "post",
  "Attach upstream billing manifest for provenance verification",
  json({
    type: "object",
    required: ["manifestKey"],
    properties: { manifestKey: { type: "string" } },
  }),
  "201",
);
add(
  "/runs/{runId}/upstream",
  "delete",
  "Detach upstream snapshot and require raw 308/318 inputs again",
);
add(
  "/runs/{runId}/process",
  "post",
  "Queue immutable source ingestion",
  undefined,
  "202",
);
add(
  "/runs/{runId}/layouts/{region}",
  "get",
  "Read latest regional layout and optimistic version",
);
add(
  "/runs/{runId}/layouts/{region}",
  "patch",
  "Save allowed gross-amount cells with audit reason",
  json({
    type: "object",
    required: ["version", "changes"],
    properties: {
      version,
      reason,
      changes: {
        type: "array",
        minItems: 1,
        maxItems: 100,
        items: {
          type: "object",
          required: ["layoutNumber", "field", "value"],
          properties: {
            layoutNumber: { type: "integer", minimum: 0, maximum: 27 },
            field: {
              type: "string",
              enum: ["gp_mt_gross", "hy_mt_gross", "gp_bb_gross"],
            },
            value: {
              type: "string",
              nullable: true,
              pattern: "^-?[0-9]{1,28}(\\.[0-9]{1,10})?$",
            },
          },
        },
      },
    },
  }),
);
for (const action of ["import", "reset", "validate"])
  add(
    `/runs/{runId}/layouts/{region}/${action}`,
    "post",
    `${action} latest draft`,
    json(command),
  );
add(
  "/runs/{runId}/layouts/{region}/edit",
  "post",
  "Open draft correction without altering frozen predecessor",
  json(command),
);
add(
  "/runs/{runId}/layouts/{region}/freeze",
  "post",
  "Validate and freeze immutable reports for manual SAP staging (no dispatch)",
  json(command),
  "200",
);
const paging: OpenAPIV3.ParameterObject[] = [
  {
    name: "limit",
    in: "query",
    schema: { type: "integer", minimum: 1, maximum: 500, default: 100 },
  },
  {
    name: "offset",
    in: "query",
    schema: { type: "integer", minimum: 0, default: 0 },
  },
  {
    name: "revisionId",
    in: "query",
    schema: { type: "string", format: "uuid" },
  },
];
for (const kind of ["allocations", "reconciliation", "jv"])
  add(
    `/runs/{runId}/layouts/{region}/${kind}`,
    "get",
    `Read ${kind} for latest or explicit revision`,
    undefined,
    "200",
    [
      ...paging,
      ...(kind === "allocations"
        ? [
            {
              name: "variant",
              in: "query" as const,
              schema: { type: "string" as const, enum: ["mt", "bb"] },
            },
          ]
        : []),
    ],
  );
add("/runs/{runId}/history", "get", "Read audit trail");
add(
  "/runs/{runId}/exports",
  "get",
  "List immutable delivery exports and hashes",
);
add(
  "/runs/{runId}/exports/{exportId}/download",
  "get",
  "Download immutable SAP-format export",
);
paths[
  "/api/workflows/prepaid/runs/{runId}/exports/{exportId}/download"
]!.get!.responses["200"] = {
  description: "Export bytes.",
  content: {
    "application/octet-stream": {
      schema: { type: "string", format: "binary" },
    },
  },
};
add(
  "/runs/{runId}/jobs/{jobId}/retry",
  "post",
  "Retry a confirmed no-delivery failure only",
  undefined,
  "202",
);
add(
  "/runs/{runId}/jobs/{jobId}/reconcile",
  "post",
  "Reconcile unknown remote outcome without resending",
  json({
    type: "object",
    properties: {
      receiptKey: {
        type: "string",
        description:
          "Optional trusted, run-scoped late receipt. IDs, execution and hash must match the original dispatch.",
      },
    },
  }),
  "202",
);
add("/history", "get", "Read selected-run audit trail");
add(
  "/uploads",
  "delete",
  "Detach selected-run sources without deleting shared uploads",
);
add(
  "/workspace",
  "get",
  "Read owned upload session; never create a session or financial run on view",
);
add(
  "/workspace/sources/{code}",
  "post",
  "Upload a source before the period is known; queue preparation when complete",
  {
    required: true,
    content: {
      "multipart/form-data": {
        schema: {
          type: "object",
          required: ["file"],
          properties: { file: { type: "string", format: "binary" } },
        },
      },
    },
  },
  "201",
);
add(
  "/workspace/sources/{code}",
  "delete",
  "Detach an owned session input without deleting source objects",
);
add(
  "/workspace/prepare",
  "post",
  "Retry failed preparation using the same complete source session",
);
add(
  "/workspace/reset",
  "post",
  "Reset active session and regional drafts, preserving frozen history",
  json({
    type: "object",
    properties: {
      runId: { type: "string", format: "uuid" },
      eg: version,
      sg: version,
      sessionId: { type: "string", format: "uuid" },
      sessionVersion: version,
    },
  }),
);
add(
  "/runs/{runId}/reports/{snapshotFile}",
  "get",
  "Download a ZIP of immutable layout, allocation, reconciliation and JV reports for an owned snapshot",
);
const zipPath =
  paths["/api/workflows/prepaid/runs/{runId}/reports/{snapshotFile}"]!.get!;
(zipPath.responses["200"] as OpenAPIV3.ResponseObject).content = {
  "application/zip": { schema: { type: "string", format: "binary" } },
};
for (const suffix of ["reference-membership", "reference-membership.csv"]) {
  add(
    `/runs/{runId}/layouts/{region}/${suffix}`,
    "get",
    "Read legacy Prepaid membership findings (report-only; not a Freeze gate)",
    undefined,
    "200",
    [
      {
        name: "mode",
        in: "query",
        schema: { type: "string", enum: ["all", "gp-non-bb"], default: "all" },
      },
      {
        name: "revisionId",
        in: "query",
        schema: { type: "string", format: "uuid" },
      },
      {
        name: "limit",
        in: "query",
        schema: { type: "integer", minimum: 1, maximum: 500, default: 100 },
      },
      {
        name: "offset",
        in: "query",
        schema: { type: "integer", minimum: 0, default: 0 },
      },
    ],
  );
  const operation =
    paths[`/api/workflows/prepaid/runs/{runId}/layouts/{region}/${suffix}`]!
      .get!;
  operation.description =
    "Owned current/historical revision. Requires attested source_brand from legacy BRAND (not WWBRD). Missing metadata returns complete=false in JSON and 409 for CSV; never assumes GHP-PREPAID membership. CSV exports all rows up to 50,000 and ignores pagination; findings do not block Freeze.";
  if (suffix.endsWith(".csv"))
    (operation.responses["200"] as OpenAPIV3.ResponseObject).content = {
      "text/csv": { schema: { type: "string", format: "binary" } },
    };
  operation.responses["413"] = {
    description: "CSV exceeds the 50,000-row synchronous limit.",
  };
}
export const prepaidOpenApiPaths = paths;
