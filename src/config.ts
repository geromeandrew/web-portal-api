import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().url().optional(),
  POSTGRES_DB: z.string().min(1).optional(),
  POSTGRES_USER: z.string().min(1).optional(),
  POSTGRES_PASSWORD: z.string().min(1).optional(),
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default("8h"),
  ADMIN_EMAIL: z.string().email(),
  ADMIN_PASSWORD: z.string().min(12),
  LAMBDA_UPLOAD_URL: z.string().url(),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(4_500_000),
  ALLOWED_MIME_TYPES: z.string().default("application/pdf,image/jpeg,image/png,image/webp,text/plain,application/zip,application/msword,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
});

export type Config = z.infer<typeof envSchema> & { allowedMimeTypes: string[] };

export function loadConfig(env = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid API configuration: ${parsed.error.issues.map((issue) => issue.path.join(".") + " " + issue.message).join(", ")}`);
  }
  const databaseUrl = parsed.data.DATABASE_URL ?? buildDatabaseUrl(parsed.data);
  if (!databaseUrl) throw new Error("Invalid API configuration: DATABASE_URL or POSTGRES_DB, POSTGRES_USER, and POSTGRES_PASSWORD are required.");
  return {
    ...parsed.data,
    DATABASE_URL: databaseUrl,
    LAMBDA_UPLOAD_URL: parsed.data.LAMBDA_UPLOAD_URL.replace(/\/$/, ""),
    allowedMimeTypes: parsed.data.ALLOWED_MIME_TYPES.split(",").map((value) => value.trim()).filter(Boolean),
  };
}

function buildDatabaseUrl(env: { POSTGRES_DB?: string; POSTGRES_USER?: string; POSTGRES_PASSWORD?: string }) {
  if (!env.POSTGRES_DB || !env.POSTGRES_USER || !env.POSTGRES_PASSWORD) return undefined;
  return `postgresql://${encodeURIComponent(env.POSTGRES_USER)}:${encodeURIComponent(env.POSTGRES_PASSWORD)}@127.0.0.1:5432/${encodeURIComponent(env.POSTGRES_DB)}`;
}
