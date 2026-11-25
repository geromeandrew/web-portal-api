import { afterEach, describe, expect, it, vi } from "vitest";

const { send, destroy, migrate } = vi.hoisted(() => ({
  send: vi.fn(),
  destroy: vi.fn(),
  migrate: vi.fn(),
}));

vi.mock("@aws-sdk/client-rds-data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@aws-sdk/client-rds-data")>()),
  RDSDataClient: class {
    send = send;
    destroy = destroy;
  },
}));
vi.mock("../src/config.js", () => ({
  loadConfig: () => ({
    DATABASE_NAME: "test_db",
    DATABASE_SCHEMA: "test_schema",
  }),
}));
vi.mock("../src/aws.js", () => ({ createAwsClientOptions: () => ({}) }));
vi.mock("../src/db.js", () => ({ createPool: vi.fn() }));
vi.mock("../src/modules/prepaid/infrastructure/migrationRunner.js", () => ({
  migratePrepaid: migrate,
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

async function run() {
  vi.resetModules();
  vi.stubEnv("PREPAID_MIGRATION_DATA_API_RESOURCE_ARN", "test-resource");
  vi.stubEnv("PREPAID_MIGRATION_DATA_API_SECRET_ARN", "test-secret");
  await import("../src/migratePrepaid.js");
}

describe("Prepaid Data API migrations", () => {
  it("binds catalog values and keeps placeholders in stored procedure bodies intact", async () => {
    send.mockReset().mockResolvedValue({ transactionId: "test-transaction" });
    migrate.mockImplementationOnce(async (db) => {
      await db.query("SELECT to_regclass($1)::text", [
        "test_schema.workspaces",
      ]);
      await db.query("SELECT 1; DO $$ BEGIN PERFORM '$1'; END $$;");
      return [];
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await run();
    expect(migrate).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: expect.any(Function) }),
      "test_schema",
      undefined,
      true,
    );
    const statements = send.mock.calls
      .slice(1, -1)
      .map(([command]) => command.input);
    expect(statements).toMatchObject([
      {
        transactionId: "test-transaction",
        sql: "SELECT to_regclass(:value1)::text",
        parameters: [
          { name: "value1", value: { stringValue: "test_schema.workspaces" } },
        ],
      },
      { sql: "SELECT 1" },
      { sql: "DO $$ BEGIN PERFORM '$1'; END $$" },
    ]);
    expect(send.mock.lastCall?.[0].constructor.name).toBe(
      "CommitTransactionCommand",
    );
  });

  it("reports rollback failure and preserves the original migration error", async () => {
    send
      .mockReset()
      .mockResolvedValueOnce({ transactionId: "test-transaction" })
      .mockRejectedValueOnce(new Error("Rollback unavailable"));
    migrate.mockRejectedValueOnce(new Error("Migration rejected"));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await run();
    expect(send.mock.lastCall?.[0].constructor.name).toBe(
      "RollbackTransactionCommand",
    );
    expect(log).toHaveBeenCalledWith(
      "Prepaid Data API rollback failed:",
      "Error",
    );
    expect(log).toHaveBeenCalledWith("Migration rejected");
    expect(process.exitCode).toBe(1);
    expect(destroy).toHaveBeenCalled();
  });
});
