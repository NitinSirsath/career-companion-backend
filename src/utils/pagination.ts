import { PaginatedResponse } from '../contracts';

export function getPaginationParams(query: Record<string, any>, defaultLimit = 20, maxLimit = 20) {
  const limit = Math.min(Math.max(parseInt(query.limit as string) || defaultLimit, 1), maxLimit);
  const offset = Math.max(parseInt(query.offset as string) || 0, 0);
  return { limit, offset };
}

export function createPaginatedResponse<T>(items: T[], limit: number, offset: number): PaginatedResponse<T> {
  const hasNext = items.length > limit;
  const actualItems = hasNext ? items.slice(0, limit) : items;
  
  return {
    items: actualItems,
    metadata: {
      nextOffset: hasNext ? offset + limit : null,
      limit,
      offset,
    }
  };
}
