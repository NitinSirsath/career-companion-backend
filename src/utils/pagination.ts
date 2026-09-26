import { z } from 'zod';
import { PaginatedResponse } from '../contracts';

export const PAGE_SIZE = 20;
const integer = z
  .string()
  .regex(/^\d+$/)
  .transform(Number)
  .pipe(z.number().int().safe().nonnegative());
const paginationQuery = z.object({
  limit: integer.pipe(z.number().positive()).optional(),
  offset: integer.pipe(z.number().max(2_147_483_627)).optional(),
});

export function getPaginationParams(query: Record<string, unknown>) {
  const parsed = paginationQuery.parse(query);
  return { limit: Math.min(parsed.limit ?? PAGE_SIZE, PAGE_SIZE), offset: parsed.offset ?? 0 };
}

export function createPaginatedResponse<T>(
  items: T[],
  limit: number,
  offset: number,
): PaginatedResponse<T> {
  const hasNext = items.length > limit;
  return {
    items: items.slice(0, limit),
    metadata: { nextOffset: hasNext ? offset + limit : null, limit, offset },
  };
}
