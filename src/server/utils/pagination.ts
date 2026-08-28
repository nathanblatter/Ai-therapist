// Shared query-string pagination parsing. The per-route copies had drifted
// into distinct bug families (NaN offsets when a param was absent, unclamped
// limits, parseInt('0')||d quirks); this keeps the policy per-route (each
// caller passes its own defaults/max) but the parsing uniform.

export interface PaginationOptions {
  defaultLimit: number;
  /** Hard ceiling; a larger requested limit is clamped, not rejected. */
  maxLimit: number;
  defaultOffset?: number;
}

export interface Pagination {
  limit: number;
  offset: number;
  /** 1-based page (from ?page=), for the routes that paginate by page. */
  page: number;
}

function toPositiveInt(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * Parse limit/offset/page from a route's query object. Missing or invalid
 * values (NaN, negatives, zero for limit/page) fall back to the defaults;
 * limit is clamped to maxLimit.
 */
export function parsePagination(
  query: Record<string, unknown>,
  { defaultLimit, maxLimit, defaultOffset = 0 }: PaginationOptions
): Pagination {
  const limit = Math.min(toPositiveInt(query.limit) ?? defaultLimit, maxLimit);
  const offsetRaw = Number(query.offset);
  const offset = Number.isInteger(offsetRaw) && offsetRaw >= 0 && query.offset !== undefined && query.offset !== ''
    ? offsetRaw
    : defaultOffset;
  const page = toPositiveInt(query.page) ?? 1;
  return { limit, offset, page };
}
