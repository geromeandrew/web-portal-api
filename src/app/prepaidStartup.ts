import { setTimeout as delay } from "node:timers/promises";
import type { Pool, QueryConfig } from "pg";
import type { Config } from "../config.js";
import type { Logger } from "../platform/logger.js";
import { prepaidFullBatchPrefix } from "../modules/prepaid/application/fullBatch.js";
import {
  migratePrepaid,
  prepaidBillingMigrationIds,
  prepaidBillingPrerequisitesSql,
  prepaidMigrations,
  validatePrepaidSchema,
} from "../modules/prepaid/infrastructure/migrationRunner.js";

export type PrepaidStartupStatus = {
  baseIssue: string | null;
  billingIssue: string | null;
};

const baseMigrationIds = prepaidMigrations().map(([id]) => id);
const retryable = new Set([
  "55006",
  "55P03",
  "40P01",
  "40001",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "57P01",
]);

export async function localPrepaidBatchPrefix(pool: Pool, config: Config) {
  const prefix = prepaidFullBatchPrefix(config);
  if (!prefix || !["localhost", "127.0.0.1", "::1"].includes(config.DATABASE_HOST.toLowerCase()))
    return prefix;
  const { rows } = await pool.query(prepaidBillingPrerequisitesSql);
  return rows[0]?.ready === true ? prefix : undefined;
}

export function startPrepaidStartup(
  pool: Pool,
  config: Config,
  logger: Logger,
  signal: AbortSignal,
) {
  const schema = config.DATABASE_SCHEMA;
  const ledger = `"${schema}".prepaid_schema_migrations`;
  const billingConfigured = !!prepaidFullBatchPrefix(config);
  const status: PrepaidStartupStatus = {
    baseIssue: "Prepaid database migrations are in progress.",
    billingIssue: billingConfigured
      ? "Prepaid billing migrations are in progress."
      : null,
  };
  let resolveBase!: (ready: boolean) => void;
  const baseReady = new Promise<boolean>((resolve) => {
    resolveBase = resolve;
  });

  function read(text: string, values: unknown[] = []) {
    signal.throwIfAborted();
    return pool.query({
      text,
      values,
      query_timeout: 5000,
    } as QueryConfig & { query_timeout: number });
  }

  async function isCurrent(ids: readonly string[]) {
    const { rows } = await read("SELECT to_regclass($1) AS ledger", [
      ledger,
    ]);
    if (!rows[0]?.ledger) return false;
    const applied = await read(
      `SELECT id FROM ${ledger} WHERE id = ANY($1::text[])`,
      [ids],
    );
    return applied.rows.length === ids.length;
  }

  async function apply(billing: boolean) {
    signal.throwIfAborted();
    const client = await pool.connect();
    let released = false;
    const abort = () => {
      released = true;
      client.release(true);
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      await client.query("BEGIN");
      const applied = await migratePrepaid(client, schema, undefined, billing);
      signal.throwIfAborted();
      await client.query("COMMIT");
      for (const migrationId of applied)
        logger.info("database.prepaid_startup_migration_applied", {
          migrationId,
          databaseSchema: schema,
        });
    } catch (error) {
      if (!released) await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
      if (!released) client.release();
    }
  }

  async function ensureCurrent(billing: boolean) {
    const phase = billing ? "billing" : "base";
    const key = billing ? "billingIssue" : "baseIssue";
    const ids = billing ? prepaidBillingMigrationIds : baseMigrationIds;
    while (!signal.aborted) {
      try {
        if (await isCurrent(ids)) {
          if (!billing) await validatePrepaidSchema(pool, schema);
          status[key] = null;
          return true;
        }
        {
          if (
            billing &&
            (await read(prepaidBillingPrerequisitesSql)).rows[0]
              ?.ready !== true
          )
            throw Object.assign(
              new Error("Billing prerequisites are missing."),
              { code: "55000" },
            );
          await apply(billing);
          status[key] = null;
          return true;
        }
      } catch (error) {
        if (signal.aborted) break;
        const code =
          error && typeof error === "object" && "code" in error
            ? String(error.code)
            : undefined;
        const temporary = (code === "55000" && billing) || (!!code && retryable.has(code)) ||
          (error instanceof Error && error.message === "Query read timeout");
        const issue =
          code === "55006"
            ? "A Prepaid import is still active. Billing migrations will retry automatically."
            : code === "55000" && billing
              ? "Prepaid billing migrations are waiting for the converted layouts and import procedures."
              : code === "42501"
                ? "Prepaid database permissions are missing. Ask your administrator to run the deployment migration job."
                : temporary
                  ? "Prepaid database migrations are waiting. They will retry automatically."
                  : "Prepaid database migrations could not complete. Ask your administrator to check the migration job.";
        if (status[key] !== issue)
          logger[temporary ? "info" : "error"](
            "database.prepaid_startup_migration_waiting",
            {
              phase,
              reason: issue,
              errorCode: code,
              databaseSchema: schema,
            },
          );
        status[key] = issue;
      }
      await delay(5000, undefined, { signal }).catch(
        () => {},
      );
    }
    return false;
  }

  const completion = (async () => {
    try {
      const installed = await ensureCurrent(false);
      resolveBase(installed);
      if (installed && billingConfigured) await ensureCurrent(true);
    } finally {
      resolveBase(false);
    }
  })();
  return { status, baseReady, completion };
}
