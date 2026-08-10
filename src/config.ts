import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().url(),
  DATABASE_SCHEMA: z.string().regex(/^[a-z_][a-z0-9_]*$/, "must be a lowercase PostgreSQL identifier").default("web_portal"),
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default("8h"),
  ADMIN_EMAIL: z.string().email(),
  ADMIN_PASSWORD: z.string().min(12),
  LAMBDA_UPLOAD_URL: z.string().url(),
  S3_BUCKET: z.string().min(3),
  AWS_REGION: z.string().min(1),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(4_500_000),
  ALLOWED_MIME_TYPES: z.string().default("application/pdf,image/jpeg,image/png,image/webp,text/plain,application/zip,application/msword,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
  OPENAPI_INCLUDE_NON_ESSENTIAL_ENDPOINTS: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
});

export type Config = z.infer<typeof envSchema> & { allowedMimeTypes: string[] };

export function loadConfig(env = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid API configuration: ${parsed.error.issues.map((issue) => issue.path.join(".") + " " + issue.message).join(", ")}`);
  }
  return {
    ...parsed.data,
    LAMBDA_UPLOAD_URL: parsed.data.LAMBDA_UPLOAD_URL.replace(/\/$/, ""),
    allowedMimeTypes: parsed.data.ALLOWED_MIME_TYPES.split(",").map((value) => value.trim()).filter(Boolean),
  };
}
