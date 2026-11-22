import type { Pool } from "pg";
import { setTimeout as delay } from "node:timers/promises";
import type { Config } from "./config.js";
import type { Logger } from "./platform/logger.js";
import { migrations } from "./migrations.js";
import { migratePrepaid } from "./modules/prepaid/infrastructure/migrationRunner.js";
import { prepaidFullBatchPrefix } from "./modules/prepaid/application/fullBatch.js";

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
export async function runMigrations(
  pool: Pool,
  config: Config,
  logger: Logger,
  signal?: AbortSignal,
  entries: readonly { id: string; sql: string }[] = migrations,
  includePrepaid = false,
) {
  const logContext = {
    databaseUser: config.DATABASE_USER,
    databaseName: config.DATABASE_NAME,
    databaseSchema: config.DATABASE_SCHEMA,
  };
  signal?.throwIfAborted();
  const client = await pool.connect();
  let destroyed = false;
  let backendPid: number | undefined;
  let cancelling: Promise<void> | undefined;
  const abort = () => {
    cancelling ??= (async () => {
      try {
        if (backendPid)
          await pool.query("SELECT pg_cancel_backend($1)", [backendPid]);
      } finally {
        if (!destroyed) {
          destroyed = true;
          client.release(true);
        }
      }
    })().catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  const key = `esatp:migrations:${config.DATABASE_NAME}:${config.DATABASE_SCHEMA}`;
  let locked = false;
  try {
    signal?.throwIfAborted();
    backendPid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0]
      .pid;
    signal?.throwIfAborted();
    const timeout = config.MIGRATION_LOCK_TIMEOUT_MS ?? 60000;
    const deadline = Date.now() + timeout;
    while (!locked) {
      signal?.throwIfAborted();
      const result = await client.query(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
        [key],
      );
      locked = result.rows[0].locked === true;
      if (!locked) {
        if (Date.now() >= deadline)
          throw Object.assign(new Error("Migration lock timeout."), {
            name: "MigrationLockTimeoutError",
          });
        await delay(
          Math.min(100, Math.max(1, deadline - Date.now())),
          undefined,
          { signal },
        );
      }
    }
    await client.query(
      "SELECT set_config('statement_timeout', $1, false), set_config('lock_timeout', $2, false)",
      [
        String(config.MIGRATION_STATEMENT_TIMEOUT_MS ?? 300000),
        String(timeout),
      ],
    );
    await client.query(
      `CREATE SCHEMA IF NOT EXISTS ${quote(config.DATABASE_SCHEMA)}`,
    );
    await client.query(
      `SET search_path TO ${quote(config.DATABASE_SCHEMA)}, public`,
    );
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    for (const migration of entries) {
      signal?.throwIfAborted();
      if (
        (
          await client.query("SELECT 1 FROM schema_migrations WHERE id = $1", [
            migration.id,
          ])
        ).rowCount
      )
        continue;
      await client.query("BEGIN");
      try {
        logger.info("database.migration_started", {
          migrationId: migration.id,
          ...logContext,
        });
        await client.query(migration.sql);
        signal?.throwIfAborted();
        await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [
          migration.id,
        ]);
        await client.query("COMMIT");
        logger.info("database.migration_applied", {
          migrationId: migration.id,
          ...logContext,
        });
      } catch (error) {
        if (!destroyed) await client.query("ROLLBACK").catch(() => {});
        logger.error("database.migration_failed", {
          migrationId: migration.id,
          ...logContext,
        });
        throw error;
      }
    }
    if (includePrepaid) {
      signal?.throwIfAborted();
      await client.query("BEGIN");
      try {
        const applied = await migratePrepaid(
          client,
          config.DATABASE_SCHEMA,
          undefined,
          Boolean(prepaidFullBatchPrefix(config)),
        );
        signal?.throwIfAborted();
        await client.query("COMMIT");
        for (const migrationId of applied)
          logger.info("database.migration_applied", {
            migrationId,
            ...logContext,
          });
      } catch (error) {
        if (!destroyed) await client.query("ROLLBACK").catch(() => {});
        logger.error("database.prepaid_migrations_failed", logContext);
        throw error;
      }
    }
    logger.info("database.migrations_current", logContext);
  } finally {
    signal?.removeEventListener("abort", abort);
    if (cancelling) await cancelling;
    if (!destroyed) {
      // Always discard this session: migration search_path/timeouts must not leak into the app pool.
      try {
        if (locked)
          await client.query(
            "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
            [key],
          );
      } finally {
        client.release(true);
      }
    }
  }
}
