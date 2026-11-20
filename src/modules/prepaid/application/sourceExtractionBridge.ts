import { z } from "zod";
import {
  datasetSchemas,
  periodSchema,
  type Dataset,
  type sessionManifestSchema,
} from "../domain/contracts.js";
import type { PrepaidStorage } from "../infrastructure/prepaidStorage.js";

/** KE24 owns period discovery. The backend producer or an external adapter must include these exact
 * records; it cannot silently ignore the verified extraction snapshot output.
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
  const covered = new Set(
    receipts.flatMap((receipt) =>
      receipt.artifacts
        .filter(
          (a) => a.name !== "adjustment_headers" && a.name !== "charge_headers",
        )
        .map((a) => a.name),
    ),
  );
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
            .parse(value);
          if (header.cycle !== artifact.sourceCode.slice(4))
            throw Error(
              "Billing header disagrees with the exact source cycle.",
            );
          // Keep year/instance evidence. The undocumented old extraction window
          // may cross years; neither equality to KE24 year nor a month mapping
          // is established by the supplied trigger procedure.
          continue;
        }
        if (
          artifact.name === "callcard" &&
          (value as any).region === "sg" &&
          z.object({ sourcePeriod: periodSchema }).parse(value).sourcePeriod !==
            period
        )
          throw Error("Latest SG Call Card period disagrees with KE24.");
        if (
          (value as any).period !== undefined &&
          (value as any).period !== period
        )
          throw Error("Verified source fragment period disagrees with KE24.");
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
        !covered.has(name as any) ||
        (name === "callcard" &&
          data.region === "eg" &&
          !receipts.some((receipt) => receipt.workflow === "callcard_eg"))
      )
        return;
      const key = signature(name, data),
        count = expected.get(key) ?? 0;
      if (!count)
        throw Error(
          `Canonical ${name} differs from the verified source extraction.`,
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
