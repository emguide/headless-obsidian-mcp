import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesWhere } from "../src/tools/property-match.js";

/**
 * An absent frontmatter key used to stringify to "undefined" and be compared
 * lexically, so ordered and containment operators matched notes that did not
 * have the key at all. Because bulk_edit selects through this same matcher,
 * that silently widened destructive batches.
 */
const NO_KEY = { status: "active" } as Record<string, unknown>;

test("ordered operators never match an absent key", () => {
  for (const op of ["gt", "gte", "lt", "lte"] as const) {
    for (const operand of [3, 0, -1, "zebra", "aardvark", "2026-01-01"]) {
      assert.equal(
        matchesWhere(NO_KEY, { priority: { [op]: operand } }),
        false,
        `${op} ${JSON.stringify(operand)} must not match a note without the key`
      );
    }
  }
});

test("contains never matches an absent key", () => {
  // "undefined".includes("def") was the old false positive.
  for (const needle of ["def", "undefined", "e", ""]) {
    assert.equal(
      matchesWhere(NO_KEY, { other: { contains: needle } }),
      false,
      `contains ${JSON.stringify(needle)} must not match a note without the key`
    );
  }
});

test("eq never matches an absent key", () => {
  assert.equal(matchesWhere(NO_KEY, { priority: { eq: 3 } }), false);
  assert.equal(matchesWhere(NO_KEY, { priority: 3 }), false);
});

test("exists still distinguishes absent from present", () => {
  assert.equal(matchesWhere(NO_KEY, { priority: { exists: false } }), true);
  assert.equal(matchesWhere(NO_KEY, { priority: { exists: true } }), false);
  assert.equal(matchesWhere({ priority: 5 }, { priority: { exists: true } }), true);
  // A key explicitly set to null is present, not absent.
  assert.equal(matchesWhere({ priority: null }, { priority: { exists: true } }), true);
});

test("ne is satisfiable by an absent key", () => {
  // A note with no status is indeed not status=done.
  assert.equal(matchesWhere({ other: 1 }, { status: { ne: "done" } }), true);
  assert.equal(matchesWhere({ status: "done" }, { status: { ne: "done" } }), false);
});

test("present keys are unaffected", () => {
  assert.equal(matchesWhere({ priority: 5 }, { priority: { gt: 3 } }), true);
  assert.equal(matchesWhere({ priority: 1 }, { priority: { gt: 3 } }), false);
  assert.equal(matchesWhere({ priority: 3 }, { priority: { gte: 3 } }), true);
  assert.equal(matchesWhere({ priority: 3 }, { priority: { lte: 3 } }), true);
  assert.equal(matchesWhere({ name: "alpha" }, { name: { contains: "lph" } }), true);
  assert.equal(matchesWhere({ tags: ["a", "b"] }, { tags: { contains: "b" } }), true);
  assert.equal(
    matchesWhere({ due: "2026-07-01" }, { due: { lt: "2026-08-01" } }),
    true
  );
});

test("a null value is present but not orderable against a number", () => {
  // null is present, so `exists` sees it; ordered compares against a number
  // must not silently succeed via string coercion.
  assert.equal(matchesWhere({ priority: null }, { priority: { exists: true } }), true);
  assert.equal(matchesWhere({ priority: null }, { priority: { gt: 3 } }), false);
});

test("match:any does not resurrect an absent-key match", () => {
  // With "any", a single satisfied condition is enough — the absent-key
  // condition must not be the one that satisfies it.
  assert.equal(
    matchesWhere(NO_KEY, { priority: { gt: 3 }, missing: { contains: "x" } }, "any"),
    false
  );
  assert.equal(
    matchesWhere(NO_KEY, { priority: { gt: 3 }, status: "active" }, "any"),
    true
  );
});

test("match:all requires every condition, absent keys included", () => {
  assert.equal(
    matchesWhere({ status: "active", priority: 5 }, { status: "active", priority: { gt: 3 } }),
    true
  );
  assert.equal(
    matchesWhere({ status: "active" }, { status: "active", priority: { gt: 3 } }),
    false
  );
});
