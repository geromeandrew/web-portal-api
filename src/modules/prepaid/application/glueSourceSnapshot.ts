import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  extractionReceiptSchema,
  sourceWorkflows,
  sourceLandingName,
} from "../domain/sourceExtraction.js";
import { validateSourceFragment } from "../domain/sourceFragments.js";
import { sourceGlueJobName } from "../domain/sourceResources.js";
import {
  glueFinancialSource,
  GlueRawSourceValidationError,
  rawSourceFilename,
  type GlueRawSourceReader,
  type RawCaptureRequest,
  type RawCapture,
} from "../domain/nativeRawSource.js";
import { PrepaidStorage, sha256 } from "../infrastructure/prepaidStorage.js";
import type { SourceNormalizer } from "../infrastructure/sourceNormalizer.js";

const indexSchema = z.object({
  contract: z.literal(glueFinancialSource),
  executionArn: z.string(),
  connectionName: z.string(),
  sources: z.array(z.object({ id: z.string().uuid(), code: z.string() })),
  jobs: z.array(
    z.object({
      name: z.string(),
      id: z.string(),
      startedAt: z.string().datetime(),
      completedAt: z.string().datetime(),
      table: z.string(),
    }),
  ),
  tables: z.array(
    z.object({
      table: z.string(),
      key: z.string(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      rowCount: z.number().int().nonnegative(),
      sourceRowCount: z.number().int().nonnegative().optional(),
    }),
  ),
});

function assertIndex(
  index: z.infer<typeof indexSchema>,
  request: RawCaptureRequest,
) {
  const mapping = sourceWorkflows[request.workflow];
  const expected = mapping.jobs.map((number, i) => ({
    name: sourceGlueJobName(number, request.envPrefix, request.resources),
    table: mapping.targets[i],
  }));
  if (
    index.executionArn !== request.executionArn ||
    !isDeepStrictEqual(index.sources, request.sources) ||
    !isDeepStrictEqual(
      index.tables.map((t) => t.table).sort(),
      [...mapping.targets].sort(),
    ) ||
    !isDeepStrictEqual(
      index.jobs.map((j) => ({ name: j.name, table: j.table })),
      expected,
    ) ||
    index.jobs.some(
      (j) => !j.id || Date.parse(j.completedAt) < Date.parse(j.startedAt),
    )
  )
    throw Error(
      "Saved Glue raw capture belongs to another extraction or job set.",
    );
}

export async function verifyGlueSourceCapture(
  receipt: z.infer<typeof extractionReceiptSchema>,
  request: RawCaptureRequest,
  prefix: string,
  storage: PrepaidStorage,
) {
  const key = `${prefix}glue-raw/index.json`;
  if (receipt.rawCapture?.key !== key)
    throw Error("Native receipt has no verified Glue raw capture.");
  const bytes = await storage.bytes(key, prefix, 2_000_000);
  if (sha256(bytes) !== receipt.rawCapture.sha256)
    throw Error("Glue raw capture index checksum mismatch.");
  assertIndex(indexSchema.parse(JSON.parse(bytes.toString())), request);
  for (const artifact of receipt.artifacts)
    if (
      artifact.key !==
      `${prefix}glue-output/${artifact.sourceId}/${artifact.name}.jsonl`
    )
      throw Error(
        "Native receipt attempted to use preflight amounts instead of Glue output.",
      );
}

/** Capture before shared-input cleanup. The immutable index is the retry boundary:
 * a restart after capture never reads a later run's shared raw tables.
 */
export async function snapshotGlueSources(
  request: RawCaptureRequest,
  prefix: string,
  storage: PrepaidStorage,
  reader: GlueRawSourceReader,
  normalizer: SourceNormalizer,
  owns: () => Promise<void>,
  period?: string,
) {
  if (!normalizer.normalizeRaw)
    throw Error("The worker cannot normalize verified Glue raw output.");
  const key = `${prefix}glue-raw/index.json`;
  let stored: unknown;
  try {
    stored = await storage.json(key, prefix);
  } catch (error) {
    if (
      (error as any).$metadata?.httpStatusCode !== 404 &&
      (error as any).name !== "NoSuchKey"
    )
      throw error;
  }
  let index: z.infer<typeof indexSchema>;
  const tables: RawCapture["tables"] = {};
  if (stored) {
    index = indexSchema.parse(stored);
    assertIndex(index, request);
    for (const table of index.tables) {
      if (table.key !== `${prefix}glue-raw/${table.table}.jsonl`)
        throw Error("Invalid Glue raw capture key.");
      tables[table.table] = [];
      for await (const row of storage.rows(
        table.key,
        prefix,
        table.sha256,
        table.rowCount,
      )) {
        if (
          !row ||
          typeof row !== "object" ||
          Array.isArray(row) ||
          Object.values(row).some((v) => v !== null && typeof v !== "string")
        )
          throw Error("Invalid saved Glue raw row.");
        tables[table.table].push(row as RawCapture["tables"][string][number]);
      }
    }
  } else {
    await owns();
    const capture = await reader.capture(request);
    if (
      capture.contract !== glueFinancialSource ||
      capture.executionArn !== request.executionArn ||
      !isDeepStrictEqual(
        Object.keys(capture.tables).sort(),
        [...sourceWorkflows[request.workflow].targets].sort(),
      )
    )
      throw Error("Glue reader returned an unrelated source capture.");
    const descriptors = [];
    for (const [table, rows] of Object.entries(capture.tables)) {
      const body = Buffer.from(
        rows.map((row) => JSON.stringify(row) + "\n").join(""),
      );
      await owns();
      const saved = await storage.putVerified(
        `${prefix}glue-raw/${table}.jsonl`,
        prefix,
        body,
        "application/x-ndjson",
      );
      descriptors.push({
        table,
        key: saved.key,
        sha256: saved.sha256,
        rowCount: rows.length,
        sourceRowCount: capture.rowCounts?.[table] ?? rows.length,
      });
      tables[table] = rows;
    }
    index = indexSchema.parse({
      ...capture,
      sources: request.sources,
      tables: descriptors,
    });
    assertIndex(index, request);
    await owns();
    await storage.putVerified(
      key,
      prefix,
      Buffer.from(JSON.stringify(index)),
      "application/json",
    );
  }
  const artifacts: z.infer<typeof extractionReceiptSchema>["artifacts"] = [];
  for (const source of request.sources) {
    const filename = sourceLandingName(request.workflow, source.code);
    const selected = Object.fromEntries(
      Object.entries(tables).map(([table, rows]) => [
        table,
        rows.filter(
          (row) => rawSourceFilename(row.filename ?? "") === filename,
        ),
      ]),
    );
    let datasets: Record<string, unknown[]>;
    try {
      datasets = await normalizer.normalizeRaw(
        request.workflow,
        source.code,
        selected,
        period,
      );
    } catch (error) {
      if ((error as Error).message.startsWith("Source normalization failed:"))
        throw new GlueRawSourceValidationError(
          (error as Error).message.replace(
            "Source normalization failed:",
            "Extracted records could not be prepared:",
          ),
        );
      throw error;
    }
    if (
      !isDeepStrictEqual(
        Object.keys(datasets).sort(),
        [...sourceWorkflows[request.workflow].artifacts].sort(),
      )
    )
      throw Error(
        "Glue raw normalizer returned incomplete accounting datasets.",
      );
    for (const [name, rows] of Object.entries(datasets)) {
      for (const row of rows)
        validateSourceFragment(
          request.workflow,
          source.code,
          name as (typeof artifacts)[number]["name"],
          row,
        );
      const body = Buffer.from(
        rows.map((row) => JSON.stringify(row) + "\n").join(""),
      );
      await owns();
      const saved = await storage.putVerified(
        `${prefix}glue-output/${source.id}/${name}.jsonl`,
        prefix,
        body,
        "application/x-ndjson",
      );
      artifacts.push({
        sourceId: source.id,
        sourceCode: source.code,
        name: name as (typeof artifacts)[number]["name"],
        key: saved.key,
        sha256: saved.sha256,
        rowCount: rows.length,
      });
    }
  }
  return {
    artifacts,
    rawCapture: { key, sha256: sha256(Buffer.from(JSON.stringify(index))) },
    connectionName: index.connectionName,
    rawRowCount: index.tables.reduce(
      (n, table) => n + (table.sourceRowCount ?? table.rowCount),
      0,
    ),
    nativeJobRuns: index.jobs.map((job) => ({ name: job.name, id: job.id })),
  };
}
