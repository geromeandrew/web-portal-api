import { z } from "zod";

/** Content-addressed identity, portable between databases without an S3 URI. */
export const referenceVersionSchema = z
  .object({
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    rowCount: z.number().int().positive().max(250000),
    approved: z.literal(true),
  })
  .strict();
export type ReferenceVersion = z.infer<typeof referenceVersionSchema>;
export const referenceImportSchema = z
  .object({
    period: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
      .refine((x) => !x.startsWith("0000-")),
    label: z.string().trim().min(1).max(200),
    sha256: referenceVersionSchema.shape.sha256,
    rowCount: referenceVersionSchema.shape.rowCount,
    approved: z.literal(true),
    approvalScope: z.enum(["development-testing", "accounting-accepted"]),
    provenance: z.record(z.string(), z.unknown()),
  })
  .strict();
