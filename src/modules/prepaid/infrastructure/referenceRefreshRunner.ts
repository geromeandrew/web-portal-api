import {
  GlueClient,
  GetJobCommand,
  GetConnectionCommand,
  GetJobRunsCommand,
  StartJobRunCommand,
  GetJobRunCommand,
  type JobRun,
} from "@aws-sdk/client-glue";
import { lookup } from "node:dns/promises";
import {
  referenceRefreshJob as job,
  referenceTerminalStates,
} from "../domain/referenceRefresh.js";
import type { ReferenceDatabaseIdentity } from "./referenceSource.js";
import { PrepaidStorage, sha256 } from "./prepaidStorage.js";
import { SharedExtractionBusy } from "./legacyLanding.js";

export interface ReferenceRefreshRunner {
  verify(identity: ReferenceDatabaseIdentity): Promise<void>;
  idle(ownRun?: string): Promise<void>;
  start(id: string): Promise<string>;
  find(id: string): Promise<string | undefined>;
  describe(id: string, runId: string): Promise<string>;
}

/** Existing job only. No CreateJob/UpdateJob/Step Functions edits/Secrets Manager reads. */
export class AwsReferenceRefreshRunner implements ReferenceRefreshRunner {
  constructor(
    private readonly glue: Pick<GlueClient, "send">,
    private readonly scripts: PrepaidStorage,
    private readonly expectedScriptSha256: string = job.scriptSha256,
  ) {}
  async verify(identity: ReferenceDatabaseIdentity) {
    const definition = (
      await this.glue.send(new GetJobCommand({ JobName: job.name }))
    ).Job;
    const args = {
      ...definition?.DefaultArguments,
      ...definition?.NonOverridableArguments,
    };
    const expected = {
      "--pg_connection_name": job.connection,
      "--s4_connection_name": job.sourceConnection,
      "--s4_schema": "SAPPRD",
      "--pg_schema": job.schema,
      "--pg_table_name": job.table,
      "--where_clause": "NA",
      "--partition_column": "NA",
      "--aws_region": "us-east-1",
    };
    if (
      definition?.Command?.Name !== "glueetl" ||
      definition.Command.ScriptLocation !==
        `s3://${job.scriptBucket}/${job.scriptKey}` ||
      Object.entries(expected).some(([key, value]) => args[key] !== value) ||
      job.marker in args
    )
      throw Error(
        "The SAP reference Glue job differs from the inspected source/target contract; no job was changed.",
      );
    const script = await this.scripts.bytes(
      job.scriptKey,
      "glue/dv-v0.0.1/core/commons/scripts/",
      2 * 1024 * 1024,
    );
    if (sha256(script) !== this.expectedScriptSha256)
      throw Error(
        "The shared SAP reference script has changed; review it before authorizing an overwrite.",
      );
    const connection = (
      await this.glue.send(
        new GetConnectionCommand({ Name: job.connection, HidePassword: true }),
      )
    ).Connection;
    const jdbc = connection?.ConnectionProperties?.JDBC_CONNECTION_URL;
    let destination: URL;
    try {
      if (!jdbc?.startsWith("jdbc:postgresql://")) throw Error();
      destination = new URL(jdbc.slice(5));
    } catch {
      throw Error(
        "The reference job PostgreSQL destination cannot be verified.",
      );
    }
    const addresses = await lookup(destination.hostname, { all: true });
    // RDS may expose a public NAT address while inet_server_addr() reports a
    // private /32 address. Compare the actual connection host's DNS aliases too,
    // never arbitrary API input or merely a matching database name.
    const normalized = (address: string) =>
      address.replace(/\/\d+$/, "").replace(/^::ffff:/, "");
    const connectedAddresses = identity.connectedHost
      ? await lookup(identity.connectedHost, { all: true })
      : [];
    const sameEndpoint = addresses.some(
      (entry) =>
        normalized(entry.address) === normalized(identity.address) ||
        connectedAddresses.some(
          (connected) =>
            normalized(connected.address) === normalized(entry.address),
        ),
    );
    if (
      decodeURIComponent(destination.pathname.slice(1)) !== identity.database ||
      Number(destination.port || 5432) !== identity.port ||
      !sameEndpoint
    )
      throw Error(
        "The SAP reference job writes to a different database/server than this portal connection. Refusing refresh/export.",
      );
  }
  private async runs() {
    const result: JobRun[] = [];
    let token: string | undefined,
      pages = 0;
    do {
      if (++pages > 100)
        throw Error(
          "Reference Glue run history exceeds the bounded reconciliation window; an operator must investigate.",
        );
      const page = await this.glue.send(
        new GetJobRunsCommand({
          JobName: job.name,
          NextToken: token,
          MaxResults: 200,
        }),
      );
      result.push(...(page.JobRuns ?? []));
      token = page.NextToken;
    } while (token);
    return result;
  }
  async idle(ownRun?: string) {
    if (
      (await this.runs()).some(
        (run) =>
          run.Id !== ownRun &&
          !referenceTerminalStates.has(run.JobRunState ?? ""),
      )
    )
      throw new SharedExtractionBusy(
        "A SAP reference refresh is already active. Wait for it; no shared table was changed by the portal.",
      );
  }
  async start(id: string) {
    // This unconsumed argument is only a correlation marker, not a portal validator.
    // The inspected script resolves its existing required parameters and ignores it.
    const result = await this.glue.send(
      new StartJobRunCommand({
        JobName: job.name,
        Arguments: { [job.marker]: id },
      }),
    );
    if (!result.JobRunId)
      throw Error(
        "SAP reference dispatch returned no run ID; outcome is unknown.",
      );
    return result.JobRunId;
  }
  async find(id: string) {
    const matches = (await this.runs()).filter(
      (run) => run.Arguments?.[job.marker] === id,
    );
    if (matches.length > 1)
      throw Error(
        "Multiple reference runs carry this request identity; an operator must reconcile them.",
      );
    return matches[0]?.Id;
  }
  async describe(id: string, runId: string) {
    const run = (
      await this.glue.send(
        new GetJobRunCommand({
          JobName: job.name,
          RunId: runId,
          PredecessorsIncluded: false,
        }),
      )
    ).JobRun;
    if (
      run?.Id !== runId ||
      run.JobName !== job.name ||
      run.Arguments?.[job.marker] !== id
    )
      throw Error("SAP reference run identity does not match this operation.");
    // This operation never supplies business/connection overrides.
    const definition = (
      await this.glue.send(new GetJobCommand({ JobName: job.name }))
    ).Job;
    const defaults = {
      ...definition?.DefaultArguments,
      ...definition?.NonOverridableArguments,
    };
    if (
      Object.entries(run.Arguments).some(
        ([key, value]) => key !== job.marker && defaults[key] !== value,
      )
    )
      throw Error("The reference run contains unexpected runtime overrides.");
    return run.JobRunState ?? "UNKNOWN";
  }
}
