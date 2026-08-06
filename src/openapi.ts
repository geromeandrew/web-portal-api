import type { OpenAPIV3 } from "openapi-types";

const success = (summary: string): OpenAPIV3.OperationObject => ({ summary, responses: { "200": { description: "Success." } } });
const created = (summary: string): OpenAPIV3.OperationObject => ({ summary, responses: { "201": { description: "Created." } } });
const noContent = (summary: string): OpenAPIV3.OperationObject => ({ summary, responses: { "204": { description: "No content." } } });
const csv = (summary: string): OpenAPIV3.OperationObject => ({ summary, responses: { "200": { description: "CSV download.", content: { "text/csv": { schema: { type: "string", format: "binary" } } } } } });
const stage: OpenAPIV3.ParameterObject = { name: "stage", in: "query", required: true, schema: { type: "string", enum: ["inbound", "outbound", "processed", "error"] } };
const catalogueParameters: OpenAPIV3.ParameterObject[] = [
  { name: "domain", in: "query", schema: { type: "string" } }, { name: "system", in: "query", schema: { type: "string" } },
  { name: "filePurpose", in: "query", schema: { type: "string" } }, { name: "stage", in: "query", schema: { type: "string", enum: ["inbound", "outbound", "processed", "error"] } },
  { name: "hasJob", in: "query", schema: { type: "boolean" } }, { name: "q", in: "query", schema: { type: "string" } },
  { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } }, { name: "cursor", in: "query", schema: { type: "string" } },
];
const runParameters: OpenAPIV3.ParameterObject[] = [
  { name: "pipelineCode", in: "query", schema: { type: "string" } }, { name: "stage", in: "query", schema: { type: "string", enum: ["inbound", "outbound", "processed", "error"] } },
  { name: "status", in: "query", schema: { type: "string" } }, { name: "refresh", in: "query", schema: { type: "boolean", default: false } },
  { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 25 } }, { name: "cursor", in: "query", schema: { type: "string" } },
];
const nestedRunParameters = runParameters.filter((parameter) => parameter.name !== "pipelineCode");
const loginRequestBody: OpenAPIV3.RequestBodyObject = {
  required: true,
  description: "Credentials for an active portal user.",
  content: {
    "application/json": {
      schema: {
        type: "object",
        required: ["email", "password"],
        properties: {
          email: { type: "string", format: "email", example: "admin@portal.local" },
          password: { type: "string", format: "password", minLength: 1, example: "••••••••••••" },
        },
      },
    },
  },
};
const jsonBody = (schema: OpenAPIV3.SchemaObject, description?: string): OpenAPIV3.RequestBodyObject => ({ required: true, ...(description ? { description } : {}), content: { "application/json": { schema } } });
const uuidPath: OpenAPIV3.ParameterObject = { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } };
const regionPath: OpenAPIV3.ParameterObject = { name: "region", in: "path", required: true, schema: { type: "string", enum: ["eg", "sg"] } };
const pipelineCodePath: OpenAPIV3.ParameterObject = { name: "pipelineCode", in: "path", required: true, schema: { type: "string", example: "prepaid_reclass" } };
const jobRunIdPath: OpenAPIV3.ParameterObject = { name: "jobRunId", in: "path", required: true, schema: { type: "string", example: "jr_123456789" } };
const expectedFileName: OpenAPIV3.ParameterObject = { name: "expectedFileName", in: "query", required: true, schema: { type: "string" } };
const changePasswordBody = jsonBody({ type: "object", required: ["currentPassword", "newPassword"], properties: { currentPassword: { type: "string", format: "password" }, newPassword: { type: "string", format: "password", minLength: 12 } } });
const createUserBody = jsonBody({ type: "object", required: ["email", "temporaryPassword"], properties: { email: { type: "string", format: "email" }, temporaryPassword: { type: "string", format: "password", minLength: 12 } } });
const updateUserBody = jsonBody({ type: "object", properties: { isActive: { type: "boolean" }, temporaryPassword: { type: "string", format: "password", minLength: 12 } }, minProperties: 1 });
const freezeLayoutBody = jsonBody({ type: "object", required: ["frozen"], properties: { frozen: { type: "boolean" } } });
const workflowUploadBody: OpenAPIV3.RequestBodyObject = { required: true, content: { "multipart/form-data": { schema: { type: "object", required: ["workflow", "file"], properties: { workflow: { type: "string", enum: ["prepaid", "memo", "aprm"] }, slot: { type: "string", description: "Required for Prepaid uploads." }, file: { type: "string", format: "binary" } } } } } };
const pipelineUploadBody: OpenAPIV3.RequestBodyObject = { required: true, content: { "multipart/form-data": { schema: { type: "object", required: ["stage", "expectedFileName", "file"], properties: { stage: { type: "string", enum: ["inbound", "outbound", "processed", "error"] }, expectedFileName: { type: "string" }, replace: { type: "string", enum: ["true", "false"], default: "false" }, file: { type: "string", format: "binary" } } } } } };
const startRunBody: OpenAPIV3.RequestBodyObject = {
  required: true,
  description: "Required file identity. The API resolves this exact configured filename to its mapped Glue job; it never starts a job for an entire pipeline.",
  content: {
    "application/json": {
      schema: {
        type: "object",
        required: ["stage", "expectedFileName"],
        properties: {
          stage: { type: "string", enum: ["inbound", "outbound", "processed", "error"], example: "inbound" },
          expectedFileName: { type: "string", example: "308. Billed Adjustments Monthly Summary Report_B_01.xlsx" },
        },
      },
      examples: {
        selectedFile: {
          summary: "Run the Glue job mapped to one uploaded Bayan bill-cycle file",
          value: { stage: "inbound", expectedFileName: "308. Billed Adjustments Monthly Summary Report_B_01.xlsx" },
        },
      },
    },
  },
};

const document: OpenAPIV3.Document = {
  openapi: "3.0.3",
  info: { title: "Web Portal API", version: "0.3.0", description: "Portal authentication, workflows, and processing pipelines." },
  servers: [{ url: "/", description: "Current origin" }],
  tags: [{ name: "Health" }, { name: "Authentication" }, { name: "Administration" }, { name: "Uploads" }, { name: "Prepaid" }, { name: "Memo" }, { name: "Processing Pipelines" }],
  paths: {
    "/api/healthz": { get: { ...success("Check API and database availability"), security: [] } },
    "/api/auth/login": { post: { ...success("Sign in"), security: [], requestBody: loginRequestBody } },
    "/api/auth/logout": { post: noContent("Sign out") },
    "/api/auth/me": { get: success("Get current user") },
    "/api/auth/change-password": { post: { ...success("Change password"), requestBody: changePasswordBody } },
    "/api/admin/users": { get: success("List users"), post: { ...created("Create user"), requestBody: createUserBody } },
    "/api/admin/users/{id}": { patch: { ...success("Update user"), parameters: [uuidPath], requestBody: updateUserBody } },
    "/api/uploads": { post: { ...created("Upload a workflow file"), requestBody: workflowUploadBody } },
    "/api/uploads/{id}": { delete: { ...noContent("Delete upload metadata"), parameters: [uuidPath] } },
    "/api/workflows/prepaid/state": { get: success("Get Prepaid state") },
    "/api/workflows/prepaid/process": { post: created("Process Prepaid uploads") },
    "/api/workflows/prepaid/layouts/{region}/reset": { post: { ...success("Reset layout"), parameters: [regionPath] } },
    "/api/workflows/prepaid/layouts/{region}/import": { post: { ...success("Refresh layout"), parameters: [regionPath] } },
    "/api/workflows/prepaid/layouts/{region}/freeze": { patch: { ...success("Set layout frozen state"), parameters: [regionPath], requestBody: freezeLayoutBody } },
    "/api/workflows/prepaid/allocation/validate": { post: success("Validate allocation") },
    "/api/workflows/prepaid/report.csv": { get: csv("Download Prepaid report") },
    "/api/workflows/memo/state": { get: success("Get Memo state") },
    "/api/workflows/memo/errors.csv": { get: csv("Download Memo exceptions") },
    "/api/processing-pipelines": { get: success("List processing pipelines and stages") },
    "/api/processing-pipelines/{pipelineCode}": { get: { ...success("Get processing pipeline details"), parameters: [pipelineCodePath] } },
    "/api/processing-pipelines/{pipelineCode}/requirements": { get: { ...success("List a pipeline's configured file requirements"), parameters: [pipelineCodePath, stage] } },
    "/api/processing-pipelines/{pipelineCode}/files": { get: { ...success("List configured pipeline files"), parameters: [pipelineCodePath, stage] }, post: { ...created("Upload a pipeline file"), parameters: [pipelineCodePath], requestBody: pipelineUploadBody } },
    "/api/processing-pipelines/{pipelineCode}/files/content": { get: { ...success("Stream a pipeline file"), parameters: [pipelineCodePath, stage, { name: "key", in: "query", required: true, schema: { type: "string" } }] } },
    "/api/processing-pipelines/{pipelineCode}/runs": { post: { ...created("Start the job mapped to one specific pipeline file"), description: "Requires `stage` and `expectedFileName` in the request body. The file must be configured, already uploaded, and have a Glue job mapping.", parameters: [pipelineCodePath], requestBody: startRunBody } },
    "/api/processing-pipelines/{pipelineCode}/runs/{jobRunId}": { get: { ...success("Get processing job status"), parameters: [pipelineCodePath, jobRunIdPath, stage, expectedFileName] } },
  },
  components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } } },
  security: [{ bearerAuth: [] }],
};

function tagForPath(path: string) {
  if (path === "/api/healthz") return "Health";
  if (path.startsWith("/api/auth/")) return "Authentication";
  if (path.startsWith("/api/admin/")) return "Administration";
  if (path.startsWith("/api/uploads")) return "Uploads";
  if (path.startsWith("/api/workflows/prepaid")) return "Prepaid";
  if (path.startsWith("/api/workflows/memo")) return "Memo";
  return "Processing Pipelines";
}

for (const [path, pathItem] of Object.entries(document.paths)) {
  if (!pathItem || "$ref" in pathItem) continue;
  for (const operation of [pathItem.get, pathItem.post, pathItem.put, pathItem.patch, pathItem.delete]) {
    if (operation) operation.tags = [tagForPath(path)];
  }
}

export const openApiDocument = document;
