import { z } from "zod";

const envSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    PORT: z.coerce.number().int().positive().default(3001),
    DATABASE_URL: z.string().url(),
    DATABASE_SSL: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),
    DATABASE_SCHEMA: z
      .string()
      .regex(/^[a-z_][a-z0-9_]*$/, "must be a lowercase PostgreSQL identifier")
      .default("web_portal"),
    OKTA_ISSUER: z
      .string()
      .url()
      .default("https://globemfa.okta.com/oauth2/default")
      .transform((value) => value.replace(/\/$/, ""))
      .refine(
        (value) => new URL(value).pathname.startsWith("/oauth2/"),
        "must identify a custom Okta authorization server",
      ),
    OKTA_AUDIENCE: z.string().min(1).default("api://default"),
    OKTA_CLIENT_ID: z.string().min(1).default("0oa28rfcq0h2ZSAvZ0h8"),
    RATE_LIMIT_HMAC_SECRET: z.string().min(32),
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
    S3_BUCKET: z.string().min(3),
    AWS_REGION: z.string().min(1),
    AWS_LOCAL: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    AWS_ACCESS_KEY_ID: z.string().min(1).optional(),
    AWS_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(4_500_000),
    OPENAPI_INCLUDE_NON_ESSENTIAL_ENDPOINTS: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
  })
  .superRefine((config, context) => {
    if (!config.AWS_LOCAL) return;
    if (!config.AWS_ACCESS_KEY_ID) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["AWS_ACCESS_KEY_ID"],
        message: "is required when AWS_LOCAL is true",
      });
    }
    if (!config.AWS_SECRET_ACCESS_KEY) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["AWS_SECRET_ACCESS_KEY"],
        message: "is required when AWS_LOCAL is true",
      });
    }
  });

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(
      `Invalid API configuration: ${parsed.error.issues.map((issue) => issue.path.join(".") + " " + issue.message).join(", ")}`,
    );
  }
  return {
    ...parsed.data,
  };
}
