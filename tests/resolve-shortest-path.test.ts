import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { getIndex } from "../src/tools/vault-index.js";
import { getLinks } from "../src/tools/links.js";
import { makeVault, Fixture, FixtureNote } from "./fixtures.js";

/**
 * Vault with the SAME basename (`api.md`) at several path depths, so a bare
 * `[[api]]` is ambiguous. Obsidian's default resolves it to the note closest to
 * the vault root (fewest path segments), ties broken alphabetically, and to the
 * SAME note vault-wide regardless of where the link lives — it is not
 * source-relative (see the "absolute link path has higher precedence" thread
 * and WhiteNoise's "we want [[A]] to point to the same note across the vault").
 */
function duplicateBasenameNotes(): FixtureNote[] {
  const link = "Ref: [[api]].";
  return [
    { path: "api.md", content: "# Root api" },
    { path: "projects/api.md", content: "# Projects api" },
    { path: "projects/web/api.md", content: "# Web api" },
    { path: "archive/api.md", content: "# Archive api" },
    // Linkers in different folders; every bare [[api]] must resolve identically.
    { path: "projects/consumer.md", content: `# In projects\n${link}` },
    { path: "projects/web/consumer.md", content: `# In web\n${link}` },
    { path: "notes/consumer.md", content: `# In notes\n${link}` },
    { path: "root-consumer.md", content: `# At root\n${link}` },
  ];
}

let fx: Fixture;
before(async () => {
  fx = await makeVault(duplicateBasenameNotes());
});
after(() => fx.cleanup());

test("bare basename resolves to the root note (exact path match)", async () => {
  const index = await getIndex(fx.vaultPath);
  assert.equal(index.resolve("api"), "api");
});

test("bare basename resolves to the SAME note from any source folder", async () => {
  const index = await getIndex(fx.vaultPath);
  // Not source-relative: a linker inside projects/ still resolves to root api,
  // NOT its projects/api sibling. This is the behavior that distinguishes
  // Obsidian's rule from same-folder proximity.
  const targets = [
    index.resolve("api"),
    index.resolve("api"),
    index.resolve("api"),
  ];
  assert.deepEqual(new Set(targets), new Set(["api"]));
});

test("with no root candidate, the shortest path wins over alphabetical", async () => {
  // The real defect being fixed: alphabetical-first would pick a deeper note.
  // zzz/api (depth 2) must beat a/b/api (depth 3) despite sorting later.
  const v = await makeVault([
    { path: "zzz/api.md", content: "# shallow" },
    { path: "a/b/api.md", content: "# deep" },
    { path: "linker.md", content: "[[api]]" },
  ]);
  try {
    const index = await getIndex(v.vaultPath);
    assert.equal(index.resolve("api"), "zzz/api");
  } finally {
    await v.cleanup();
  }
});

test("equal-depth candidates break ties alphabetically", async () => {
  const v = await makeVault([
    { path: "zebra/api.md", content: "# z" },
    { path: "alpha/api.md", content: "# a" },
    { path: "linker.md", content: "[[api]]" },
  ]);
  try {
    const index = await getIndex(v.vaultPath);
    assert.equal(index.resolve("api"), "alpha/api");
  } finally {
    await v.cleanup();
  }
});

test("an unambiguous basename resolves regardless of depth", async () => {
  const v = await makeVault([
    { path: "deep/nested/unique.md", content: "# Unique" },
    { path: "linker.md", content: "[[unique]]" },
  ]);
  try {
    const index = await getIndex(v.vaultPath);
    assert.equal(index.resolve("unique"), "deep/nested/unique");
  } finally {
    await v.cleanup();
  }
});

test("full-path targets resolve to exactly that note", async () => {
  const index = await getIndex(fx.vaultPath);
  assert.equal(index.resolve("archive/api"), "archive/api");
  assert.equal(index.resolve("projects/web/api"), "projects/web/api");
});

test("a slash-qualified target that does not exist is unresolved (no basename fallback)", async () => {
  // Obsidian treats [[wrong-folder/api]] as a path-qualified link: if that
  // exact path has no note, it is UNRESOLVED — the shortest-path basename
  // fallback applies only to bare basenames. Falling back here would both hide
  // a genuinely broken link and desync move_note's rewrite predicate, which
  // only rewrites basename references when the target has no slash.
  const index = await getIndex(fx.vaultPath);
  assert.equal(index.resolve("wrong-folder/api"), null);
  assert.equal(index.resolve("projects/does-not-exist"), null);
});

test("backlink graph routes every bare [[api]] to the root note", async () => {
  // End-to-end: since [[api]] resolves vault-wide to root api, every consumer
  // backlinks the root note, and the deeper api notes get none of them.
  const rootApi = await getLinks(fx.vaultPath, "api");
  assert.deepEqual(rootApi.backlinks.sort(), [
    "notes/consumer",
    "projects/consumer",
    "projects/web/consumer",
    "root-consumer",
  ]);

  const projectsApi = await getLinks(fx.vaultPath, "projects/api");
  assert.deepEqual(projectsApi.backlinks, []);
});

test("shortest-path resolution is reflected in a no-root vault's graph", async () => {
  const v = await makeVault([
    { path: "zzz/api.md", content: "# shallow" },
    { path: "a/b/api.md", content: "# deep" },
    { path: "linker.md", content: "Uses [[api]]." },
  ]);
  try {
    const shallow = await getLinks(v.vaultPath, "zzz/api");
    assert.deepEqual(shallow.backlinks, ["linker"]);
    const deep = await getLinks(v.vaultPath, "a/b/api");
    assert.deepEqual(deep.backlinks, []);
  } finally {
    await v.cleanup();
  }
});
