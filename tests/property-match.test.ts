import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesWhere } from "../src/tools/property-match.js";

const fm = { status: "active", priority: 5, due: "2026-08-01", aliases: ["a", "b"] };

test("bare scalar means equality (case-insensitive)", () => {
  assert.equal(matchesWhere(fm, { status: "ACTIVE" }), true);
  assert.equal(matchesWhere(fm, { status: "done" }), false);
});

test("bare scalar matches an array member", () => {
  assert.equal(matchesWhere(fm, { aliases: "a" }), true);
  assert.equal(matchesWhere(fm, { aliases: "z" }), false);
});

test("numeric comparisons are numeric, not lexical", () => {
  assert.equal(matchesWhere(fm, { priority: { gt: 3 } }), true);
  assert.equal(matchesWhere(fm, { priority: { gte: 5 } }), true);
  assert.equal(matchesWhere(fm, { priority: { lt: 5 } }), false);
});

test("date comparisons are chronological", () => {
  assert.equal(matchesWhere(fm, { due: { lt: "2026-09-01" } }), true);
  assert.equal(matchesWhere(fm, { due: { gt: "2026-09-01" } }), false);
});

test("eq / ne operators", () => {
  assert.equal(matchesWhere(fm, { status: { eq: "active" } }), true);
  assert.equal(matchesWhere(fm, { status: { ne: "active" } }), false);
});

test("exists tests key presence", () => {
  assert.equal(matchesWhere(fm, { status: { exists: true } }), true);
  assert.equal(matchesWhere(fm, { missing: { exists: false } }), true);
  assert.equal(matchesWhere(fm, { missing: { exists: true } }), false);
});

test("contains tests array membership and string substring", () => {
  assert.equal(matchesWhere(fm, { aliases: { contains: "b" } }), true);
  assert.equal(matchesWhere(fm, { status: { contains: "activ" } }), true);
  assert.equal(matchesWhere(fm, { aliases: { contains: "z" } }), false);
});

test("match all vs any", () => {
  const w = { status: "active", priority: { gt: 9 } };
  assert.equal(matchesWhere(fm, w, "all"), false);
  assert.equal(matchesWhere(fm, w, "any"), true);
});
