import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  datasetSchemas,
  periodSchema,
  sessionManifestSchema,
  manualIntegrationSchema,
  expectedReportCycles,
  expectedBillingCoverage,
  requiredBillingSources,
  type Dataset,
} from "../domain/contracts.js";
import {
  sourceWorkflows,
  extractionReceiptSchema,
  type SourceWorkflow,
} from "../domain/sourceExtraction.js";
import { PrepaidStorage, sha256 } from "../infrastructure/prepaidStorage.js";
import { PrepaidReferenceProvider } from "./referenceProvider.js";
import { PrepaidReferenceCatalog } from "../infrastructure/referenceCatalog.js";
import { verifyGlueSourceCapture } from "./glueSourceSnapshot.js";

type Summary = NonNullable<
  z.infer<typeof sessionManifestSchema>["extractionReceipts"]
>[number];
/** Backend V2 producer, not an invented AWS execution. It only combines exact
 * verified native-source records and an explicitly approved immutable reference.
 * Financial reclassification still belongs to the existing PostgreSQL functions.
 */
export class PrepaidNativeManifestBuilder {
  constructor(
    readonly storage: PrepaidStorage,
    readonly catalog?: PrepaidReferenceCatalog,
  ) {}
  async build(
    job: any,
    session: any,
    configuration: z.infer<typeof manualIntegrationSchema>,
    receipts: Summary[],
    owns: () => Promise<void>,
  ) {
    if (
      configuration.preparationMode !== "native_sources" ||
      configuration.sourceExtraction?.coverage !== "all_sources" ||
      !(
        configuration.referenceExport?.approved ||
        configuration.referenceVersion?.approved
      )
    )
      throw Error(
        "Native preparation needs all ten sources and an approved reference export.",
      );
    const workflows = Object.keys(sourceWorkflows) as SourceWorkflow[];
    if (
      receipts.length !== workflows.length ||
      new Set(receipts.map((r) => r.workflow)).size !== workflows.length ||
      workflows.some((w) => !receipts.some((r) => r.workflow === w))
    )
      throw Error(
        "Native preparation requires a verified receipt for each of the ten source workflows.",
      );
    const prefix = `${this.storage.sessionPrefix(session.id)}preparation/${job.id}/`;
    const originals = job.source_files.map((f: any) => ({
      id: f.id,
      code: f.source_code,
      key: f.object_key,
      sha256: f.sha256,
    }));
    const verified: z.infer<typeof extractionReceiptSchema>[] = [];
    for (const summary of receipts) {
      await owns();
      const receipt = extractionReceiptSchema.parse(
        await this.storage.json(summary.receiptKey, prefix),
      );
      if (
        receipt.producer !== "backend" ||
        receipt.preparationId !== job.id ||
        receipt.sessionId !== session.id ||
        receipt.workspaceId !== session.workspace_id ||
        receipt.sourceVersion !== job.source_version ||
        receipt.executionArn !== summary.executionArn ||
        receipt.workflow !== summary.workflow ||
        !isDeepStrictEqual(receipt.artifacts, summary.artifacts)
      )
        throw Error("Native source receipt identity/artifact mismatch.");
      if (receipt.financialSource === "glue_raw_v1") {
        await verifyGlueSourceCapture(
          receipt,
          {
            workflow: receipt.workflow,
            executionArn: receipt.executionArn,
            envPrefix: configuration.sourceExtraction!.envPrefix,
            resources: configuration.sourceExtraction?.resources,
            bucket: this.storage.bucket,
            sources: receipt.sources.map((source) => ({
              id: source.id,
              code: source.code,
            })),
          },
          `${prefix}extractions/${receipt.workflow}/`,
          this.storage,
        );
      }
      if (
        !isDeepStrictEqual(
          receipt.egReportMapping,
          configuration.sourceExtraction?.egReportMapping,
        )
      )
        throw Error(
          "Native receipt EG mapping differs from the approved preparation configuration.",
        );
      for (const input of receipt.nativeInputs ?? []) {
        if (
          !receipt.egReportMapping ||
          input.sourceCode !== receipt.workflow ||
          !receipt.sources.some(
            (source) =>
              source.id === input.sourceId && source.code === input.sourceCode,
          ) ||
          input.key !==
            `${prefix}extractions/${receipt.workflow}/${input.sourceId}/native-input.xlsx`
        )
          throw Error("Native receipt adapted-input identity mismatch.");
        const bytes = await this.storage.bytes(
          input.key,
          prefix,
          100 * 1024 * 1024,
        );
        if (bytes.length !== input.size || sha256(bytes) !== input.sha256)
          throw Error("Native receipt adapted-input checksum mismatch.");
      }
      for (const source of receipt.sources) {
        if (
          !originals.some(
            (o: any) =>
              o.id === source.id &&
              o.code === source.code &&
              o.key === source.key &&
              o.sha256 === source.sha256,
          )
        )
          throw Error("Native receipt does not attest an original upload.");
      }
      verified.push(receipt);
    }
    const actualSources = verified
        .flatMap((r) => r.sources.map((s) => s.id))
        .sort(),
      expectedSources = originals.map((s: any) => s.id).sort();
    if (JSON.stringify(actualSources) !== JSON.stringify(expectedSources))
      throw Error(
        "Native receipts must cover every uploaded source exactly once.",
      );
    const ke24 = verified.find((r) => r.workflow === "ke24")!;
    const periods = new Set<string>();
    for (const artifact of ke24.artifacts)
      for await (const value of this.storage.rows(
        artifact.key,
        prefix,
        artifact.sha256,
        artifact.rowCount,
      ))
        periods.add(datasetSchemas.ke24.parse(value).period);
    if (periods.size !== 1)
      throw Error("KE24 must establish exactly one accounting period.");
    const period = periodSchema.parse([...periods][0]);
    const lines = Object.fromEntries(
      Object.keys(datasetSchemas).map((name) => [name, [] as string[]]),
    ) as Record<Dataset, string[]>;
    const sizes: Partial<Record<Dataset, number>> = {};
    let totalBytes = 0,
      totalRows = 0;
    const append = (name: Dataset, value: unknown) => {
      const row = datasetSchemas[name].parse(value);
      const line = JSON.stringify(row) + "\n",
        size = Buffer.byteLength(line);
      totalBytes += size;
      totalRows++;
      sizes[name] = (sizes[name] ?? 0) + size;
      if (
        size > 128000 ||
        totalRows > 1_000_000 ||
        totalBytes > 128 * 1024 * 1024 ||
        sizes[name]! > 64 * 1024 * 1024
      )
        throw Error(
          "Canonical native outputs exceed bounded worker limits; nothing was published ready.",
        );
      lines[name].push(line);
    };
    const headers = new Set<string>();
    for (const receipt of verified)
      for (const artifact of receipt.artifacts) {
        await owns();
        for await (const value of this.storage.rows(
          artifact.key,
          prefix,
          artifact.sha256,
          artifact.rowCount,
        )) {
          const row = value as Record<string, unknown>;
          if (
            artifact.name === "adjustment_headers" ||
            artifact.name === "charge_headers"
          ) {
            const header = z
              .object({
                cycle: z.string().regex(/^\d{2}$/),
                cycleYear: z.string().regex(/^\d{4}$/),
                cycleInstance: z.string().min(1),
              })
              .parse(row);
            if (
              header.cycle !== artifact.sourceCode.slice(4) ||
              !expectedReportCycles(
                configuration,
                artifact.name === "adjustment_headers"
                  ? "adjustments"
                  : "charges",
              ).includes(header.cycle)
            )
              throw Error(
                "Native billing header is outside expected cycle coverage.",
              );
            headers.add(artifact.sourceCode);
            continue;
          }
          if (row.period !== undefined && row.period !== period)
            throw Error("Source fragment disagrees with KE24 period.");
          if (
            artifact.name === "callcard" &&
            row.region === "sg" &&
            row.sourcePeriod !== period
          )
            throw Error("Latest SG Call Card period disagrees with KE24.");
          append(artifact.name, { ...row, period });
        }
      }
    for (const code of requiredBillingSources(configuration))
      if (!headers.has(code))
        throw Error("Native preparation is missing a 308/318 cycle header.");
    if (configuration.referenceVersion) {
      if (!this.catalog)
        throw Error(
          "Database reference catalog is required; S3 fallback is disabled.",
        );
      await this.catalog.assertAvailable(configuration.referenceVersion);
    } else {
      const reference = await new PrepaidReferenceProvider(this.storage).load(
        configuration.referenceExport!,
        period,
      );
      for (const row of reference.rows) append("reference", row);
    }
    const datasets = [];
    for (const name of Object.keys(datasetSchemas) as Dataset[]) {
      // Database references are loaded directly inside the publishing transaction.
      if (name === "reference" && configuration.referenceVersion) continue;
      await owns();
      const key = `${prefix}native-canonical/${name}.jsonl`;
      const saved = await this.storage.putVerified(
        key,
        prefix,
        Buffer.from(lines[name].join("")),
        "application/x-ndjson",
      );
      datasets.push({
        name,
        key,
        sha256: saved.sha256,
        rowCount: lines[name].length,
      });
    }
    const manifest = sessionManifestSchema.parse({
      contractVersion: 2,
      producer: "backend",
      sessionId: session.id,
      workspaceId: session.workspace_id,
      preparationId: job.id,
      sourceVersion: job.source_version,
      period,
      // Explicit backend identity: do not present a source execution as a final AWS adapter.
      executionArn: `backend:preparation:${job.id}`,
      sourceFiles: originals.map((s: any) => ({ id: s.id, sha256: s.sha256 })),
      coverage: expectedBillingCoverage(configuration),
      datasets,
      extractionReceipts: receipts,
      referenceSource: configuration.referenceExport,
      referenceVersion: configuration.referenceVersion,
    });
    const manifestKey = `${prefix}native-manifest.json`;
    await owns();
    await this.storage.putVerified(
      manifestKey,
      prefix,
      Buffer.from(JSON.stringify(manifest)),
      "application/json",
    );
    return { manifestKey, manifest };
  }
}
