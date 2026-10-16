import { z } from "zod";
import {
  datasetSchemas,
  periodSchema,
  type Dataset,
  type sessionManifestSchema,
} from "../domain/contracts.js";
import type { PrepaidStorage } from "../infrastructure/prepaidStorage.js";

/** KE24 owns period discovery. A later full adapter must include these exact
 * records; it cannot silently ignore backend-normalized original-source output.
 */
export async function verifiedExtractionBridge(
  storage: PrepaidStorage,
  receipts: NonNullable<
    z.infer<typeof sessionManifestSchema>["extractionReceipts"]
  >,
  period: string,
  prefix: string,
) {
  periodSchema.parse(period);
  const expected = new Map<string, number>();
  const signature = (name: string, data: any) => {
    const amount = data.amount
      .replace(/^(-?)0+(?=\d)/, "$1")
      .replace(/(\.\d*?)0+$/, "$1")
      .replace(/\.$/, "");
    return `${name}:${JSON.stringify({ ...data, amount: amount === "-0" ? "0" : amount })}`;
  };
  for (const receipt of receipts) {
    for (const artifact of receipt.artifacts) {
      for await (const value of storage.rows(
        artifact.key,
        prefix,
        artifact.sha256,
        artifact.rowCount,
      )) {
        if (artifact.name === "adjustment_headers") {
          const header = z
            .object({
              cycle: z.string().regex(/^\d{2}$/),
              cycleYear: z.string().regex(/^\d{4}$/),
              cycleInstance: z.string().min(1),
            })
            .parse(value);
          if (header.cycle !== artifact.sourceCode.slice(4))
            throw Error(
              "308 cycle header disagrees with the exact source cycle.",
            );
          // Keep year/instance evidence. The undocumented old extraction window
          // may cross years; neither equality to KE24 year nor a month mapping
          // is established by the supplied trigger procedure.
          continue;
        }
        if (
          artifact.name === "callcard" &&
          z.object({ sourcePeriod: periodSchema }).parse(value).sourcePeriod !==
            period
        )
          throw Error("Latest SG Call Card period disagrees with KE24.");
        const data = datasetSchemas[artifact.name].parse({
          ...(value as object),
          period,
        });
        const key = signature(artifact.name, data);
        expected.set(key, (expected.get(key) ?? 0) + 1);
      }
    }
  }
  return {
    match(name: Dataset, data: any) {
      if (
        name !== "loadapi" &&
        name !== "adjustments" &&
        !(name === "callcard" && data.region === "sg")
      )
        return;
      const key = signature(name, data),
        count = expected.get(key) ?? 0;
      if (!count)
        throw Error(
          `Canonical ${name} differs from the verified four-workflow extraction.`,
        );
      if (count === 1) expected.delete(key);
      else expected.set(key, count - 1);
    },
    assertComplete() {
      if (expected.size)
        throw Error(
          "Canonical ingestion omitted verified source extraction rows.",
        );
    },
  };
}
