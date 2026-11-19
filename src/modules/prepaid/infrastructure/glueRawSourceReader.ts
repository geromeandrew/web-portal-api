import { Client, type ClientConfig } from "pg";
import {
  GlueClient,
  GetConnectionCommand,
  GetJobRunCommand,
  GetJobCommand,
} from "@aws-sdk/client-glue";
import { SFNClient, GetExecutionHistoryCommand } from "@aws-sdk/client-sfn";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { createAwsClientOptions } from "../../../aws.js";
import { loadConfig } from "../../../config.js";
import {
  sourceWorkflows,
  sourceLandingName,
  type SourceWorkflow,
} from "../domain/sourceExtraction.js";
import {
  sourceGlueJobName,
  type SourceResources,
} from "../domain/sourceResources.js";
import { prepaidRawTables, prepaidRawSchema } from "./rawSourceMigration.js";
import { additionalRawTables } from "./allSourceMigration.js";
import { sourceJobArgumentDrift } from "../domain/sourceJobContracts.js";
import { projectKe24Raw } from "./ke24RawProjection.js";

import {
  glueFinancialSource,
  GlueRawSourceValidationError,
  rawSourceFilename,
  type RawRow,
  type RawCapture,
  type RawCaptureRequest,
  type GlueRawSourceReader,
} from "../domain/nativeRawSource.js";
export {
  glueFinancialSource,
  GlueRawSourceValidationError,
  rawSourceFilename,
  type RawRow,
  type RawCapture,
  type RawCaptureRequest,
  type GlueRawSourceReader,
} from "../domain/nativeRawSource.js";

const columns = { ...prepaidRawTables, ...additionalRawTables };
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
export function assertRawRows(
  rows: RawRow[],
  names: string[],
  started: Date,
  completed: Date,
) {
  const expected = new Set(names),
    seen = new Set<string>();
  for (const row of rows) {
    const filename = rawSourceFilename(row.filename ?? "");
    if (!expected.has(filename))
      throw new GlueRawSourceValidationError(
        "Glue raw output contains an unexpected source file.",
      );
    const id = row.sequentialid ?? "";
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        id,
      ) ||
      seen.has(id)
    )
      throw new GlueRawSourceValidationError(
        "Glue raw output has missing or duplicate row identities.",
      );
    seen.add(id);
    // Utils.generate_uuidv7 embeds the producer's millisecond clock in every row.
    // Unlike filenames or a table-wide timestamp, this also rejects mixed old rows.
    const writtenAt = Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16);
    if (writtenAt < started.getTime() || writtenAt > completed.getTime())
      throw new GlueRawSourceValidationError(
        "Glue raw output contains stale rows outside the verified job run.",
      );
    if (!row.dateread)
      throw new GlueRawSourceValidationError(
        "Glue raw output has no read timestamp.",
      );
  }
}

/** Reads the actual Glue destination, even when the portal uses a different DB.
 * Never writes source tables, updates AWS jobs, or falls back to uploaded amounts.
 * Call only while holding the existing shared extraction lock.
 */
export class AwsGlueRawSourceReader implements GlueRawSourceReader {
  constructor(
    private readonly glue: Pick<GlueClient, "send">,
    private readonly sfn: Pick<SFNClient, "send">,
    private readonly secrets: Pick<SecretsManagerClient, "send">,
    private readonly connect = async (config: ClientConfig) => {
      const client = new Client(config);
      try {
        await client.connect();
      } catch (error) {
        await client.end().catch(() => {});
        throw error;
      }
      return client;
    },
  ) {}
  static create() {
    const options = createAwsClientOptions(loadConfig());
    return new AwsGlueRawSourceReader(
      new GlueClient(options),
      new SFNClient(options),
      new SecretsManagerClient(options),
    );
  }
  private async openConnection(connectionName: string) {
    const { Connection: connection } = await this.glue.send(
      new GetConnectionCommand({ Name: connectionName, HidePassword: false }),
    );
    const properties = connection?.ConnectionProperties ?? {};
    const jdbc = properties.JDBC_CONNECTION_URL;
    if (!jdbc?.startsWith("jdbc:postgresql://"))
      throw Error(
        "Glue source connection must identify a PostgreSQL database.",
      );
    const url = new URL(jdbc.slice(5));
    let user = properties.USERNAME,
      password = properties.PASSWORD;
    if (properties.SECRET_ID) {
      const secret = await this.secrets.send(
        new GetSecretValueCommand({ SecretId: properties.SECRET_ID }),
      );
      if (!secret.SecretString)
        throw Error("Glue source connection credentials are unavailable.");
      let value: { username?: string; password?: string };
      try {
        value = JSON.parse(secret.SecretString);
      } catch {
        throw Error("Glue source connection secret is not valid JSON.");
      }
      user = value.username;
      password = value.password;
    }
    if (
      !user ||
      !password ||
      url.username ||
      url.password ||
      !url.pathname.slice(1)
    )
      throw Error(
        "Glue source connection is incomplete; no portal-database fallback is allowed.",
      );
    return this.connect({
      host: url.hostname,
      port: Number(url.port || 5432),
      database: decodeURIComponent(url.pathname.slice(1)),
      user,
      password,
      // Match this application's existing sslmode=require connection policy.
      ssl:
        properties.JDBC_ENFORCE_SSL === "false"
          ? false
          : { rejectUnauthorized: false },
      connectionTimeoutMillis: 10000,
      query_timeout: 60000,
      application_name: "prepaid-glue-raw-reader",
    });
  }
  async verifyAccess(settings: {
    envPrefix: string;
    resources?: SourceResources;
  }) {
    const name =
      settings.resources?.connectionName ??
      `${settings.envPrefix}-prep_reclass-glco-postgres`;
    const client = await this.openConnection(name);
    try {
      await client.query("BEGIN READ ONLY");
      for (const [table, shape] of Object.entries(columns))
        await client.query(
          `SELECT ${shape.map((c) => quote(c.name)).join(",")} FROM ${quote(prepaidRawSchema)}.${quote(table)} LIMIT 0`,
        );
      await client.query("COMMIT");
    } finally {
      await client.end();
    }
  }
  async capture(request: RawCaptureRequest): Promise<RawCapture> {
    const definition = sourceWorkflows[request.workflow];
    const expectedJobs = definition.jobs.map((number) =>
      sourceGlueJobName(number, request.envPrefix, request.resources),
    );
    const submitted = new Map<string, string>();
    let nextToken: string | undefined,
      pages = 0;
    do {
      if (++pages > 20)
        throw Error(
          "Glue source execution history exceeds verification limits.",
        );
      const page = await this.sfn.send(
        new GetExecutionHistoryCommand({
          executionArn: request.executionArn,
          includeExecutionData: true,
          maxResults: 1000,
          nextToken,
        }),
      );
      for (const event of page.events ?? []) {
        const detail = event.taskSubmittedEventDetails;
        if (
          detail?.resourceType !== "glue" ||
          detail.resource !== "startJobRun.sync"
        )
          continue;
        if (detail.outputDetails?.truncated || !detail.output)
          throw Error("Glue source job ownership history is incomplete.");
        const output = JSON.parse(detail.output);
        if (
          expectedJobs.includes(output.JobName) &&
          typeof output.JobRunId === "string" &&
          output.JobRunId
        )
          submitted.set(output.JobName, output.JobRunId);
      }
      nextToken = page.nextToken;
    } while (nextToken);
    const jobs: RawCapture["jobs"] = [];
    for (const [index, name] of expectedJobs.entries()) {
      const id = submitted.get(name);
      if (!id)
        throw new GlueRawSourceValidationError(
          "Glue source execution is missing an expected header/detail job.",
        );
      const { JobRun: run } = await this.glue.send(
        new GetJobRunCommand({
          JobName: name,
          RunId: id,
          PredecessorsIncluded: false,
        }),
      );
      if (
        run?.Id !== id ||
        run.JobName !== name ||
        run.JobRunState !== "SUCCEEDED" ||
        !run.StartedOn ||
        !run.CompletedOn ||
        run.CompletedOn < run.StartedOn
      )
        throw new GlueRawSourceValidationError(
          "Glue raw snapshot requires verified successful job-run dates and identity.",
        );
      const { Job: job } = await this.glue.send(
        new GetJobCommand({ JobName: name }),
      );
      const args = {
        ...job?.DefaultArguments,
        ...run.Arguments,
        ...job?.NonOverridableArguments,
      };
      if (
        sourceJobArgumentDrift(
          definition.jobs[index],
          args,
          request.envPrefix,
          request.resources,
        ).length ||
        args["--target_table"] !==
          `${prepaidRawSchema}.${definition.targets[index]}` ||
        args["--input_file_name"] !== definition.inputPattern ||
        args["--folder_location"] !== `${request.bucket}/prepaid_reclass/`
      )
        throw new GlueRawSourceValidationError(
          "Glue run arguments differ from the reviewed source table/file mapping.",
        );
      jobs.push({
        name,
        id,
        table: definition.targets[index],
        startedAt: run.StartedOn.toISOString(),
        completedAt: run.CompletedOn.toISOString(),
      });
    }
    const connectionName =
      request.resources?.connectionName ??
      `${request.envPrefix}-prep_reclass-glco-postgres`;
    const client = await this.openConnection(connectionName);
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query("SET LOCAL statement_timeout = '60s'");
      const tables: RawCapture["tables"] = {};
      const rowCounts: Record<string, number> = {};
      for (const job of jobs) {
        const shape = columns[job.table as keyof typeof columns];
        if (!shape) throw Error("Unreviewed Glue raw table.");
        const names = request.sources.map((source) =>
          sourceLandingName(request.workflow, source.code),
        );
        // Match exact real filenames, never the increment alias assigned by Glue.
        const result =
          job.table === "dcKE24"
            ? await projectKe24Raw(
                client,
                names,
                new Date(job.startedAt),
                new Date(job.completedAt),
              )
            : await client.query<RawRow>(
                `SELECT ${shape.map((c) => `${quote(c.name)}::text AS ${quote(c.name)}`).join(",")} FROM ${quote(prepaidRawSchema)}.${quote(job.table)} WHERE split_part(filename,' - ',1)=ANY($1::text[]) ORDER BY filename, rownum, sequentialid LIMIT 250001`,
                [names],
              );
        const rows = result.rows;
        rowCounts[job.table] =
          job.table === "dcKE24" ? result.rowCount! : rows.length;
        if (
          rows.length > 250000 ||
          Buffer.byteLength(JSON.stringify(rows)) > 100 * 1024 * 1024
        )
          throw Error("Glue raw snapshot exceeds the source safety limit.");
        assertRawRows(
          rows,
          names,
          new Date(job.startedAt),
          new Date(job.completedAt),
        );
        // Header records prove billing files with genuinely zero financial lines.
        const isDetail = /lineitem_cycles$/.test(job.table);
        if (
          !isDetail &&
          names.some(
            (name) =>
              !rows.some((row) => rawSourceFilename(row.filename!) === name),
          )
        )
          throw new GlueRawSourceValidationError(
            "Glue raw output is missing an uploaded source file.",
          );
        tables[job.table] = rows;
      }
      await client.query("COMMIT");
      return {
        contract: glueFinancialSource,
        executionArn: request.executionArn,
        connectionName,
        jobs,
        tables,
        rowCounts,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      await client.end();
    }
  }
}
