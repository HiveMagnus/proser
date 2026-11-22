export interface PaginationOptions { page?: number; pageSize?: number; maxPageSize?: number; }
export interface PaginatedResult<T> { data: T[]; page: number; pageSize: number; total: number; totalPages: number; }

export function getPaginationParams({ page = 1, pageSize = 20, maxPageSize = 100 }: PaginationOptions) {
  const p = Math.max(1, page);
  const ps = Math.min(maxPageSize, Math.max(1, pageSize));
  return { skip: (p - 1) * ps, take: ps, page: p, pageSize: ps };
}
