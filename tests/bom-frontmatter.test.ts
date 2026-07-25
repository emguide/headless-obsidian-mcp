import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NoteDocument } from "../src/tools/note-document.js";
import { addTag, removeTag, setNoteFrontmatter, prependNote } from "../src/tools/write.js";
import { getFrontmatter } from "../src/tools/frontmatter.js";

/**
 * gray-matter strips a UTF-8 BOM before parsing, but NoteDocument's FENCE was
 * anchored at `---`. So readers saw a BOM note's frontmatter while writes
 * parsed `{}` — and gray-matter's stringify merge then let that empty object
 * overwrite the real block, destroying existing tags. BOM-prefixed files are
 * routine output from Windows Notepad and PowerShell redirection.
 */
const BOM = "﻿";

async function vaultWithBomNote(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bom-fm-"));
  await writeFile(join(dir, "n.md"), BOM + body, "utf-8");
  return dir;
}

test("NoteDocument sees frontmatter through a BOM", () => {
  const doc = NoteDocument.parse(`${BOM}---\ntags:\n  - a\n---\nbody\n`);
  assert.deepEqual(doc.data.tags, ["a"]);
  assert.equal(doc.body, "body\n");
});

test("hasFrontmatterFence is true for a BOM note", () => {
  assert.equal(NoteDocument.hasFrontmatterFence(`${BOM}---\na: 1\n---\nb\n`), true);
  assert.equal(NoteDocument.hasFrontmatterFence(`${BOM}no fence\n`), false);
});

test("add_tag preserves existing tags on a BOM note", async () => {
  const dir = await vaultWithBomNote("---\ntags:\n  - a\n  - b\n---\nbody\n");
  const result = await addTag(dir, { path: "n", tags: ["c"] });
  assert.deepEqual(result.tags, ["a", "b", "c"], "existing tags must survive");

  const raw = await readFile(join(dir, "n.md"), "utf-8");
  assert.match(raw, /- a\n/);
  assert.match(raw, /- b\n/);
  assert.match(raw, /- c\n/);
});

test("the BOM itself is preserved on rewrite", async () => {
  const dir = await vaultWithBomNote("---\ntags:\n  - a\n---\nbody\n");
  await addTag(dir, { path: "n", tags: ["c"] });
  const buf = await readFile(join(dir, "n.md"));
  assert.equal(buf[0], 0xef);
  assert.equal(buf[1], 0xbb);
  assert.equal(buf[2], 0xbf);
});

test("remove_tag actually removes on a BOM note", async () => {
  const dir = await vaultWithBomNote("---\ntags:\n  - a\n  - b\n---\nbody\n");
  const result = await removeTag(dir, { path: "n", tags: ["a"] });
  assert.deepEqual(result.tags, ["b"]);
  const raw = await readFile(join(dir, "n.md"), "utf-8");
  assert.doesNotMatch(raw, /- a\n/);
});

test("set_frontmatter unset works on a BOM note", async () => {
  const dir = await vaultWithBomNote("---\nstatus: draft\nkeep: yes\n---\nbody\n");
  await setNoteFrontmatter(dir, { path: "n", unset: ["status"] });
  const raw = await readFile(join(dir, "n.md"), "utf-8");
  assert.doesNotMatch(raw, /status:/);
  assert.match(raw, /keep:/);
});

test("prepend_note inserts after the frontmatter, never above the fence", async () => {
  const dir = await vaultWithBomNote("---\ntags:\n  - a\n---\nbody\n");
  await prependNote(dir, { path: "n", content: "> banner" });

  const raw = await readFile(join(dir, "n.md"), "utf-8");
  const withoutBom = raw.startsWith(BOM) ? raw.slice(1) : raw;
  assert.ok(withoutBom.startsWith("---"), "frontmatter fence must stay first");
  const fenceEnd = withoutBom.indexOf("\n---", 3);
  assert.ok(
    withoutBom.indexOf("> banner") > fenceEnd,
    "prepended text must land in the body, not above the fence"
  );
});

test("readers and writers agree about a BOM note's frontmatter", async () => {
  const dir = await vaultWithBomNote("---\ntags:\n  - a\nstatus: draft\n---\nbody\n");
  const read = await getFrontmatter(dir, "n");
  const doc = NoteDocument.parse(await readFile(join(dir, "n.md"), "utf-8"));
  assert.deepEqual(read.frontmatter.tags, doc.data.tags);
  assert.equal(read.frontmatter.status, doc.data.status);
});

test("notes without a BOM are unchanged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bom-fm-plain-"));
  await writeFile(join(dir, "n.md"), "---\ntags:\n  - a\n---\nbody\n", "utf-8");
  await addTag(dir, { path: "n", tags: ["c"] });
  const buf = await readFile(join(dir, "n.md"));
  assert.notEqual(buf[0], 0xef, "no BOM must be introduced");
  assert.match(buf.toString("utf-8"), /^---\n/);
});
