import { z } from "zod";
import {
  sourceCodes,
  sourceFileRequirement,
  expectedName,
  prepaidBatchBillCycles,
} from "./contracts.js";

// A collection marker, deliberately NOT a processing configuration. It contains
// no assumed billing coverage, SAP records, export approval or AWS permission.
export const uploadCollectionConfiguration = {
  collectionOnly: true,
  contractVersion: 1,
} as const;
const collectionSchema = z
  .object({
    collectionOnly: z.literal(true),
    contractVersion: z.literal(1),
  })
  .strict();
export const isUploadCollection = (value: unknown) =>
  collectionSchema.safeParse(value).success;

/** Names accepted for storage before required cycle coverage is configured. */
export function uploadCollectionSources() {
  return [
    ...sourceCodes,
    ...prepaidBatchBillCycles.flatMap((cycle) => [`308_${cycle}`, `318_${cycle}`]),
  ].map(sourceFileRequirement);
}
export function uploadCollectionGuidelines() {
  return [
    ...sourceCodes.map(expectedName),
    expectedName("308_{cycle}"),
    expectedName("318_{cycle}"),
  ];
}
export const uploadCollectionMessage =
  "You can upload source files now. Files are saved in your workspace; automatic preparation waits for the administrator's reference, billing-cycle and export configuration. Uploading does not approve those settings.";
