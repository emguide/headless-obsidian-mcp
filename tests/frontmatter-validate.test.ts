import { test } from "node:test";
import assert from "node:assert/strict";
import { validateFrontmatterValue } from "../src/tools/note-document.js";

test("accepts scalars, null, and flat scalar arrays", () => {
  assert.doesNotThrow(() => validateFrontmatterValue("a", "text"));
  assert.doesNotThrow(() => validateFrontmatterValue("a", 3));
  assert.doesNotThrow(() => validateFrontmatterValue("a", true));
  assert.doesNotThrow(() => validateFrontmatterValue("a", null));
  assert.doesNotThrow(() => validateFrontmatterValue("a", ["x", 1, false]));
});

test("accepts a bare URL and plain text (not markdown)", () => {
  assert.doesNotThrow(() => validateFrontmatterValue("url", "https://example.com/a_b"));
  assert.doesNotThrow(() => validateFrontmatterValue("s", "a - b (c) plain"));
});

test("rejects a nested object at top level", () => {
  assert.throws(() => validateFrontmatterValue("a", { x: 1 }), /nested object/i);
});

test("rejects an object nested inside an array", () => {
  assert.throws(() => validateFrontmatterValue("a", [{ x: 1 }]), /nested object|non-scalar/i);
});

test("rejects an array nested inside an array", () => {
  assert.throws(() => validateFrontmatterValue("a", [[1, 2]]), /non-scalar/i);
});

test("rejects markdown syntax in a string value", () => {
  assert.throws(() => validateFrontmatterValue("a", "see [[Note]]"), /markdown/i);
  assert.throws(() => validateFrontmatterValue("a", "![[embed.png]]"), /markdown/i);
  assert.throws(() => validateFrontmatterValue("a", "a [link](http://x)"), /markdown/i);
  assert.throws(() => validateFrontmatterValue("a", "**bold**"), /markdown/i);
  assert.throws(() => validateFrontmatterValue("a", "text `code` here"), /markdown/i);
  assert.throws(() => validateFrontmatterValue("a", "# heading"), /markdown/i);
  assert.throws(() => validateFrontmatterValue("a", "- bullet"), /markdown/i);
});

test("rejects markdown syntax inside a string array element", () => {
  assert.throws(() => validateFrontmatterValue("a", ["ok", "[[bad]]"]), /markdown/i);
});
