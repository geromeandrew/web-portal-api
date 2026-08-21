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

Set the real RDS URL, JWT, administrator, Lambda, S3 bucket/region, IAM user access key, and upload-policy values in `.env` before starting the service. Processing Pipelines reads `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` from the API container only; attach least-privilege `s3:ListBucket` access on `S3_BUCKET`, `s3:GetObject` access on `S3_BUCKET/*`, `states:StartExecution`, `states:DescribeExecution`, and `states:DescribeStateMachine` access on mapped state-machine ARNs, and `sts:GetCallerIdentity` to that IAM user. Do not add AWS access keys to the frontend or commit them to `.env`.

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

## Docker Hub certificate error

If Docker reports that a certificate for another hostname (for example,
`securelogin.hpe.com`) was returned while pulling `node:22-alpine`, the failure is
caused by the host network proxy or certificate trust configuration, not this API
project. Do not disable Docker TLS verification. Ask IT for the corporate proxy root
certificate and proxy settings, install the certificate into **Local Computer >
Trusted Root Certification Authorities**, restart Docker Desktop, then verify with:

```bash
docker pull node:22-alpine
```

Docker Desktop imports trusted Windows certificate authorities for image pulls. See
[Docker's Windows certificate guidance](https://docs.docker.com/engine/network/ca-certs/)
for the secure setup steps.

## API documentation

Swagger UI is available at `/api/docs/` and the OpenAPI document is available at `/api/openapi.json` in every environment. By default it shows Health, Authentication, and Processing Pipelines only; this does not disable any routes. Set `OPENAPI_INCLUDE_NON_ESSENTIAL_ENDPOINTS=true` and restart the API to restore every endpoint in Swagger. The documentation itself is public, while protected operations require a JWT bearer token. Use `POST /api/auth/login` to obtain an access token, then select **Authorize** in Swagger UI and enter the token.

For a concise endpoint-by-endpoint test walkthrough, see the [Swagger testing guide](docs/SWAGGER_TESTING_GUIDE.md).
