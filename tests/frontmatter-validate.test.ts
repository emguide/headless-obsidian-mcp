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

test("rejects markdown on a later line in a multiline string (heading)", () => {
  assert.throws(
    () => validateFrontmatterValue("a", "plain text\n# heading here"),
    /markdown/i
  );
});

test("rejects markdown on a later line in a multiline string (bullet)", () => {
  assert.throws(
    () => validateFrontmatterValue("a", "plain text\n- bullet here"),
    /markdown/i
  );
});

import { NoteDocument, setFrontmatter } from "../src/tools/note-document.js";

test("setFrontmatter rejects a nested-object value", () => {
  const doc = NoteDocument.parse("---\ntitle: X\n---\nbody\n");
  assert.throws(() => setFrontmatter(doc, { author: { name: "y" } }), /nested object/i);
});

test("setFrontmatter rejects markdown in a value but allows plain scalars", () => {
  const doc = NoteDocument.parse("---\ntitle: X\n---\nbody\n");
  assert.throws(() => setFrontmatter(doc, { note: "[[wiki]]" }), /markdown/i);
  assert.doesNotThrow(() => setFrontmatter(doc, { status: "active", n: 3 }));
});

test("setFrontmatter validates only the keys it writes (legacy value untouched)", () => {
  // Note already has a violating `bad` value; editing an unrelated key succeeds.
  const doc = NoteDocument.parse("---\ntitle: X\nbad:\n  nested: 1\n---\nbody\n");
  assert.doesNotThrow(() => setFrontmatter(doc, { status: "done" }));
});
