import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { convertLegacyReference } from "./modules/prepaid/domain/referenceConverter.js";

// Explicit operator utility. Never reads .env, connects to DB, uploads, or approves data.
const [input, period, destination] = process.argv.slice(2);
if (!input || !period || !destination)
  throw Error(
    "Usage: convertPrepaidReference <legacy.jsonl> <YYYY-MM> <output.jsonl>",
  );
const target = resolve(destination),
  report = target + ".report.json",
  provenance = target + ".provenance.jsonl";
if ([target, report, provenance].some(existsSync))
  throw Error("Refusing to overwrite existing output files.");
const converted = convertLegacyReference(readFileSync(resolve(input)), period);
writeFileSync(target, converted.output, { flag: "wx" });
writeFileSync(report, JSON.stringify(converted.report, null, 2) + "\n", {
  flag: "wx",
});
writeFileSync(
  provenance,
  converted.provenance.map((r) => JSON.stringify(r)).join("\n") + "\n",
  { flag: "wx" },
);
console.log(JSON.stringify(converted.report));
