# Web Portal API

Node 22 + TypeScript + Express API for the Web Portal. It owns PostgreSQL migrations, authentication, workflow state, upload metadata, and the integration with the existing Lambda upload endpoint.

## Configuration

Copy the matching environment template to `.env`; do not commit it.

- `.env.development.example` is for local Node development.
- `.env.production.example` is for EC2 Docker deployment.

For the production split, preserve the existing `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `JWT_SECRET`, administrator settings, Lambda URL, and upload policy from the former combined deployment. The default `POSTGRES_DATA_VOLUME` is `web-portal_postgres_data`, preserving the old Compose volume.

## Local development

Create the shared network once, then start PostgreSQL and the API stack:

```bash
docker network create web-portal-shared
pnpm install
pnpm env:local -- --force
docker compose up db -d
pnpm db:migrate
pnpm dev
```

`pnpm env:local` requires `LAMBDA_UPLOAD_URL` to be set in the shell. The database is mapped only to `127.0.0.1:5432` for local Node development.

## EC2 deployment

1. Back up the existing database.
2. Create `web-portal-shared` if it does not exist.
3. Copy the existing production values into `.env`, setting `POSTGRES_DATA_VOLUME=web-portal_postgres_data`.
4. Stop the former combined stack without `-v`.
5. Run `docker compose up --build -d` here, wait for `api` health, then deploy the sibling `web-portal` frontend repository.

The API has no host port. The frontend Nginx proxy reaches it through the private `web-portal-shared` Docker network.

## Commands

```bash
pnpm test
pnpm build
pnpm db:migrate
docker compose config
```
