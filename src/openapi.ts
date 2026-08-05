import type { OpenAPIV3 } from "openapi-types";

const success = (summary: string): OpenAPIV3.OperationObject => ({ summary, responses: { "200": { description: "Success." } } });
const created = (summary: string): OpenAPIV3.OperationObject => ({ summary, responses: { "201": { description: "Created." } } });
const noContent = (summary: string): OpenAPIV3.OperationObject => ({ summary, responses: { "204": { description: "No content." } } });
const csv = (summary: string): OpenAPIV3.OperationObject => ({ summary, responses: { "200": { description: "CSV download.", content: { "text/csv": { schema: { type: "string", format: "binary" } } } } } });
const stage: OpenAPIV3.ParameterObject = { name: "stage", in: "query", required: true, schema: { type: "string", enum: ["inbound", "outbound", "processed", "error"] } };

export const openApiDocument: OpenAPIV3.Document = {
  openapi: "3.0.3",
  info: { title: "Web Portal API", version: "0.2.0", description: "Portal authentication, workflows, and processing pipelines." },
  servers: [{ url: "/", description: "Current origin" }],
  tags: [{ name: "Health" }, { name: "Authentication" }, { name: "Administration" }, { name: "Uploads" }, { name: "Prepaid" }, { name: "Memo" }, { name: "Processing Pipelines" }],
  paths: {
    "/api/healthz": { get: { ...success("Check API and database availability"), security: [] } },
    "/api/auth/login": { post: { ...success("Sign in"), security: [] } },
    "/api/auth/logout": { post: noContent("Sign out") },
    "/api/auth/me": { get: success("Get current user") },
    "/api/auth/change-password": { post: success("Change password") },
    "/api/admin/users": { get: success("List users"), post: created("Create user") },
    "/api/admin/users/{id}": { patch: success("Update user") },
    "/api/uploads": { post: created("Upload a workflow file") },
    "/api/uploads/{id}": { delete: noContent("Delete upload metadata") },
    "/api/workflows/prepaid/state": { get: success("Get Prepaid state") },
    "/api/workflows/prepaid/process": { post: created("Process Prepaid uploads") },
    "/api/workflows/prepaid/layouts/{region}/reset": { post: success("Reset layout") },
    "/api/workflows/prepaid/layouts/{region}/import": { post: success("Refresh layout") },
    "/api/workflows/prepaid/layouts/{region}/freeze": { patch: success("Set layout frozen state") },
    "/api/workflows/prepaid/allocation/validate": { post: success("Validate allocation") },
    "/api/workflows/prepaid/report.csv": { get: csv("Download Prepaid report") },
    "/api/workflows/memo/state": { get: success("Get Memo state") },
    "/api/workflows/memo/errors.csv": { get: csv("Download Memo exceptions") },
    "/api/processing-pipelines": { get: success("List processing pipelines and stages") },
    "/api/processing-pipelines/{pipelineCode}/files": { get: { ...success("List configured pipeline files"), parameters: [stage] }, post: created("Upload a pipeline file") },
    "/api/processing-pipelines/{pipelineCode}/files/content": { get: { ...success("Stream a pipeline file"), parameters: [stage, { name: "key", in: "query", required: true, schema: { type: "string" } }] } },
    "/api/processing-pipelines/{pipelineCode}/runs": { post: created("Start a processing job") },
    "/api/processing-pipelines/{pipelineCode}/runs/{jobRunId}": { get: success("Get processing job status") },
  },
  components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } } },
  security: [{ bearerAuth: [] }],
};
