import { test } from "node:test";
import assert from "node:assert/strict";
import { toListResponse } from "../src/tools/list-response.js";

test("no limit returns everything, not truncated", () => {
  const r = toListResponse([1, 2, 3]);
  assert.deepEqual(r, { results: [1, 2, 3], returned: 3, omitted: 0, truncated: false });
});

test("limit larger than length is not truncated", () => {
  const r = toListResponse([1, 2, 3], 10);
  assert.deepEqual(r, { results: [1, 2, 3], returned: 3, omitted: 0, truncated: false });
});

test("limit smaller than length truncates and reports omitted", () => {
  const r = toListResponse([1, 2, 3, 4, 5], 2);
  assert.deepEqual(r, { results: [1, 2], returned: 2, omitted: 3, truncated: true });
});

test("limit exactly equal to length is not truncated", () => {
  const r = toListResponse([1, 2, 3], 3);
  assert.deepEqual(r, { results: [1, 2, 3], returned: 3, omitted: 0, truncated: false });
});

test("empty input yields empty non-truncated envelope", () => {
  const r = toListResponse([], 5);
  assert.deepEqual(r, { results: [], returned: 0, omitted: 0, truncated: false });
});
