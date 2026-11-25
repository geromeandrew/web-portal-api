import {
  BeginTransactionCommand,
  CommitTransactionCommand,
  ExecuteStatementCommand,
  RDSDataClient,
  RollbackTransactionCommand,
} from "@aws-sdk/client-rds-data";
import { createAwsClientOptions } from "./aws.js";
import { loadConfig } from "./config.js";
import { createPool } from "./db.js";
import {
  migratePrepaid,
  type MigrationConnection,
} from "./modules/prepaid/infrastructure/migrationRunner.js";
import { splitSqlStatements } from "./modules/prepaid/infrastructure/sqlStatements.js";

function dataApiConnection(
  client: RDSDataClient,
  target: { resourceArn: string; secretArn: string; database: string },
  transactionId: string,
): MigrationConnection {
  return {
    async query(sql, values) {
      // Only the fixed catalog queries have parameters. DDL is split separately.
      const statements = values
        ? [sql.replace(/\$(\d+)\b/g, ":value$1")]
        : splitSqlStatements(sql);
      const parameters = values?.map((stringValue, index) => ({
        name: `value${index + 1}`,
        value: { stringValue },
      }));
      let rows: Record<string, unknown>[] = [];
      for (const statement of statements) {
        const response = await client.send(
          new ExecuteStatementCommand({
            ...target,
            transactionId,
            sql: statement,
            parameters,
            formatRecordsAs: "JSON",
          }),
        );
        rows = JSON.parse(response.formattedRecords ?? "[]");
      }
      return { rows };
    },
  };
}

const config = loadConfig();
// Both deployment transports apply the complete Prepaid migration set.
const includeBillingScope = true;
const resourceArn = process.env.PREPAID_MIGRATION_DATA_API_RESOURCE_ARN;
const secretArn = process.env.PREPAID_MIGRATION_DATA_API_SECRET_ARN;
// Data API is explicit opt-in, never an automatic fallback to another database.
try {
  if (resourceArn || secretArn) {
    if (!resourceArn || !secretArn)
      throw new Error("Both Prepaid migration Data API ARNs are required.");
    const client = new RDSDataClient({
      ...createAwsClientOptions(config),
      maxAttempts: 1,
    });
    const target = { resourceArn, secretArn, database: config.DATABASE_NAME };
    let transactionId: string | undefined;
    try {
      transactionId = (await client.send(new BeginTransactionCommand(target)))
        .transactionId;
      if (!transactionId)
        throw new Error("Data API did not return a transaction ID.");
      const applied = await migratePrepaid(
        dataApiConnection(client, target, transactionId),
        config.DATABASE_SCHEMA,
        undefined,
        includeBillingScope,
      );
      await client.send(
        new CommitTransactionCommand({ resourceArn, secretArn, transactionId }),
      );
      transactionId = undefined;
      console.log(
        `Prepaid-only migrations are current (Data API). Applied: ${applied.join(", ") || "none"}.`,
      );
    } catch (error) {
      if (transactionId)
        await client
          .send(
            new RollbackTransactionCommand({
              resourceArn,
              secretArn,
              transactionId,
            }),
          )
          .catch((rollbackError: unknown) => {
            console.error(
              "Prepaid Data API rollback failed:",
              rollbackError instanceof Error
                ? rollbackError.name
                : "unknown error",
            );
          });
      throw error;
    } finally {
      client.destroy();
    }
  } else {
    const pool = createPool(config);
    try {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const applied = await migratePrepaid(
          client,
          config.DATABASE_SCHEMA,
          undefined,
          includeBillingScope,
        );
        await client.query("COMMIT");
        console.log(
          `Prepaid-only migrations are current. Applied: ${applied.join(", ") || "none"}.`,
        );
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  }
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Prepaid migration failed",
  );
  process.exitCode = 1;
}
