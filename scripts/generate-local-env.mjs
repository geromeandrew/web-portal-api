import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const target = resolve(".env");
if (existsSync(target) && !process.argv.includes("--force")) {
  console.error("Refusing to overwrite .env. Re-run with --force after backing up anything you need.");
  process.exit(1);
}

const lambdaUrl = process.env.LAMBDA_UPLOAD_URL;
if (!lambdaUrl) {
  console.error("Set LAMBDA_UPLOAD_URL before generating local configuration.");
  process.exit(1);
}

const secret = (bytes = 24) => randomBytes(bytes).toString("base64url");
const databasePassword = secret();
const lines = [
  "# Generated local API configuration. Keep this file private.",
  "NODE_ENV=development",
  "PORT=3001",
  "POSTGRES_DB=web_portal",
  "POSTGRES_USER=web_portal",
  `POSTGRES_PASSWORD=${databasePassword}`,
  "POSTGRES_DATA_VOLUME=web-portal-api-local-postgres-data",
  `DATABASE_URL=postgresql://web_portal:${databasePassword}@127.0.0.1:5432/web_portal`,
  `JWT_SECRET=${secret(48)}`,
  "JWT_EXPIRES_IN=8h",
  "ADMIN_EMAIL=admin@portal.local",
  `ADMIN_PASSWORD=${secret()}`,
  `LAMBDA_UPLOAD_URL=${lambdaUrl}`,
  "MAX_UPLOAD_BYTES=4500000",
  "ALLOWED_MIME_TYPES=application/pdf,image/jpeg,image/png,image/webp,text/plain,application/zip,application/msword,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "",
];
writeFileSync(target, lines.join("\n"), { encoding: "utf8", mode: 0o600 });
console.log("Created .env with generated local credentials. Read ADMIN_PASSWORD from that file to sign in.");
