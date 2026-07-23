import { ListResponse } from "../types.js";

/**
 * Validate a non-negative integer bound (`limit` / `offset`). `undefined` is
 * allowed (the caller applies its own default); anything else must be an
 * integer >= 0. `0` is valid (unbounded limit / no offset).
 */
export function assertNonNegativeInt(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
    throw new Error(`${name} must be a non-negative integer`);
  }
}

/**
 * Wrap a fully-materialized result set in the standard list envelope. A window
 * `[offset, offset + limit)` is sliced out of `fullRows`: `skipped` reports the
 * rows dropped before the window (the effect of `offset`), `omitted` reports the
 * rows dropped after it (the effect of `limit`). `limit === undefined` means no
 * upper bound; `offset` defaults to 0. Every list-style tool funnels through
 * this so the envelope fields never drift.
 */
export function toListResponse<T>(
  fullRows: T[],
  limit?: number,
  offset = 0
): ListResponse<T> {
  const skipped = Math.min(offset, fullRows.length);
  const afterSkip = fullRows.slice(skipped);
  const results = limit !== undefined ? afterSkip.slice(0, limit) : afterSkip;
  const omitted = afterSkip.length - results.length;
  return {
    results,
    returned: results.length,
    skipped,
    omitted,
    truncated: omitted > 0,
  };
}
