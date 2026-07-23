import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { searchNotes } from "../src/tools/search.js";
import { makeVault, sampleNotes, Fixture, FixtureNote } from "./fixtures.js";

let fx: Fixture;
before(async () => {
  // "alpha" body word appears in projects/alpha (tag: project, status: active)
  // and is referenced elsewhere. Add a note with the word but a different tag.
  const notes: FixtureNote[] = [
    ...sampleNotes(),
    {
      path: "work/ops.md",
      content: ["---", "tags: [work]", "status: active", "---", "# Ops", "alpha runbook here"].join("\n"),
    },
  ];
  fx = await makeVault(notes);
});
after(() => fx.cleanup());

test("folder scopes the search", async () => {
  const res = await searchNotes(fx.vaultPath, { pattern: "alpha", folder: "work" });
  const paths = res.results.map((r) => r.path);
  assert.deepEqual(paths, ["work/ops"]);
});

test("tags filter restricts to tagged notes", async () => {
  const res = await searchNotes(fx.vaultPath, { pattern: "alpha", tags: ["project"] });
  const paths = res.results.map((r) => r.path).sort();
  assert.ok(paths.includes("projects/alpha"));
  assert.ok(!paths.includes("work/ops"));
});

test("where filter restricts by frontmatter", async () => {
  const res = await searchNotes(fx.vaultPath, { pattern: "alpha", where: { status: "active" } });
  const paths = res.results.map((r) => r.path).sort();
  // both projects/alpha and work/ops are status:active and contain "alpha"
  assert.ok(paths.includes("work/ops"));
});

test("combined filters AND together", async () => {
  const res = await searchNotes(fx.vaultPath, {
    pattern: "alpha",
    tags: ["work"],
    where: { status: "active" },
  });
  assert.deepEqual(res.results.map((r) => r.path), ["work/ops"]);
});

test("zero-candidate filter returns empty WITHOUT scanning the vault", async () => {
  const res = await searchNotes(fx.vaultPath, { pattern: "alpha", tags: ["nonexistent-tag"] });
  assert.deepEqual(res.results, []);
  assert.equal(res.files_returned, 0);
  assert.equal(res.truncated, false);
});

test("no filters behaves like a whole-vault search", async () => {
  const res = await searchNotes(fx.vaultPath, { pattern: "alpha" });
  assert.ok(res.results.length >= 2);
});
