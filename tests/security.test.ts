import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readNotes } from "../src/tools/read.js";
import { getLinks } from "../src/tools/links.js";
import { searchNotes } from "../src/tools/search.js";
import { makeVault, sampleNotes, Fixture } from "./fixtures.js";

let fx: Fixture;
before(async () => {
  fx = await makeVault(sampleNotes());
});
after(() => fx.cleanup());

test("read_notes blocks path traversal", async () => {
  await assert.rejects(
    () => readNotes(fx.vaultPath, ["../../etc/passwd"]),
    /path traversal/
  );
});

test("get_links blocks path traversal", async () => {
  await assert.rejects(
    () => getLinks(fx.vaultPath, "../../etc/passwd"),
    /path traversal/
  );
});

test("read_notes rejects more than 50 paths", async () => {
  const many = Array.from({ length: 51 }, (_, i) => `note-${i}`);
  await assert.rejects(() => readNotes(fx.vaultPath, many), /more than 50/);
});

test("search rejects an over-long pattern", async () => {
  await assert.rejects(
    () => searchNotes(fx.vaultPath, { pattern: "a".repeat(1001) }),
    /too long/
  );
});

test("search rejects a DoS-prone pattern", async () => {
  await assert.rejects(
    () => searchNotes(fx.vaultPath, { pattern: "{1,999}xxxx{1,999}" }),
    /complexity not allowed/
  );
});

test("read_notes parses frontmatter and tags, preserving body text verbatim", async () => {
  const [note] = await readNotes(fx.vaultPath, ["projects/alpha"]);
  assert.equal(note.path, "projects/alpha");
  assert.equal(note.frontmatter.status, "active");
  // `tags` unifies frontmatter `tags:` with inline `#tags`, matching the
  // index-backed tools (list_notes, find_by_tag, list_tags).
  assert.ok(note.tags.includes("productivity"), "inline tag");
  assert.ok(note.tags.includes("project"), "frontmatter tag");
  assert.ok(note.tags.includes("project/active"), "nested frontmatter tag");
  // Body is returned verbatim (minus frontmatter) so patch_note's `find`
  // matches what read_notes shows — inline tag text is not stripped.
  assert.ok(note.contents.includes("#productivity"));
});

test("read_notes tag extraction ignores URL anchors and numeric refs", async () => {
  const edge = await makeVault([
    {
      path: "tag-edge-cases.md",
      content: [
        "# Edge cases",
        "See https://docs.example.com/page#install for setup.",
        "Fixed in issue #123 last week.",
        "Filed under #project/alpha and #done.",
      ].join("\n"),
    },
  ]);
  try {
    const [note] = await readNotes(edge.vaultPath, ["tag-edge-cases"]);
    // `#` preceded by a word char (a URL anchor) is not a tag.
    assert.ok(!note.tags.includes("install"), "URL anchor must not be a tag");
    // A purely numeric ref (#123) is not a tag — a tag must start with a letter.
    assert.ok(!note.tags.includes("123"), "numeric ref must not be a tag");
    // A nested tag is captured whole, not split into a stray fragment.
    assert.ok(note.tags.includes("project/alpha"), "nested tag captured whole");
    assert.ok(!note.tags.includes("project"), "nested tag not truncated");
    assert.ok(note.tags.includes("done"));
  } finally {
    await edge.cleanup();
  }
});

test("search finds matches and returns paths without .md", async () => {
  const { results } = await searchNotes(fx.vaultPath, { pattern: "productivity" });
  const paths = results.map((r) => r.path).sort();
  assert.deepEqual(paths, ["Beta Note", "projects/alpha"]);
});
