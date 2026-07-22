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

test("read_notes parses frontmatter, tags, and strips them from body", async () => {
  const [note] = await readNotes(fx.vaultPath, ["projects/alpha"]);
  assert.equal(note.name, "projects/alpha");
  assert.equal(note.metadata.status, "active");
  assert.ok(note.tags.includes("productivity"));
  assert.ok(!note.contents.includes("#productivity"));
});

test("search finds matches and returns paths without .md", async () => {
  const results = await searchNotes(fx.vaultPath, { pattern: "productivity" });
  const paths = results.map((r) => r.path).sort();
  assert.deepEqual(paths, ["Beta Note", "projects/alpha"]);
});
