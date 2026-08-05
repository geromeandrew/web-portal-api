# Web Portal API

Node 22 + TypeScript + Express API for the Web Portal. It owns PostgreSQL migrations, authentication, workflow state, upload metadata, and the integration with the existing Lambda upload endpoint.

New to this codebase? Read [the architecture guide](docs/ARCHITECTURE.md) before adding an endpoint.

## Configuration

Copy the matching environment template to `.env`; do not commit it.

- `.env.development.example` is for local Node development.
- `.env.production.example` is for Docker deployment.

Every environment connects to Amazon RDS through `DATABASE_URL` and uses the `web_portal` schema by default. URI-encode the password when constructing the URL; do not commit `.env`. The API verifies the RDS TLS certificate using the bundled AWS us-east-1 CA.

## Local development

Create the shared network once, then configure RDS and start the API:

```bash
docker network create web-portal-shared
pnpm install
cp .env.development.example .env
pnpm db:migrate
pnpm dev
```

Set the real RDS URL, JWT, administrator, Lambda, S3 bucket/region, IAM user access key, and upload-policy values in `.env` before starting the service. Processing Pipelines reads `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` from the API container only; attach least-privilege `s3:ListBucket` access on `S3_BUCKET`, `s3:GetObject` access on `S3_BUCKET/*`, `glue:StartJobRun` plus `glue:GetJobRun` access on mapped processing-job ARNs, and `logs:DescribeLogStreams` plus `logs:GetLogEvents` access on the Glue error log groups (`/aws-glue/jobs/error` and `/aws-glue/jobs/logs-v2`) to that IAM user. Do not add AWS access keys to the frontend or commit them to `.env`.

## EC2 deployment

1. Create `web-portal-shared` if it does not exist.
2. Copy the production template to `.env` and set the real RDS URL and application secrets.
3. Run `docker compose up --build -d` here; the migration service creates the fresh `web_portal` schema before the API starts.
4. Wait for API health, then deploy the sibling `web-portal` frontend repository.

The API has no host port. The frontend Nginx proxy reaches it through the private `web-portal-shared` Docker network. The former local PostgreSQL Docker volume is not deleted by this change.

## Commands

```bash
pnpm test
pnpm build
pnpm db:migrate
docker compose config
```

## API documentation

Swagger UI is available at `/api/docs/` and the OpenAPI document is available at `/api/openapi.json` in every environment. The documentation itself is public, while protected operations require a JWT bearer token. Use `POST /api/auth/login` to obtain an access token, then select **Authorize** in Swagger UI and enter the token.
