import { z } from "zod";
export const uuid = z.string().uuid();
export const page = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().nonnegative().default(0),
  revisionId: uuid.optional(),
});
