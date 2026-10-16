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
import { migratePrepaid } from "./modules/prepaid/infrastructure/migrationRunner.js";
import { splitSqlStatements } from "./modules/prepaid/infrastructure/sqlStatements.js";

const config = loadConfig();
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
        {
          async query(sql) {
            let rows: Record<string, unknown>[] = [];
            for (const statement of splitSqlStatements(sql)) {
              const response = await client.send(
                new ExecuteStatementCommand({
                  ...target,
                  transactionId,
                  sql: statement,
                  formatRecordsAs: "JSON",
                }),
              );
              rows = JSON.parse(response.formattedRecords ?? "[]");
            }
            return { rows };
          },
        },
        config.DATABASE_SCHEMA,
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
          .catch(() => {});
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
        const applied = await migratePrepaid(client, config.DATABASE_SCHEMA);
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
