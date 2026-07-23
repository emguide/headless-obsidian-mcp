import { test } from "node:test";
import assert from "node:assert/strict";
import { toListResponse, assertNonNegativeInt } from "../src/tools/list-response.js";

test("no limit returns everything, not truncated", () => {
  const r = toListResponse([1, 2, 3]);
  assert.deepEqual(r, { results: [1, 2, 3], returned: 3, skipped: 0, omitted: 0, truncated: false });
});

test("limit larger than length is not truncated", () => {
  const r = toListResponse([1, 2, 3], 10);
  assert.deepEqual(r, { results: [1, 2, 3], returned: 3, skipped: 0, omitted: 0, truncated: false });
});

test("limit smaller than length truncates and reports omitted", () => {
  const r = toListResponse([1, 2, 3, 4, 5], 2);
  assert.deepEqual(r, { results: [1, 2], returned: 2, skipped: 0, omitted: 3, truncated: true });
});

test("limit exactly equal to length is not truncated", () => {
  const r = toListResponse([1, 2, 3], 3);
  assert.deepEqual(r, { results: [1, 2, 3], returned: 3, skipped: 0, omitted: 0, truncated: false });
});

test("empty input yields empty non-truncated envelope", () => {
  const r = toListResponse([], 5);
  assert.deepEqual(r, { results: [], returned: 0, skipped: 0, omitted: 0, truncated: false });
});

test("offset window in the middle reports skipped-before and omitted-after", () => {
  const r = toListResponse([1, 2, 3, 4, 5], 2, 1);
  assert.deepEqual(r, { results: [2, 3], returned: 2, skipped: 1, omitted: 2, truncated: true });
});

test("offset with unbounded limit skips then returns the rest", () => {
  const r = toListResponse([1, 2, 3, 4, 5], undefined, 2);
  assert.deepEqual(r, { results: [3, 4, 5], returned: 3, skipped: 2, omitted: 0, truncated: false });
});

test("offset consuming the whole tail leaves an empty non-truncated window", () => {
  const r = toListResponse([1, 2, 3], 10, 3);
  assert.deepEqual(r, { results: [], returned: 0, skipped: 3, omitted: 0, truncated: false });
});

test("offset past the end is clamped, not an error", () => {
  const r = toListResponse([1, 2, 3], 10, 99);
  assert.deepEqual(r, { results: [], returned: 0, skipped: 3, omitted: 0, truncated: false });
});

test("total is recoverable as skipped + returned + omitted", () => {
  const r = toListResponse([1, 2, 3, 4, 5, 6, 7], 3, 2);
  assert.equal(r.skipped + r.returned + r.omitted, 7);
  assert.deepEqual(r.results, [3, 4, 5]);
});

test("assertNonNegativeInt accepts 0, undefined, and positives", () => {
  assert.doesNotThrow(() => assertNonNegativeInt(0, "offset"));
  assert.doesNotThrow(() => assertNonNegativeInt(undefined, "offset"));
  assert.doesNotThrow(() => assertNonNegativeInt(5, "offset"));
});

test("assertNonNegativeInt rejects negatives and non-integers, naming the field", () => {
  assert.throws(() => assertNonNegativeInt(-1, "offset"), /offset must be a non-negative integer/);
  assert.throws(() => assertNonNegativeInt(1.5, "offset"), /offset must be a non-negative integer/);
  assert.throws(() => assertNonNegativeInt(-2, "limit"), /limit must be a non-negative integer/);
});
