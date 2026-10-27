import type { OpenAPIV3 } from "openapi-types";

const success = (summary: string): OpenAPIV3.OperationObject => ({
  summary,
  responses: { "200": { description: "Success." } },
});
const created = (summary: string): OpenAPIV3.OperationObject => ({
  summary,
  responses: { "201": { description: "Created." } },
});
const noContent = (summary: string): OpenAPIV3.OperationObject => ({
  summary,
  responses: { "204": { description: "No content." } },
});
const csv = (summary: string): OpenAPIV3.OperationObject => ({
  summary,
  responses: {
    "200": {
      description: "CSV download.",
      content: { "text/csv": { schema: { type: "string", format: "binary" } } },
    },
  },
});
const catalogueParameters: OpenAPIV3.ParameterObject[] = [
  { name: "domain", in: "query", schema: { type: "string" } },
  { name: "system", in: "query", schema: { type: "string" } },
  { name: "filePurpose", in: "query", schema: { type: "string" } },
  {
    name: "stage",
    in: "query",
    schema: {
      type: "string",
      enum: ["inbound", "outbound", "processed", "error"],
    },
  },
  { name: "hasJob", in: "query", schema: { type: "boolean" } },
  { name: "q", in: "query", schema: { type: "string" } },
  {
    name: "limit",
    in: "query",
    schema: { type: "integer", minimum: 1, maximum: 100 },
  },
  { name: "cursor", in: "query", schema: { type: "string" } },
];
const runParameters: OpenAPIV3.ParameterObject[] = [
  { name: "pipelineCode", in: "query", schema: { type: "string" } },
  {
    name: "stage",
    in: "query",
    schema: {
      type: "string",
      enum: ["inbound", "outbound", "processed", "error"],
    },
  },
  { name: "status", in: "query", schema: { type: "string" } },
  { name: "refresh", in: "query", schema: { type: "boolean", default: false } },
  {
    name: "limit",
    in: "query",
    schema: { type: "integer", minimum: 1, maximum: 25 },
  },
  { name: "cursor", in: "query", schema: { type: "string" } },
];
const nestedRunParameters = runParameters.filter(
  (parameter) => parameter.name !== "pipelineCode",
);
const jsonBody = (
  schema: OpenAPIV3.SchemaObject,
  description?: string,
): OpenAPIV3.RequestBodyObject => ({
  required: true,
  ...(description ? { description } : {}),
  content: { "application/json": { schema } },
});
const regionPath: OpenAPIV3.ParameterObject = {
  name: "region",
  in: "path",
  required: true,
  schema: { type: "string", enum: ["eg", "sg"] },
};
const pipelineCodePath: OpenAPIV3.ParameterObject = {
  name: "pipelineCode",
  in: "path",
  required: true,
  schema: { type: "string", example: "prepaid_reclass" },
};
const runIdPath: OpenAPIV3.ParameterObject = {
  name: "runId",
  in: "path",
  required: true,
  schema: { type: "string", format: "uuid" },
};
const expectedFileName: OpenAPIV3.ParameterObject = {
  name: "expectedFileName",
  in: "query",
  required: true,
  schema: { type: "string" },
};
const pipelineFileKey: OpenAPIV3.ParameterObject = {
  name: "key",
  in: "query",
  required: true,
  schema: { type: "string" },
};
const batchCycle: OpenAPIV3.ParameterObject = {
  name: "batchCycle",
  in: "query",
  required: true,
  schema: { type: "string", pattern: "^\\d{2}$", example: "01" },
};
const freezeLayoutBody = jsonBody({
  type: "object",
  required: ["frozen"],
  properties: { frozen: { type: "boolean" } },
});
const pipelineUploadBody: OpenAPIV3.RequestBodyObject = {
  required: true,
  content: {
    "multipart/form-data": {
      schema: {
        type: "object",
        required: ["expectedFileName", "file"],
        properties: {
          expectedFileName: { type: "string" },
          replace: {
            type: "string",
            enum: ["true", "false"],
            default: "false",
          },
          batchId: { type: "string", format: "uuid" },
          file: { type: "string", format: "binary" },
        },
      },
    },
  },
};
const startRunBody: OpenAPIV3.RequestBodyObject = {
  required: true,
  description:
    "Required file identity. The API resolves this exact configured filename to its mapped Step Functions state machine; it never starts an entire pipeline.",
  content: {
    "application/json": {
      schema: {
        type: "object",
        required: ["expectedFileName"],
        properties: {
          expectedFileName: {
            type: "string",
            example: "308. Billed Adjustments Monthly Summary Report_B_01.xlsx",
          },
        },
      },
      examples: {
        selectedFile: {
          summary:
            "Run the Step Functions state machine mapped to one uploaded Bayan bill-cycle file",
          value: {
            expectedFileName:
              "308. Billed Adjustments Monthly Summary Report_B_01.xlsx",
          },
        },
      },
    },
  },
};
const startBatchRunBody = jsonBody(
  {
    type: "object",
    required: ["batchCycle"],
    properties: {
      batchCycle: { type: "string", pattern: "^\\d{2}$", example: "01" },
    },
  },
  "Starts the mapped batch state machine only after every member file is available.",
);

const allOpenApiDocument: OpenAPIV3.Document = {
  openapi: "3.0.3",
  info: {
    title: "Web Portal API",
    version: "0.3.0",
    description: "Portal authentication, workflows, and processing pipelines.",
  },
  servers: [{ url: "/", description: "Current origin" }],
  tags: [
    { name: "Health" },
    { name: "Authentication" },
    { name: "Prepaid" },
    { name: "Memo" },
    { name: "Processing Pipelines" },
  ],
  paths: {
    "/api/healthz": {
      get: { ...success("Check API process availability"), security: [] },
    },
    "/api/auth/me": { get: success("Get current user") },
    "/api/workflows/prepaid/state": { get: success("Get Prepaid state") },
    "/api/workflows/prepaid/process": {
      post: created("Process Prepaid uploads"),
    },
    "/api/workflows/prepaid/layouts/{region}/reset": {
      post: { ...success("Reset layout"), parameters: [regionPath] },
    },
    "/api/workflows/prepaid/layouts/{region}/import": {
      post: { ...success("Refresh layout"), parameters: [regionPath] },
    },
    "/api/workflows/prepaid/layouts/{region}/freeze": {
      patch: {
        ...success("Set layout frozen state"),
        parameters: [regionPath],
        requestBody: freezeLayoutBody,
      },
    },
    "/api/workflows/prepaid/allocation/validate": {
      post: success("Validate allocation"),
    },
    "/api/workflows/prepaid/report.csv": {
      get: csv("Download Prepaid report"),
    },
    "/api/processing-pipelines": { get: success("List processing pipelines") },
    "/api/processing-pipelines/{pipelineCode}": {
      get: {
        ...success("Get processing pipeline details"),
        parameters: [pipelineCodePath],
      },
    },
    "/api/processing-pipelines/{pipelineCode}/requirements": {
      get: {
        ...success("List a pipeline's configured file requirements"),
        description:
          "Reads file configuration without accessing S3. Optional purpose=web-upload restricts the result to portal-uploadable requirements; omitted purpose retains all processing requirements.",
        parameters: [
          pipelineCodePath,
          {
            name: "purpose",
            in: "query",
            required: false,
            schema: { type: "string", enum: ["web-upload"] },
          },
        ],
      },
    },
    "/api/processing-pipelines/{pipelineCode}/execution-details": {
      get: {
        ...success("Get the resolved Step Functions execution preflight"),
        description:
          "Requires `expectedFileName`. Returns the exact configured execution input, source-file availability, and live state-machine metadata without exposing the workflow definition.",
        parameters: [pipelineCodePath, expectedFileName],
      },
    },
    "/api/processing-pipelines/{pipelineCode}/batch-execution-details": {
      get: {
        ...success("Get the resolved Step Functions batch execution preflight"),
        description:
          "Requires `batchCycle`. A complete source set runs the batch workflow; a non-empty partial set runs each available file's mapped workflow. Returns selected and missing files with live state-machine metadata.",
        parameters: [pipelineCodePath, batchCycle],
      },
    },
    "/api/processing-pipelines/{pipelineCode}/files": {
      get: {
        ...success("List configured pipeline files"),
        description:
          "Lists portal-uploadable files. APRM ICEXT output files belong to the downstream SFTP workflow and are excluded. ISMS IBOB uses the isms_ibob_actualization/inbound/ storage folder while retaining the isms_ibob_actzn pipeline identifier.",
        parameters: [pipelineCodePath],
      },
      post: {
        ...created("Upload a pipeline file"),
        description:
          "Uploads up to the fixed 200 MiB (209715200 bytes) per-file limit. SAP bill-cycle feeds require .txt; spreadsheet reports retain .XLSX. Files larger than this limit return 413 FILE_TOO_LARGE. APRM ICEXT output uploads return 400 PIPELINE_FILE_NOT_UPLOADABLE. Memo uploads accept any nonempty suffix after the final underscore with the mapped base and .xlsx extension. With batchId, the original filename must be in that batch's upload plan and is saved under its assigned _01, _02, etc. name, regardless of upload order. A Memo upload without batchId is assigned the next number from the current inbound inventory. Memo objects cannot be overwritten, including when replace=true; conflicting planned or concurrent writes return 409 PIPELINE_FILE_EXISTS. APRM Accrual accepts .xlsx names containing AUR (case-insensitive) and saves them as AUR Extract FINAL_BILLING.XLSX. Other pipelines retain their replace=true behavior.",
        responses: {
          "201": { description: "File uploaded." },
          "413": {
            description:
              "FILE_TOO_LARGE: exceeds the fixed 200 MiB per-file upload limit.",
          },
        },
        parameters: [pipelineCodePath],
        requestBody: pipelineUploadBody,
      },
      delete: {
        ...noContent("Delete a stored pipeline file"),
        description:
          "Requires access to the selected pipeline. Removes the current inbound object and marks matching upload history entries with removedAt, retaining the original readAt and uploader.",
        parameters: [pipelineCodePath, pipelineFileKey],
      },
    },
    "/api/processing-pipelines/{pipelineCode}/upload-batches": {
      get: {
        ...success("List mapped pipeline upload batches"),
        description:
          "Returns all uploaders' batches in the selected pipeline. Each file includes its objectKey, readAt timestamp and nullable removedAt timestamp. Requires access to that pipeline; adding files to a batch remains restricted to its owner.",
        parameters: [pipelineCodePath],
      },
      post: {
        ...created("Create a mapped pipeline upload batch"),
        parameters: [pipelineCodePath],
        description:
          "For memo_sst, requires a JSON files array containing every originalName and its configured expectedFileName (the _01 mapping). Valid MMDDYYYY suffixes sort oldest first, then other suffixes in natural order. Each mapped base continues after its highest numbered file currently in inbound; gaps are not reused. Numbering resets to _01 only when that base has no files left in inbound. Dates are sorted within each batch. A plan does not reserve names; if another batch takes a planned name before it is uploaded, the write returns 409 and the caller must create a fresh batch. Duplicate normalized names, invalid dates, unmapped bases and non-XLSX extensions return 400. The response includes batch and files (originalName, expectedFileName, savedFileName); upload the original files with that batchId. Other pipelines may omit the body.",
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["files"],
                properties: {
                  files: {
                    type: "array",
                    minItems: 1,
                    items: {
                      type: "object",
                      required: ["originalName", "expectedFileName"],
                      properties: {
                        originalName: {
                          type: "string",
                          example: "3PComms_10272026.xlsx",
                        },
                        expectedFileName: {
                          type: "string",
                          example: "3PComms_01.XLSX",
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/api/processing-pipelines/{pipelineCode}/files/content": {
      get: {
        ...success("Stream a pipeline file"),
        parameters: [pipelineCodePath, pipelineFileKey],
      },
    },
    "/api/processing-pipelines/{pipelineCode}/runs": {
      post: {
        ...created(
          "Start the Step Functions execution mapped to one specific pipeline file",
        ),
        description:
          "Requires `expectedFileName` in the request body. The file must be configured, already uploaded, and have a Step Functions mapping.",
        parameters: [pipelineCodePath],
        requestBody: startRunBody,
      },
    },
    "/api/processing-pipelines/{pipelineCode}/batch-runs": {
      post: {
        summary: "Start the Step Functions batch execution for one bill cycle",
        responses: {
          "201": { description: "All selected workflows started." },
          "207": {
            description:
              "At least one partial-run workflow started and at least one failed to start.",
          },
        },
        description:
          "Starts the batch workflow when all mapped files are present. Otherwise starts the individual workflow for each available file and reports missing files and per-file outcomes.",
        parameters: [pipelineCodePath],
        requestBody: startBatchRunBody,
      },
    },
    "/api/processing-pipelines/{pipelineCode}/runs/{runId}": {
      get: {
        ...success("Get detailed processing execution status"),
        parameters: [pipelineCodePath, runIdPath],
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description: "Okta OAuth 2.0 access token.",
      },
    },
  },
  security: [{ bearerAuth: [] }],
};

function tagForPath(path: string) {
  if (path === "/api/healthz") return "Health";
  if (path.startsWith("/api/auth/")) return "Authentication";
  if (path.startsWith("/api/workflows/prepaid")) return "Prepaid";
  return "Processing Pipelines";
}

for (const [path, pathItem] of Object.entries(allOpenApiDocument.paths)) {
  if (!pathItem || "$ref" in pathItem) continue;
  for (const operation of [
    pathItem.get,
    pathItem.post,
    pathItem.put,
    pathItem.patch,
    pathItem.delete,
  ]) {
    if (operation) operation.tags = [tagForPath(path)];
  }
}

const visibleByDefault = (path: string) =>
  path === "/api/healthz" ||
  path.startsWith("/api/auth/") ||
  path.startsWith("/api/processing-pipelines");

/**
 * Produces the Swagger document without changing the API routes themselves.
 * Set OPENAPI_INCLUDE_NON_ESSENTIAL_ENDPOINTS=true to restore every endpoint.
 */
export function createOpenApiDocument(
  includeNonEssentialEndpoints = false,
): OpenAPIV3.Document {
  const paths = Object.fromEntries(
    Object.entries(allOpenApiDocument.paths).filter(
      ([path]) => includeNonEssentialEndpoints || visibleByDefault(path),
    ),
  );
  const visibleTags = new Set<string>();
  for (const pathItem of Object.values(paths)) {
    if (!pathItem || "$ref" in pathItem) continue;
    for (const operation of [
      pathItem.get,
      pathItem.post,
      pathItem.put,
      pathItem.patch,
      pathItem.delete,
    ]) {
      operation?.tags?.forEach((tag) => visibleTags.add(tag));
    }
  }

  return {
    ...allOpenApiDocument,
    tags: allOpenApiDocument.tags?.filter((tag) => visibleTags.has(tag.name)),
    paths,
  };
}

export const openApiDocument = createOpenApiDocument();
