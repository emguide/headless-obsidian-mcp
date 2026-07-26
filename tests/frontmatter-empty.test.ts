import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseMatter, stringifyMatter } from "../src/tools/matter-safe.js";
import { writeNote, addTag, setNoteFrontmatter } from "../src/tools/write.js";

/**
 * js-yaml dumps `""` as `key: ''`; Obsidian's own property editor writes an
 * empty property as a bare `key:`. Every note this server created therefore
 * carried a quoting artifact no Obsidian-authored note has, which agents were
 * hand-patching away after each write.
 */
async function vault(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "fm-empty-"));
}

test("a top-level empty string serializes as a bare key, with no trailing space", () => {
  const out = stringifyMatter("body\n", { name: "", role: "", title: "Jane" });
  assert.equal(out, "---\nname:\nrole:\ntitle: Jane\n---\nbody\n");
  // Explicitly: no `''`, and no `key: ` leaving whitespace at end of line.
  assert.doesNotMatch(out, /''/);
  assert.doesNotMatch(out, /[ \t]$/m);
});

test("empty array ELEMENTS keep their quotes — a bare `-` would mean null", () => {
  const out = stringifyMatter("body\n", { tags: ["a", ""] });
  assert.match(out, /- ''\n/);
  assert.deepEqual(parseMatter(out).data.tags, ["a", ""]);
});

test("date-only values still round-trip alongside an emptied key", () => {
  const out = stringifyMatter("body\n", {
    name: "",
    created: new Date("2026-07-25T00:00:00.000Z"),
  });
  assert.match(out, /^name:$/m);
  assert.match(out, /^created: 2026-07-25$/m);
});

test("a bare key reads back as null — the accepted round-trip consequence", () => {
  const out = stringifyMatter("body\n", { name: "" });
  // Obsidian presents both an empty string and null as the same empty
  // property, which is why this trade is acceptable; assert it rather than
  // leave a future reader to discover it.
  assert.deepEqual(parseMatter(out).data, { name: null });
});

test("content containing the placeholder falls back to plain quoting", () => {
  // The token must never be restorable out of real content, so a collision
  // disables the rewrite entirely rather than corrupting the note.
  const out = stringifyMatter("mentions __obsidian_mcp_empty__ here\n", { name: "" });
  assert.match(out, /name: ''\n/);
  assert.match(out, /mentions __obsidian_mcp_empty__ here/);
});

test("write_note lands bare keys on disk for structured empty frontmatter", async () => {
  const dir = await vault();
  await writeNote(dir, {
    path: "people/jane",
    content: "# Jane\n",
    frontmatter: { name: "", role: "", title: "Jane" },
  });
  const raw = await readFile(join(dir, "people/jane.md"), "utf-8");
  assert.match(raw, /^name:$/m);
  assert.match(raw, /^role:$/m);
  assert.doesNotMatch(raw, /''/);
});

test("an inline frontmatter block is written verbatim, not re-serialized", async () => {
  const dir = await vault();
  await writeNote(dir, {
    path: "note",
    content: "---\nname: ''\n---\nbody\n",
  });
  // Hand-written content is validated, never reformatted — the empty-key rule
  // applies to what this server SERIALIZES (the `frontmatter` param and every
  // structured edit), not to bytes the caller supplied itself.
  assert.equal(await readFile(join(dir, "note.md"), "utf-8"), "---\nname: ''\n---\nbody\n");
});

test("an unrelated edit rewrites a pre-existing `key: ''` to a bare key", async () => {
  const dir = await vault();
  await writeFile(join(dir, "n.md"), "---\nname: ''\nstatus: draft\n---\nbody\n");
  // Documented consequence of the vault-wide rule: `''` is not a fixed point.
  // Unlike the date-only case (where a rewrite visibly changed the value), an
  // empty string and null present identically in Obsidian.
  await addTag(dir, { path: "n", tags: ["x"] });
  const raw = await readFile(join(dir, "n.md"), "utf-8");
  assert.match(raw, /^name:$/m);
  assert.match(raw, /^status: draft$/m);
  assert.match(raw, /^  - x$/m);
});

test("set_frontmatter can clear a field to an empty property", async () => {
  const dir = await vault();
  await writeNote(dir, { path: "n", content: "body\n", frontmatter: { role: "PA-C" } });
  await setNoteFrontmatter(dir, { path: "n", set: { role: "" } });
  assert.match(await readFile(join(dir, "n.md"), "utf-8"), /^role:$/m);
});
