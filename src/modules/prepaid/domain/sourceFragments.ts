import { z } from "zod";
import { datasetSchemas } from "./contracts.js";
import type {
  SourceWorkflow,
  extractionArtifactSchema,
} from "./sourceExtraction.js";

type ArtifactName = z.infer<typeof extractionArtifactSchema>["name"];
export function validateSourceFragment(
  workflow: SourceWorkflow,
  code: string,
  name: ArtifactName,
  value: unknown,
) {
  if (name === "adjustment_headers" || name === "charge_headers") {
    const header = z
      .object({
        cycle: z.string().regex(/^\d{2}$/),
        cycleYear: z.string().regex(/^\d{4}$/),
        cycleInstance: z.string().min(1),
      })
      .parse(value);
    if (header.cycle !== code.slice(4))
      throw Error("Billing header cycle mismatch.");
    return header;
  }
  const schema: z.ZodObject<any> = datasetSchemas[name];
  const data = (name === "ke24" ? schema : schema.omit({ period: true })).parse(
    value,
  ) as any;
  if (["loadapi", "loadup", "callcard"].includes(name)) {
    const region = workflow.endsWith("_eg") ? "eg" : "sg";
    if (data.region !== region) throw Error("Source fragment region mismatch.");
  }
  if (
    (name === "adjustments" || name === "charges") &&
    data.cycle !== code.slice(4)
  )
    throw Error("Billing line cycle mismatch.");
  return data;
}
