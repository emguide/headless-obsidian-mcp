import { test } from "node:test";
import assert from "node:assert/strict";
import { NoteDocument, renameSection } from "../src/tools/note-document.js";

test("renameSection rewrites only the heading line and returns old text", () => {
  const doc = NoteDocument.parse("# Doc\n\n## Old Title\n\nbody\n\n## Keep\n\nx\n");
  const old = renameSection(doc, "Old Title", "New Title");
  assert.equal(old, "Old Title");
  assert.match(doc.body, /## New Title/);
  assert.doesNotMatch(doc.body, /Old Title/);
  assert.match(doc.body, /## Keep/); // untouched
  assert.match(doc.body, /\nbody\n/); // body untouched
});

test("renameSection preserves heading level", () => {
  const doc = NoteDocument.parse("#### Deep\n\ntext\n");
  renameSection(doc, "Deep", "Deeper");
  assert.match(doc.body, /^#### Deeper$/m);
});

test("renameSection resolves a heading-path", () => {
  const doc = NoteDocument.parse("# A\n\n## Log\n\n### Log\n\ninner\n");
  const old = renameSection(doc, "A > Log", "Journal");
  assert.equal(old, "Log");
  assert.match(doc.body, /^## Journal$/m);
  assert.match(doc.body, /^### Log$/m); // the nested one is untouched
});

test("renameSection throws on ambiguous bare heading", () => {
  const doc = NoteDocument.parse("# A\n\n## Log\n\n## Log\n\n");
  assert.throws(() => renameSection(doc, "Log", "X"), /Ambiguous section/);
});

test("renameSection throws on missing heading", () => {
  const doc = NoteDocument.parse("# A\n\nno headings here beyond A\n");
  assert.throws(() => renameSection(doc, "Nope", "X"), /not found/);
});
