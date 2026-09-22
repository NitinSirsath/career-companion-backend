import { z } from 'zod';

export function createPaginatedResponseSchema<T extends z.ZodTypeAny>(itemSchema: T) {
  return z.object({
    items: z.array(itemSchema),
    metadata: z.object({
      nextOffset: z.number().nullable(),
      limit: z.number(),
      offset: z.number(),
    }),
  });
}

export interface PaginatedResponse<T> {
  items: T[];
  metadata: {
    nextOffset: number | null;
    limit: number;
    offset: number;
  };
}
