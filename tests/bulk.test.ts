import { test } from "node:test";
import assert from "node:assert/strict";
import { before, after } from "node:test";
import { NoteDocument } from "../src/tools/note-document.js";
import { validateOperations, applyOperations, resolveSelection } from "../src/tools/bulk.js";
import { makeVault, sampleNotes, type Fixture } from "./fixtures.js";

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

let fx: Fixture;
before(async () => {
  fx = await makeVault(sampleNotes());
});
after(async () => {
  await fx.cleanup();
});

test("resolveSelection returns explicit paths canonicalized", async () => {
  const paths = await resolveSelection(fx.vaultPath, { paths: ["projects/alpha.md", "index"] });
  assert.deepEqual(paths.sort(), ["index", "projects/alpha"]);
});

test("resolveSelection by where filter", async () => {
  const paths = await resolveSelection(fx.vaultPath, { where: { status: "active" } });
  assert.deepEqual(paths, ["projects/alpha"]);
});

test("resolveSelection by tag filter", async () => {
  const paths = await resolveSelection(fx.vaultPath, { tags: ["productivity"] });
  assert.ok(paths.includes("projects/alpha"));
  assert.ok(paths.includes("Beta Note"));
});

test("resolveSelection folder scope with a filter", async () => {
  const paths = await resolveSelection(fx.vaultPath, { folder: "projects", tags: ["project"] });
  assert.deepEqual(paths, ["projects/alpha"]);
});

test("resolveSelection rejects paths + filter together", async () => {
  await assert.rejects(
    () => resolveSelection(fx.vaultPath, { paths: ["a"], where: { status: "x" } }),
    /not both/
  );
});

test("resolveSelection rejects an empty select", async () => {
  await assert.rejects(() => resolveSelection(fx.vaultPath, {}), /requires/);
});
