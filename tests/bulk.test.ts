import { test } from "node:test";
import assert from "node:assert/strict";
import { NoteDocument } from "../src/tools/note-document.js";
import { validateOperations, applyOperations } from "../src/tools/bulk.js";

test("validateOperations rejects an unknown op", () => {
  assert.throws(() => validateOperations([{ op: "frobnicate" }]), /unknown op/i);
});

test("validateOperations rejects a non-array", () => {
  assert.throws(() => validateOperations({}), /operations must be a non-empty array/);
});

test("validateOperations requires args for each op", () => {
  assert.throws(() => validateOperations([{ op: "add_tag" }]), /tags must be a non-empty array/);
  assert.throws(() => validateOperations([{ op: "rename_property", from: "a" }]), /to must be a non-empty string/);
});

test("applyOperations applies multiple ops in order and reports change", () => {
  const doc = NoteDocument.parse("---\nstatus: draft\n---\n# Body\n");
  const changed = applyOperations(doc, [
    { op: "add_tag", tags: ["review"] },
    { op: "set_frontmatter", set: { status: "active" } },
  ]);
  assert.equal(changed, true);
  const out = doc.serialize();
  assert.match(out, /status: active/);
  assert.match(out, /- review/);
});

test("applyOperations returns false when every op is a no-op", () => {
  const doc = NoteDocument.parse("---\ntags:\n  - review\n---\n# Body\n");
  const changed = applyOperations(doc, [{ op: "add_tag", tags: ["review"] }]);
  assert.equal(changed, false);
});
