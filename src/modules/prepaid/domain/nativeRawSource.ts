import type { SourceWorkflow } from "./sourceExtraction.js";
import type { SourceResources } from "./sourceResources.js";

export const glueFinancialSource = "glue_raw_v1" as const;
export class GlueRawSourceValidationError extends Error {}
export type RawRow = Record<string, string | null>;
export type RawCapture = {
  contract: typeof glueFinancialSource;
  executionArn: string;
  connectionName: string;
  jobs: {
    name: string;
    id: string;
    startedAt: string;
    completedAt: string;
    table: string;
  }[];
  tables: Record<string, RawRow[]>;
  rowCounts?: Record<string, number>;
};
export type RawCaptureRequest = {
  workflow: SourceWorkflow;
  executionArn: string;
  envPrefix: string;
  resources?: SourceResources;
  sources: { id: string; code: string }[];
  bucket: string;
};
export interface GlueRawSourceReader {
  verifyAccess?(settings: {
    envPrefix: string;
    resources?: SourceResources;
  }): Promise<void>;
  capture(request: RawCaptureRequest): Promise<RawCapture>;
}
export function rawSourceFilename(filename: string) {
  // The unchanged wildcard wrapper records "actual file - sequential alias".
  return filename.split(" - ")[0];
}
