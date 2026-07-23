import { ListResponse } from "../types.js";

/**
 * Wrap a fully-materialized result set in the standard list envelope, applying
 * `limit` (undefined = no limit) and reporting how many rows were dropped.
 * Every list-style tool funnels through this so the envelope fields never drift.
 */
export function toListResponse<T>(fullRows: T[], limit?: number): ListResponse<T> {
  const results = limit !== undefined ? fullRows.slice(0, limit) : fullRows;
  const omitted = fullRows.length - results.length;
  return {
    results,
    returned: results.length,
    omitted,
    truncated: omitted > 0,
  };
}
