import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  writeNote,
  appendNote,
  patchNote,
  addNoteSection,
  appendNoteSection,
  replaceNoteSection,
} from "../src/tools/write.js";
import { makeVault, Fixture } from "./fixtures.js";

// A target note that exists (with a heading) so links can resolve or not.
let fx: Fixture;
before(async () => {
  fx = await makeVault([
    { path: "target.md", content: ["# Target", "", "## Real Section", "body"].join("\n") },
    { path: "editable.md", content: ["# Editable", "", "## Log", "old"].join("\n") },
  ]);
});
after(() => fx.cleanup());

/* --------------------------------------------------------- unresolved -- */

test("write_note reports an unresolved wikilink target", async () => {
  const r = await writeNote(fx.vaultPath, {
    path: "note1",
    content: "# Note1\n\nLinks to [[Nonexistent Note]] and [[target]].\n",
  });
  assert.deepEqual(r.unresolved_links, ["Nonexistent Note"]);
  assert.deepEqual(r.broken_anchors, []);
});

test("write_note reports a clean write with empty arrays", async () => {
  const r = await writeNote(fx.vaultPath, {
    path: "note-clean",
    content: "# Clean\n\nLinks only to [[target]].\n",
  });
  assert.deepEqual(r.unresolved_links, []);
  assert.deepEqual(r.broken_anchors, []);
});

test("write_note picks up a target created earlier in the same session", async () => {
  await writeNote(fx.vaultPath, { path: "brand-new", content: "# Brand New\n" });
  const r = await writeNote(fx.vaultPath, {
    path: "note-refs-new",
    content: "# Refs\n\nSee [[brand-new]].\n",
  });
  assert.deepEqual(r.unresolved_links, []);
});

/* ------------------------------------------------------ broken anchors -- */

test("write_note reports a broken anchor on a resolved note", async () => {
  const r = await writeNote(fx.vaultPath, {
    path: "note2",
    content: "# Note2\n\nSee [[target#Missing Heading]] and [[target#Real Section]].\n",
  });
  assert.deepEqual(r.unresolved_links, []);
  assert.deepEqual(r.broken_anchors, [{ target: "target", anchor: "Missing Heading" }]);
});

test("write_note: an anchor into an unresolved note is unresolved, not a broken anchor", async () => {
  const r = await writeNote(fx.vaultPath, {
    path: "note3",
    content: "# Note3\n\nSee [[Ghost#Some Heading]].\n",
  });
  assert.deepEqual(r.unresolved_links, ["Ghost"]);
  assert.deepEqual(r.broken_anchors, []);
});

test("write_note: block-ref anchors are never reported as broken", async () => {
  const r = await writeNote(fx.vaultPath, {
    path: "note4",
    content: "# Note4\n\nSee [[target#^blockid]].\n",
  });
  assert.deepEqual(r.unresolved_links, []);
  assert.deepEqual(r.broken_anchors, []);
});

/* --------------------------------------------------------- self-anchors -- */

test("write_note: a valid self-anchor to an own heading is clean", async () => {
  const r = await writeNote(fx.vaultPath, {
    path: "selfok",
    content: "# Selfok\n\n## Contents\n\nJump to [[#Contents]].\n",
  });
  assert.deepEqual(r.unresolved_links, []);
  assert.deepEqual(r.broken_anchors, []);
});

test("write_note: a self-anchor to a missing own heading is a broken anchor", async () => {
  const r = await writeNote(fx.vaultPath, {
    path: "selfbad",
    content: "# Selfbad\n\n## Contents\n\nJump to [[#Nope]].\n",
  });
  assert.deepEqual(r.unresolved_links, []);
  assert.deepEqual(r.broken_anchors, [{ target: "", anchor: "Nope" }]);
});

/* ----------------------------------------------------------- other tools -- */

test("append_note reports links in the appended text", async () => {
  const r = await appendNote(fx.vaultPath, {
    path: "editable",
    content: "\nA new [[Dangling]] reference.\n",
  });
  assert.deepEqual(r.unresolved_links, ["Dangling"]);
});

test("patch_note reports a link introduced by the patch", async () => {
  await writeNote(fx.vaultPath, { path: "patchme", content: "# Patchme\n\nplaceholder\n" });
  const r = await patchNote(fx.vaultPath, {
    path: "patchme",
    find: "placeholder",
    replace: "[[Typoed Link]]",
  });
  assert.equal(r.replacements, 1);
  assert.deepEqual(r.unresolved_links, ["Typoed Link"]);
});

// The report covers the WHOLE resulting note (documented), so each section
// test uses its own fresh note to avoid accumulating links across tests.

test("add_section reports links in the new section", async () => {
  await writeNote(fx.vaultPath, { path: "sec-add", content: "# Sec Add\n\n## Intro\n\nhi\n" });
  const r = await addNoteSection(fx.vaultPath, {
    path: "sec-add",
    heading: "Refs",
    content: "See [[Also Missing]].",
  });
  assert.deepEqual(r.unresolved_links, ["Also Missing"]);
});

test("append_to_section reports links, and a clean append is empty", async () => {
  await writeNote(fx.vaultPath, { path: "sec-append", content: "# Sec Append\n\n## Log\n\nstart\n" });
  const bad = await appendNoteSection(fx.vaultPath, {
    path: "sec-append",
    heading: "Log",
    content: "linked [[Still Missing]]",
  });
  assert.deepEqual(bad.unresolved_links, ["Still Missing"]);
});

test("a fully-resolving note reports no unresolved links", async () => {
  await writeNote(fx.vaultPath, { path: "sec-clean", content: "# Sec Clean\n\n## Log\n\nstart\n" });
  const good = await appendNoteSection(fx.vaultPath, {
    path: "sec-clean",
    heading: "Log",
    content: "resolves to [[target]]",
  });
  assert.deepEqual(good.unresolved_links, []);
});

test("replace_section reports links in the replacement body", async () => {
  await writeNote(fx.vaultPath, { path: "sec-replace", content: "# Sec Replace\n\n## Log\n\nold body\n" });
  const r = await replaceNoteSection(fx.vaultPath, {
    path: "sec-replace",
    heading: "Log",
    content: "now points at [[target#Missing Heading]]",
  });
  assert.deepEqual(r.broken_anchors, [{ target: "target", anchor: "Missing Heading" }]);
});
