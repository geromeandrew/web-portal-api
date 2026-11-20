import { z } from "zod";
import { convertLegacyReference } from "../domain/referenceConverter.js";
import { PrepaidStorage, sha256 } from "../infrastructure/prepaidStorage.js";

import { referenceExportSchema } from "../domain/contracts.js";
export { referenceExportSchema } from "../domain/contracts.js";
/** Adapter component for an authorized immutable DataGarage export, not a source approval. */
export class PrepaidReferenceProvider {
  constructor(readonly storage: PrepaidStorage) {}
  async load(request: z.infer<typeof referenceExportSchema>, period: string) {
    const descriptor = referenceExportSchema.parse(request);
    const bytes = await this.storage.bytes(
      descriptor.key,
      descriptor.prefix,
      20 * 1024 * 1024,
    );
    if (sha256(bytes) !== descriptor.sha256)
      throw Error("Reference source checksum mismatch.");
    const converted = convertLegacyReference(bytes, period);
    if (converted.report.inputRows !== descriptor.rowCount)
      throw Error("Reference source row count mismatch.");
    return {
      ...converted,
      source: {
        key: descriptor.key,
        sha256: descriptor.sha256,
        rowCount: descriptor.rowCount,
      },
    };
  }
}
