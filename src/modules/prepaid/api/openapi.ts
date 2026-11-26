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
add(
  "/reference-exports",
  "post",
  "Administrator: queue a verified immutable SAP reference export",
  json({
    type: "object",
    additionalProperties: false,
    required: ["idempotencyKey", "period", "mode", "scopeApproved"],
    oneOf: [
      { properties: { mode: { type: "string", enum: ["export_existing"] } } },
      {
        required: ["sharedWritesApproved"],
        properties: { mode: { type: "string", enum: ["refresh_and_export"] } },
      },
    ],
    properties: {
      idempotencyKey: { type: "string", format: "uuid" },
      period: { type: "string", pattern: "^\\d{4}-(0[1-9]|1[0-2])$" },
      mode: { type: "string", enum: ["export_existing", "refresh_and_export"] },
      scopeApproved: {
        type: "boolean",
        enum: [true],
        description:
          "Acknowledge the portal scope: client 300, company GLOB. GLOB is not an explicit legacy-view filter.",
      },
      sharedWritesApproved: {
        type: "boolean",
        enum: [true],
        description:
          "Required for refresh_and_export: authorizes the existing Glue job's whole-table overwrite.",
      },
    },
  }),
  "202",
);
add(
  "/reference-exports/{referenceId}",
  "get",
  "Administrator: poll a reference operation and retrieve its immutable export descriptor",
);
add(
  "/reference-exports/{referenceId}/reconcile",
  "post",
  "Administrator: reconcile an unknown original reference run without starting another",
  json({ type: "object", additionalProperties: false }),
  "202",
);
for (const path of [
  "/reference-exports",
  "/reference-exports/{referenceId}",
  "/reference-exports/{referenceId}/reconcile",
]) {
  const operation = paths[`/api/workflows/prepaid${path}`]!;
  for (const method of ["get", "post"] as const)
    if (operation[method])
      operation[method]!.description =
        "Requires authentication, Prepaid module access, active administrator permission and migration 009; no run is needed. Explicit opt-in operation, never triggered by uploads. export_existing only reads PostgreSQL. refresh_and_export calls the inspected existing ZTF0455S Glue job, not a Step Function, after shared-job coordination and destination/script checks. Poll status; unknown dispatch must be reconciled and is never blindly retried. Completion returns result.referenceExport {key,prefix,sha256,rowCount}, without an approval flag. An administrator must review/approve this descriptor in PUT /integration. No cycle values or business approvals are invented. Source rows, credentials and durable snapshot bytes are not returned.";
}
paths["/api/workflows/prepaid/readiness"]!.get!.description =
  "Requires authentication and Prepaid module access, not run ownership. readyForUploads means upload-session schema is installed; it no longer requires financial processing configuration. readyForPreparation additionally requires valid complete effective integration configuration. configurationSource distinguishes a database override, approved built-in dev/sandbox defaults, or missing settings. An invalid explicit database row never falls back to defaults. Neither certifies runtime storage access or accounting/SAP acceptance. legacyBasis describes evidence, not executable or approved AWS settings.";
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
        "configurationSource",
        "readyForUploads",
        "readyForPreparation",
        "externalVerification",
        "checks",
      ],
      properties: {
        schemaInstalled: { type: "boolean" },
        referenceExportsAvailable: {
          type: "boolean",
          description:
            "Migration 009 admin reference capability is installed. Independent of existing approved external-reference upload readiness.",
        },
        integrationConfigured: { type: "boolean" },
        configurationSource: {
          type: "string",
          enum: ["database", "built_in", "missing"],
        },
        readyForUploads: { type: "boolean" },
        readyForPreparation: { type: "boolean" },
        externalVerification: { type: "string", enum: ["not_verified"] },
        legacyBasis: {
          type: "object",
          description:
            "Legacy job names, cycle-table evidence and implemented JV content; never auto-approved runtime settings.",
          required: ["ingestion", "freeze", "billingCycles", "journal"],
          properties: {
            ingestion: { type: "object", additionalProperties: true },
            freeze: { type: "object", additionalProperties: true },
            referenceSupply: { type: "object", additionalProperties: true },
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
  "/reference-versions",
  "get",
  "Administrator: list immutable PostgreSQL reference versions",
);
add(
  "/reference-versions",
  "post",
  "Administrator: import an approved reference version into PostgreSQL",
  {
    required: true,
    content: {
      "multipart/form-data": {
        schema: {
          type: "object",
          required: ["file", "metadata"],
          properties: {
            file: {
              type: "string",
              format: "binary",
              description:
                "Original 17-field SAP reference JSONL, at most 20 MiB.",
            },
            metadata: {
              type: "string",
              description:
                "JSON object: period, label, sha256, rowCount, approved=true, approvalScope (development-testing or accounting-accepted), provenance. Approval is explicit; period is a validation label, not evidence of historical applicability.",
            },
          },
        },
      },
    },
  },
  "201",
);
add(
  "/reference-versions/{checksum}/file",
  "get",
  "Administrator: export the exact original reference bytes for database transfer",
);
for (const path of [
  "/reference-versions",
  "/reference-versions/{checksum}/file",
])
  for (const method of ["get", "post"] as const) {
    const operation = paths[`/api/workflows/prepaid${path}`]?.[method];
    if (operation)
      operation.description =
        "Requires active administrator permission and Prepaid module access; migration 013 must be installed. Import validates original bytes, checksum, row count and SAP fields, then seals an append-only version. Existing versions and historical runs are never overwritten. No S3, Glue, SAP or Step Functions call is made. Import does not activate an integration configuration.";
  }
add(
  "/integration",
  "put",
  "Configure approved ingestion and manual report format (administrator only)",
  json({
    type: "object",
    required: ["expectedCycles", "format"],
    oneOf: [
      {
        required: ["ingestStateMachine"],
        properties: {
          preparationMode: { type: "string", enum: ["external_adapter"] },
        },
      },
      {
        required: ["preparationMode", "sourceExtraction"],
        oneOf: [
          { required: ["referenceVersion"] },
          { required: ["referenceExport"] },
        ],
        properties: {
          preparationMode: { type: "string", enum: ["native_sources"] },
          sourceExtraction: {
            type: "object",
            required: ["coverage"],
            properties: { coverage: { type: "string", enum: ["all_sources"] } },
          },
        },
      },
    ],
    properties: {
      ingestStateMachine: {
        type: "string",
        description:
          "Required for external_adapter mode only; must not name a partial source extractor.",
      },
      preparationMode: {
        type: "string",
        enum: ["external_adapter", "native_sources"],
        default: "external_adapter",
      },
      referenceExport: {
        type: "object",
        required: ["key", "prefix", "sha256", "rowCount", "approved"],
        properties: {
          key: { type: "string" },
          prefix: { type: "string" },
          sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
          rowCount: { type: "integer", minimum: 1 },
          approved: { type: "boolean", enum: [true] },
        },
        description:
          "Native mode uses an explicitly approved immutable legacy ZTF0455S JSONL export. Its hash/count and fields are validated; approval is not inferred.",
      },
      referenceVersion: {
        type: "object",
        additionalProperties: false,
        required: ["sha256", "rowCount", "approved"],
        properties: {
          sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
          rowCount: { type: "integer", minimum: 1, maximum: 250000 },
          approved: { type: "boolean", enum: [true] },
        },
        description:
          "Preferred for new native preparations. Pins an approved sealed version in this PostgreSQL database; no reference S3 dependency or automatic S3 fallback. Import the version before activation. Mutually exclusive with referenceExport.",
      },
      sourceExtraction: {
        type: "object",
        required: ["envPrefix", "sharedWritesApproved"],
        additionalProperties: false,
        description:
          "Optional unchanged native source extraction using only env_prefix. The backend validates/adapts uploaded inputs, then snapshots verified Glue raw-table output for the accounting calculations. No Portal* states or AWS script deployment required. The worker needs read access to the configured Glue database connection and its credential secret. Requires explicit approval for shared legacy raw-table writes and coordinated input folders. all_sources plus native_sources mode supplies the canonical backend producer; external_adapter mode still requires its V2 adapter.",
        properties: {
          envPrefix: {
            type: "string",
            pattern: "^[A-Za-z][A-Za-z0-9_-]{1,49}$",
          },
          resources: {
            type: "object",
            additionalProperties: false,
            required: ["scriptsBucket", "scriptsPrefix"],
            properties: {
              scriptsBucket: { type: "string" },
              scriptsPrefix: { type: "string" },
              stateMachines: {
                type: "object",
                additionalProperties: { type: "string" },
              },
              jobNamePrefix: { type: "string" },
              connectionName: { type: "string" },
            },
            description:
              "Required for a new envPrefix. Points to existing script copies and optional workflow/job/connection names in the target AWS account and AWS_REGION. Reviewed script hashes, source parsing, target-table and execution ownership checks remain enforced. Does not deploy or edit AWS definitions.",
          },
          coverage: {
            type: "string",
            enum: ["legacy_four", "all_sources"],
            default: "legacy_four",
          },
          sharedWritesApproved: { type: "boolean", enum: [true] },
          parallelism: {
            type: "integer",
            minimum: 1,
            maximum: 3,
            description:
              "Omitted retains serial extraction. Values 2 or 3 run disjoint native workflows in preparation-owned waves with verified script/library isolation and Glue run-ID ownership. Step Functions remain unchanged.",
          },
          egReportMapping: {
            type: "object",
            additionalProperties: false,
            required: ["profile", "approved"],
            description:
              "Optional mapping for the supplied sales-order Call Card EG and CFU Load Up EG layouts. No defaults: callcardScope explicitly authorizes EG report scope; loadupAmount selects the accounting basis. The backend adapts a checksummed working copy for unchanged Glue readers and retains originals. This is not accounting/output acceptance.",
            properties: {
              profile: { type: "string", enum: ["provided-eg-reports-v1"] },
              approved: { type: "boolean", enum: [true] },
              callcardScope: { type: "string", enum: ["eg_report"] },
              loadupAmount: { type: "string", enum: ["gross", "net_top_up"] },
            },
          },
        },
      },
      sourceSplitPolicy: {
        type: "string",
        enum: ["independent", "legacy_eg_total"],
        description:
          "Opt-in legacy EG source-total conservation; omitted means existing independent edits. Captured per snapshot.",
      },
      accountingProfile: {
        type: "string",
        enum: ["legacy_sql_v1"],
        description:
          "Versioned C012–C146 legacy calculation rules for new snapshots. Omitted retains historical calculations; saved/frozen snapshots are never rewritten.",
      },
      referenceValidationPolicy: {
        type: "string",
        enum: ["legacy_all_matches"],
        description:
          "Requires legacy_sql_v1 and an approved reference export. Retains all legacy reference matches and zero-rate quantity handling as warnings; reconciliation, missing mappings, layout and journal errors still block Freeze. Omitted keeps strict validation.",
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
      reportCycles: {
        type: "object",
        additionalProperties: false,
        required: ["adjustments", "charges"],
        description:
          "Optional native_sources-only independent report coverage. adjustments means 308; charges means 318. Each list must be nonempty and unique; their union must exactly equal expectedCycles. Omission retains paired coverage. Lists require source-period approval, not guesses from archived samples.",
        properties: {
          adjustments: {
            type: "array",
            minItems: 1,
            uniqueItems: true,
            items: { type: "string", pattern: "^[0-9]{2}$" },
          },
          charges: {
            type: "array",
            minItems: 1,
            uniqueItems: true,
            items: { type: "string", pattern: "^[0-9]{2}$" },
          },
        },
      },
      format: {
        description:
          "New manual reports use the user-confirmed XLSX file type. Existing delimited profiles are retained for immutable historical downloads. XLSX does not require delimiter, lineEnding or encoding. No automatic SAP delivery is enabled.",
        oneOf: [
          {
            type: "object",
            required: ["fileType", "profile", "approved"],
            properties: {
              fileType: { type: "string", enum: ["xlsx"] },
              profile: { type: "string", minLength: 1 },
              approved: { type: "boolean", enum: [true] },
              reversalSupported: { type: "boolean" },
            },
          },
          {
            type: "object",
            required: [
              "profile",
              "approved",
              "delimiter",
              "lineEnding",
              "encoding",
            ],
            properties: {
              fileType: { type: "string", enum: ["delimited"] },
              profile: { type: "string" },
              approved: { type: "boolean", enum: [true] },
              delimiter: { type: "string", enum: ["\t", "|", ","] },
              lineEnding: { type: "string", enum: ["\r\n", "\n"] },
              encoding: { type: "string", enum: ["utf8", "utf16le"] },
              reversalSupported: { type: "boolean" },
            },
          },
        ],
      },
    },
  }),
);
add(
  "/workspace/extractions",
  "get",
  "Read your configured source workflow executions and remaining external dependencies",
);
paths["/api/workflows/prepaid/workspace/extractions"]!.get!.description =
  "Read-only, scoped to your active upload session. Includes executions and the latest preparation summary (status, error, source_version, available_at and lease_until). Use the preparation id to correlate prepaid.extraction.progress and prepaid.preparation.failed server events; no AWS execution is started by this GET.";
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
paths["/api/workflows/prepaid/workspace"]!.get!.description =
  "Read-only owned workspace state. A run-linked upload session includes resetContext={runId,eg,sg}, even when run is null because sources are collecting or preparation failed. Submit that context with sessionId/sessionVersion to Reset; do not infer that a hidden review run has no regional versions. Reset/removal remain blocked during active preparation. Source removal detaches inputs; it does not delete original S3 objects or frozen reports.";
add(
  "/workspace/sources/{code}",
  "post",
  "Store an owned source before processing setup; queue only after approved setup and complete inputs",
  {
    required: true,
    content: {
      "multipart/form-data": {
        schema: {
          type: "object",
          required: ["file"],
          properties: {
            file: { type: "string", format: "binary" },
            uploadId: {
              type: "string",
              format: "uuid",
              description:
                "Optional retry identity. Reuse only for the same file bytes/source; replay returns its receipt without adding a version or preparation job.",
            },
          },
        },
      },
    },
  },
  "201",
);
// Preserve canonical names in existing clients; aliases are additive metadata.
const sourceRequirement: OpenAPIV3.SchemaObject = {
  type: "object",
  required: ["code", "fileName"],
  properties: {
    code: { type: "string" },
    fileName: {
      type: "string",
      description: "Canonical portal/native filename.",
    },
    acceptedFileNames: {
      type: "array",
      items: { type: "string" },
      description:
        "Optional exact case-insensitive accepted names, including canonical name. Restored legacy aliases: EG CALLCARD.xlsx and SG CALLCARD.xlsx. Aliases do not change worksheet/content validation or AWS landing names.",
    },
  },
};
paths["/api/workflows/prepaid/workspace"]!.get!.responses["200"] = {
  description:
    "Owned workspace; GET does not create sessions/jobs or bind configuration. Before processing setup, sources.collectionOnly=true, valid=false, accepted enumerates names allowed for storage, and guidelines describes the billing filename families. Accepted cycle codes are NOT approved required coverage. preparation.message explains that files may be uploaded now. A deployed worker binds complete configuration later without re-upload; out-of-coverage sources block queuing until explicitly removed. Existing configured sessions retain their snapshot.",
  content: {
    "application/json": {
      schema: {
        type: "object",
        properties: {
          sources: {
            type: "object",
            properties: {
              required: { type: "array", items: sourceRequirement },
              accepted: { type: "array", items: sourceRequirement },
              collectionOnly: { type: "boolean" },
              guidelines: { type: "array", items: { type: "string" } },
              unexpected: { type: "array", items: { type: "string" } },
              valid: {
                type: "boolean",
                description:
                  "False for collection-only sessions, even when all base inputs are stored. Not proof of valid workbook contents.",
              },
            },
          },
          preparation: {
            type: "object",
            properties: {
              configured: { type: "boolean" },
              message: { type: "string", nullable: true },
            },
          },
        },
      },
    },
  },
};
paths["/api/workflows/prepaid/runs/{runId}/sources"]!.get!.responses["200"] = {
  description:
    "Required sources, uploaded files and cycle completeness. Legacy filename aliases are additive metadata.",
  content: {
    "application/json": {
      schema: {
        type: "object",
        properties: {
          required: { type: "array", items: sourceRequirement },
        },
      },
    },
  },
};
add(
  "/workspace/sources/{code}",
  "delete",
  "Detach an owned session input without deleting source objects",
);
add(
  "/workspace/prepare",
  "post",
  "Start Prepaid processing for the uploaded reports",
);
paths["/api/workflows/prepaid/workspace/prepare"]!.post!.description =
  "AWS batch processing requires at least one uploaded report. Each 308 or 318 XLSX filename identifies its own cycle (01–31) using a final _NN or _BCNN suffix. The workbook cycle must agree with the filename. The non-AWS preparation path uses its configured coverage.";
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
zipPath.description =
  "Requires ownership and a frozen snapshot. XLSX profiles produce one workbook per region/revision with Layout, Allocation, Reconciliation and JV sheets; the JV retains the 40 legacy business columns. Decimal strings/account codes are literal Excel text, not formulas or rounded JS numbers. Existing frozen delimited profiles retain CSV/text output. ZIP/workbook bytes are deterministic. Synchronous workbook limits: 250,000 cells, 32 MiB cell text; oversized output returns 413 without truncation. This endpoint never posts to SAP.";
(zipPath.responses["413"] as OpenAPIV3.ResponseObject) = {
  description:
    "Report row, cell or byte bound exceeded; nothing was truncated.",
};
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
add("/aws-batch/{batchId}/reports/amaxee.xlsx", "get", "Download the current batch AMAXEE workbook");
paths["/api/workflows/prepaid/aws-batch/{batchId}/reports/amaxee.xlsx"]!.get!.responses["200"] = {
  description: "AMAXEE Excel workbook for the signed-in user's imported batch.",
  content: {
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {
      schema: { type: "string", format: "binary" },
    },
  },
};

export const prepaidOpenApiPaths = paths;
