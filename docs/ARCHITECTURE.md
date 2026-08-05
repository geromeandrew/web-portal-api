# Architecture guide

The API is a small modular monolith. It is one Node.js process and one
PostgreSQL database, but each business area owns its own HTTP router.

## Request flow

`HTTP request → feature router → shared helpers → PostgreSQL or AWS → HTTP response`

- `src/app/createApp.ts` is the composition root. It configures Express and mounts every router.
- `src/app/dependencies.ts` documents everything the application needs from the outside world.
- `src/modules/<feature>/api/router.ts` contains one feature's endpoints.
- Root-level files such as `db.ts`, `auth.ts`, and `workspace.ts` are shared infrastructure helpers.

## Where to make a change

| Goal | Start here |
| --- | --- |
| Add an endpoint to an existing area | `src/modules/<feature>/api/router.ts` |
| Add a new business area | Create `src/modules/<feature>/api/router.ts`, then mount it in `createApp.ts` |
| Change authentication | `src/auth.ts` |
| Change database access | `src/db.ts`, `src/workspace.ts`, or the feature repository |
| Change API documentation | `src/openapi.ts` |
| Change environment settings | `src/config.ts` and the matching `.env.*.example` file |

## Beginner rules of thumb

1. Keep routers focused on HTTP work: read input, call helpers, return a response.
2. Keep SQL parameterized (`$1`, `$2`) and out of string interpolation.
3. Use `AppError` for expected client-facing errors; unexpected errors become `500` responses.
4. Update `openapi.ts` and tests whenever an endpoint contract changes.
5. Run `pnpm test` and `pnpm build` before sharing a change.
