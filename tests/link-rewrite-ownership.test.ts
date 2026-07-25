import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { moveNote, renameSectionInVault } from "../src/tools/write.js";

/**
 * move_note and rename_section rewrote any slash-less wikilink whose text
 * equalled the target's basename, without checking the link actually resolved
 * to that note. With `a/log` and `b/log` in a vault, a bare `[[log]]` resolves
 * to `a/log` by the shortest-path rule — so moving `b/log` silently repointed
 * it and broke `a/log`'s backlink.
 */
async function vault(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "link-ownership-"));
  for (const [name, body] of Object.entries(files)) {
    const full = join(dir, name);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, body, "utf-8");
  }
  return dir;
}

test("move_note leaves a bare link that resolves to a different note", async () => {
  const dir = await vault({
    "a/log.md": "log a\n",
    "b/log.md": "log b\n",
    "x.md": "See [[b/log]] and bare [[log]]\n",
  });

  const result = await moveNote(dir, { from: "b/log", to: "c/blog" });

  const x = await readFile(join(dir, "x.md"), "utf-8");
  assert.equal(x, "See [[c/blog]] and bare [[log]]\n");
  assert.equal(result.updated_links, 1, "only the full-path link is ours");
});

test("move_note still rewrites a bare link that does resolve to the moved note", async () => {
  const dir = await vault({
    "a/only.md": "the only one\n",
    "x.md": "bare [[only]] and full [[a/only]]\n",
  });

  const result = await moveNote(dir, { from: "a/only", to: "z/renamed" });

  const x = await readFile(join(dir, "x.md"), "utf-8");
  assert.equal(x, "bare [[renamed]] and full [[z/renamed]]\n");
  assert.equal(result.updated_links, 2);
});

test("move_note preserves the other note's backlink target", async () => {
  const dir = await vault({
    "a/log.md": "log a\n",
    "b/log.md": "log b\n",
    "x.md": "bare [[log]]\n",
  });

  await moveNote(dir, { from: "b/log", to: "c/blog" });

  // The bare link must still address a/log, which is untouched on disk.
  const x = await readFile(join(dir, "x.md"), "utf-8");
  assert.match(x, /\[\[log\]\]/);
  assert.equal(await readFile(join(dir, "a/log.md"), "utf-8"), "log a\n");
});

test("rename_section does not rewrite a backlink note's own self-link", async () => {
  const dir = await vault({
    "target.md": "## Log\ncontent\n",
    "y.md": "Link to [[target#Log]]\n\n## Log\nMy own [[#Log]] self-link\n",
  });

  const result = await renameSectionInVault(dir, {
    path: "target",
    from: "Log",
    to: "Journal",
  });

  const y = await readFile(join(dir, "y.md"), "utf-8");
  // The genuine inbound anchor is rewritten...
  assert.match(y, /\[\[target#Journal\]\]/);
  // ...but y's own [[#Log]] points at y's OWN "## Log", which still exists.
  assert.match(y, /\[\[#Log\]\]/, "a backlink note's self-link must be left alone");
  assert.equal(result.updated_links, 1);
});

test("rename_section still rewrites the renamed note's own self-links", async () => {
  const dir = await vault({
    "target.md": "## Log\nSee [[#Log]] and [[target#Log]]\n",
  });

  const result = await renameSectionInVault(dir, {
    path: "target",
    from: "Log",
    to: "Journal",
  });

  const raw = await readFile(join(dir, "target.md"), "utf-8");
  assert.match(raw, /## Journal/);
  assert.match(raw, /\[\[#Journal\]\]/, "own bare self-link is rewritten");
  assert.match(raw, /\[\[target#Journal\]\]/, "own full self-reference is rewritten");
  assert.equal(result.updated_notes, 0, "no other note was touched");
  assert.equal(result.updated_links, 2);
});

test("rename_section ignores a bare anchor owned by a same-basename note", async () => {
  const dir = await vault({
    "a/log.md": "## Log\na content\n",
    "b/log.md": "## Log\nb content\n",
    // A bare [[log#Log]] resolves to a/log (shortest path), not b/log.
    "x.md": "See [[log#Log]] and [[b/log#Log]]\n",
  });

  await renameSectionInVault(dir, { path: "b/log", from: "Log", to: "Journal" });

  const x = await readFile(join(dir, "x.md"), "utf-8");
  assert.match(x, /\[\[log#Log\]\]/, "bare link resolving to a/log must be untouched");
  assert.match(x, /\[\[b\/log#Journal\]\]/, "the explicit b/log anchor is rewritten");
});
