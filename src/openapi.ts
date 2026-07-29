import type { OpenAPIV3 } from "openapi-types";

const json = (schema: OpenAPIV3.ReferenceObject | OpenAPIV3.SchemaObject): OpenAPIV3.MediaTypeObject => ({ schema });
const csv: OpenAPIV3.MediaTypeObject = { schema: { type: "string", format: "binary" } };
const errorResponse: OpenAPIV3.ResponseObject = {
  description: "Request failed.",
  content: { "application/json": json({ $ref: "#/components/schemas/ApiError" }) },
};

export const openApiDocument: OpenAPIV3.Document = {
  openapi: "3.0.3",
  info: {
    title: "Web Portal API",
    version: "0.1.0",
    description: "API for Web Portal authentication, administration, uploads, and workflow operations.",
  },
  servers: [{ url: "/", description: "Current origin" }],
  tags: [
    { name: "Health" },
    { name: "Authentication" },
    { name: "Administration" },
    { name: "Uploads" },
    { name: "Prepaid" },
    { name: "Memo" },
  ],
  paths: {
    "/api/healthz": {
      get: { tags: ["Health"], summary: "Check API and database availability", security: [], responses: { "200": { description: "API is healthy.", content: { "application/json": json({ type: "object", required: ["status"], properties: { status: { type: "string", example: "ok" } } }) } }, "500": errorResponse } },
    },
    "/api/auth/login": {
      post: { tags: ["Authentication"], summary: "Sign in and receive a bearer token", security: [], requestBody: { required: true, content: { "application/json": json({ $ref: "#/components/schemas/LoginRequest" }) } }, responses: { "200": { description: "Authenticated user and access token.", content: { "application/json": json({ $ref: "#/components/schemas/AuthResponse" }) } }, "401": errorResponse, "400": errorResponse } },
    },
    "/api/auth/logout": {
      post: { tags: ["Authentication"], summary: "End the current client session", responses: { "204": { description: "Session ended." }, "401": errorResponse } },
    },
    "/api/auth/me": {
      get: { tags: ["Authentication"], summary: "Get the authenticated user", responses: { "200": { description: "Current user.", content: { "application/json": json({ type: "object", required: ["user"], properties: { user: { $ref: "#/components/schemas/User" } } }) } }, "401": errorResponse } },
    },
    "/api/auth/change-password": {
      post: { tags: ["Authentication"], summary: "Change password and refresh the access token", requestBody: { required: true, content: { "application/json": json({ $ref: "#/components/schemas/ChangePasswordRequest" }) } }, responses: { "200": { description: "Updated user and refreshed access token.", content: { "application/json": json({ $ref: "#/components/schemas/AuthResponse" }) } }, "400": errorResponse, "401": errorResponse } },
    },
    "/api/admin/users": {
      get: { tags: ["Administration"], summary: "List users", description: "Bootstrap administrator only.", responses: { "200": { description: "Users ordered by creation date.", content: { "application/json": json({ type: "object", required: ["users"], properties: { users: { type: "array", items: { $ref: "#/components/schemas/User" } } } }) } }, "401": errorResponse, "403": errorResponse } },
      post: { tags: ["Administration"], summary: "Create a user", description: "Bootstrap administrator only. The user must change the temporary password.", requestBody: { required: true, content: { "application/json": json({ $ref: "#/components/schemas/CreateUserRequest" }) } }, responses: { "201": { description: "User created.", content: { "application/json": json({ type: "object", required: ["user"], properties: { user: { $ref: "#/components/schemas/User" } } }) } }, "400": errorResponse, "401": errorResponse, "403": errorResponse, "409": errorResponse } },
    },
    "/api/admin/users/{id}": {
      patch: { tags: ["Administration"], summary: "Update a user", description: "Bootstrap administrator only. At least one field is required.", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }], requestBody: { required: true, content: { "application/json": json({ $ref: "#/components/schemas/UpdateUserRequest" }) } }, responses: { "200": { description: "Updated user.", content: { "application/json": json({ type: "object", required: ["user"], properties: { user: { $ref: "#/components/schemas/User" } } }) } }, "400": errorResponse, "401": errorResponse, "403": errorResponse, "404": errorResponse } },
    },
    "/api/upload-policy": {
      get: { tags: ["Uploads"], summary: "Get upload limits and allowed MIME types", responses: { "200": { description: "Upload policy.", content: { "application/json": json({ $ref: "#/components/schemas/UploadPolicy" }) } }, "401": errorResponse } },
    },
    "/api/uploads": {
      get: { tags: ["Uploads"], summary: "List the authenticated user's uploads", parameters: [{ name: "workflow", in: "query", schema: { type: "string", enum: ["prepaid", "memo", "aprm"] } }], responses: { "200": { description: "Uploads in the user's workspace.", content: { "application/json": json({ type: "object", required: ["uploads"], properties: { uploads: { type: "array", items: { $ref: "#/components/schemas/Upload" } } } }) } }, "401": errorResponse } },
      post: { tags: ["Uploads"], summary: "Upload a workflow file", requestBody: { required: true, content: { "multipart/form-data": { schema: { type: "object", required: ["file", "workflow"], properties: { file: { type: "string", format: "binary" }, workflow: { type: "string", enum: ["prepaid", "memo", "aprm"] }, slot: { type: "string", minLength: 1, maxLength: 160, description: "Required for Prepaid uploads." } } } } } }, responses: { "201": { description: "Upload recorded.", content: { "application/json": json({ type: "object", required: ["upload"], properties: { upload: { $ref: "#/components/schemas/Upload" } } }) } }, "400": errorResponse, "401": errorResponse, "413": errorResponse, "415": errorResponse, "502": errorResponse } },
    },
    "/api/uploads/{id}": {
      delete: { tags: ["Uploads"], summary: "Delete upload metadata", description: "The Lambda-owned uploaded object is retained.", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "204": { description: "Upload metadata deleted." }, "401": errorResponse, "404": errorResponse } },
    },
    "/api/workflows/prepaid/state": {
      get: { tags: ["Prepaid"], summary: "Get Prepaid workflow state", responses: { "200": { description: "Current layouts, allocation, journal voucher, source-file requirements, and uploads.", content: { "application/json": json({ $ref: "#/components/schemas/PrepaidState" }) } }, "401": errorResponse } },
    },
    "/api/workflows/prepaid/process": {
      post: { tags: ["Prepaid"], summary: "Process Prepaid uploads", description: "All required Prepaid source-file slots must be uploaded first.", responses: { "201": { description: "Completed workflow run.", content: { "application/json": json({ type: "object", required: ["run"], properties: { run: { $ref: "#/components/schemas/WorkflowRun" } } }) } }, "400": errorResponse, "401": errorResponse } },
    },
    "/api/workflows/prepaid/layouts/{region}/reset": {
      post: { tags: ["Prepaid"], summary: "Unfreeze a Prepaid layout", parameters: [{ name: "region", in: "path", required: true, schema: { type: "string", enum: ["eg", "sg"] } }], responses: { "200": { description: "Updated layout.", content: { "application/json": json({ type: "object", required: ["layout"], properties: { layout: { $ref: "#/components/schemas/Layout" } } }) } }, "400": errorResponse, "401": errorResponse } },
    },
    "/api/workflows/prepaid/layouts/{region}/import": {
      post: { tags: ["Prepaid"], summary: "Refresh a Prepaid layout", parameters: [{ name: "region", in: "path", required: true, schema: { type: "string", enum: ["eg", "sg"] } }], responses: { "200": { description: "Current layout snapshot.", content: { "application/json": json({ type: "object", required: ["layout", "message"], properties: { layout: { $ref: "#/components/schemas/Layout" }, message: { type: "string" } } }) } }, "400": errorResponse, "401": errorResponse } },
    },
    "/api/workflows/prepaid/layouts/{region}/freeze": {
      patch: { tags: ["Prepaid"], summary: "Set a Prepaid layout's frozen state", parameters: [{ name: "region", in: "path", required: true, schema: { type: "string", enum: ["eg", "sg"] } }], requestBody: { required: true, content: { "application/json": json({ type: "object", required: ["frozen"], properties: { frozen: { type: "boolean" } } }) } }, responses: { "200": { description: "Updated layout.", content: { "application/json": json({ type: "object", required: ["layout"], properties: { layout: { $ref: "#/components/schemas/Layout" } } }) } }, "400": errorResponse, "401": errorResponse } },
    },
    "/api/workflows/prepaid/allocation/validate": {
      post: { tags: ["Prepaid"], summary: "Validate the Prepaid allocation", responses: { "200": { description: "Validation result.", content: { "application/json": json({ type: "object", required: ["validation"], properties: { validation: { $ref: "#/components/schemas/Validation" } } }) } }, "401": errorResponse } },
    },
    "/api/workflows/prepaid/report.csv": {
      get: { tags: ["Prepaid"], summary: "Download the Prepaid report as CSV", responses: { "200": { description: "CSV report attachment.", headers: { "Content-Disposition": { schema: { type: "string" }, description: "Attachment filename." } }, content: { "text/csv": csv } }, "401": errorResponse } },
    },
    "/api/workflows/memo/state": {
      get: { tags: ["Memo"], summary: "Get Memo workflow state", responses: { "200": { description: "Memo errors and uploads.", content: { "application/json": json({ $ref: "#/components/schemas/MemoState" }) } }, "401": errorResponse } },
    },
    "/api/workflows/memo/errors.csv": {
      get: { tags: ["Memo"], summary: "Download Memo exceptions as CSV", responses: { "200": { description: "CSV exceptions attachment.", headers: { "Content-Disposition": { schema: { type: "string" }, description: "Attachment filename." } }, content: { "text/csv": csv } }, "401": errorResponse } },
    },
  },
  components: {
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
    schemas: {
      ApiError: { type: "object", required: ["error"], properties: { error: { type: "object", required: ["code", "message"], properties: { code: { type: "string" }, message: { type: "string" }, fields: { type: "object", additionalProperties: { type: "string" } } } } } },
      User: { type: "object", required: ["id", "email", "isBootstrapAdmin", "isActive", "mustChangePassword", "createdAt"], properties: { id: { type: "string", format: "uuid" }, email: { type: "string", format: "email" }, isBootstrapAdmin: { type: "boolean" }, isActive: { type: "boolean" }, mustChangePassword: { type: "boolean" }, createdAt: { type: "string", format: "date-time" } } },
      LoginRequest: { type: "object", required: ["email", "password"], properties: { email: { type: "string", format: "email" }, password: { type: "string", minLength: 1 } } },
      ChangePasswordRequest: { type: "object", required: ["currentPassword", "newPassword"], properties: { currentPassword: { type: "string", minLength: 1 }, newPassword: { type: "string", minLength: 12, maxLength: 256 } } },
      CreateUserRequest: { type: "object", required: ["email", "temporaryPassword"], properties: { email: { type: "string", format: "email" }, temporaryPassword: { type: "string", minLength: 12, maxLength: 256 } } },
      UpdateUserRequest: { type: "object", minProperties: 1, properties: { isActive: { type: "boolean" }, temporaryPassword: { type: "string", minLength: 12, maxLength: 256 } } },
      AuthResponse: { type: "object", required: ["accessToken", "user"], properties: { accessToken: { type: "string" }, user: { $ref: "#/components/schemas/User" } } },
      UploadPolicy: { type: "object", required: ["maxFileSizeBytes", "allowedMimeTypes"], properties: { maxFileSizeBytes: { type: "integer", format: "int32", example: 4500000 }, allowedMimeTypes: { type: "array", items: { type: "string" } } } },
      Upload: { type: "object", required: ["id", "workflow", "originalName", "objectKey", "size", "contentType", "uploadedAt"], properties: { id: { type: "string", format: "uuid" }, workflow: { type: "string", enum: ["prepaid", "memo", "aprm"] }, slot: { type: "string" }, originalName: { type: "string" }, objectKey: { type: "string" }, size: { type: "integer", format: "int64" }, contentType: { type: "string" }, uploadedAt: { type: "string", format: "date-time" } } },
      Layout: { type: "object", required: ["frozen", "rows"], properties: { frozen: { type: "boolean" }, rows: { type: "array", items: { type: "array", items: { type: "string" } } } } },
      TableData: { type: "object", required: ["rows"], properties: { rows: { type: "array", items: { type: "array", items: { type: "string" } } } } },
      PrepaidState: { type: "object", required: ["egLayout", "sgLayout", "allocation", "jv", "report", "sourceFiles", "uploads"], properties: { egLayout: { $ref: "#/components/schemas/Layout" }, sgLayout: { $ref: "#/components/schemas/Layout" }, allocation: { allOf: [{ $ref: "#/components/schemas/TableData" }, { type: "object", properties: { lastValidation: { nullable: true, allOf: [{ $ref: "#/components/schemas/Validation" }] } } }] }, jv: { $ref: "#/components/schemas/TableData" }, report: { type: "object", required: ["name", "csv"], properties: { name: { type: "string" }, csv: { type: "string" } } }, sourceFiles: { type: "object", required: ["expected"], properties: { expected: { type: "array", items: { type: "string" } } } }, uploads: { type: "array", items: { $ref: "#/components/schemas/Upload" } } } },
      WorkflowRun: { type: "object", required: ["id", "status", "completedAt"], properties: { id: { type: "string", format: "uuid" }, status: { type: "string", example: "completed" }, completedAt: { type: "string", format: "date-time" } } },
      Validation: { type: "object", required: ["status", "validatedAt"], properties: { status: { type: "string", example: "valid" }, validatedAt: { type: "string", format: "date-time" } } },
      MemoState: { type: "object", required: ["errors", "uploads"], properties: { errors: { type: "object", required: ["headers", "rows"], properties: { headers: { type: "array", items: { type: "string" } }, rows: { type: "array", items: { type: "array", items: { type: "string" } } } } }, uploads: { type: "array", items: { $ref: "#/components/schemas/Upload" } } } },
    },
  },
  security: [{ bearerAuth: [] }],
};
