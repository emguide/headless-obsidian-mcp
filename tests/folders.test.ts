import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { listFolders } from "../src/tools/folders.js";
import { makeVault, FixtureNote, Fixture } from "./fixtures.js";

/** A nested tree:
 *   root.md
 *   projects/overview.md
 *   projects/alpha/index.md
 *   projects/alpha/notes.md
 *   projects/beta/index.md
 *   daily/2026-07-22.md
 * Folders: projects (1 direct, 4 total, 2 subfolders),
 *          projects/alpha (2/2/0), projects/beta (1/1/0),
 *          daily (1/1/0).
 */
function tree(): FixtureNote[] {
  return [
    { path: "root.md", content: "# Root" },
    { path: "projects/overview.md", content: "# Overview" },
    { path: "projects/alpha/index.md", content: "# Alpha" },
    { path: "projects/alpha/notes.md", content: "# Notes" },
    { path: "projects/beta/index.md", content: "# Beta" },
    { path: "daily/2026-07-22.md", content: "# Daily" },
  ];
}

let fx: Fixture;
before(async () => {
  fx = await makeVault(tree());
});
after(() => fx.cleanup());

test("lists folders sorted by path", async () => {
  const res = await listFolders(fx.vaultPath);
  assert.deepEqual(
    res.results.map((f) => f.path),
    ["daily", "projects", "projects/alpha", "projects/beta"]
  );
});

test("reports direct notes, recursive total_notes, and subfolders", async () => {
  const res = await listFolders(fx.vaultPath);
  const byPath = Object.fromEntries(res.results.map((f) => [f.path, f]));
  assert.deepEqual(byPath["projects"], {
    path: "projects",
    notes: 1,
    total_notes: 4,
    subfolders: 2,
  });
  assert.deepEqual(byPath["projects/alpha"], {
    path: "projects/alpha",
    notes: 2,
    total_notes: 2,
    subfolders: 0,
  });
  assert.deepEqual(byPath["daily"], {
    path: "daily",
    notes: 1,
    total_notes: 1,
    subfolders: 0,
  });
});

test("root-level notes contribute no folder row", async () => {
  const res = await listFolders(fx.vaultPath);
  assert.ok(!res.results.some((f) => f.path === "" || f.path === "root"));
});

test("envelope is untruncated for a small vault", async () => {
  const res = await listFolders(fx.vaultPath);
  assert.equal(res.returned, 4);
  assert.equal(res.returned, res.results.length);
  assert.equal(res.omitted, 0);
  assert.equal(res.truncated, false);
});

test("folder scope returns strict descendants only, excluding the scope itself", async () => {
  const res = await listFolders(fx.vaultPath, { folder: "projects" });
  assert.deepEqual(
    res.results.map((f) => f.path),
    ["projects/alpha", "projects/beta"]
  );
});

test("folder scope normalizes trailing slashes", async () => {
  const res = await listFolders(fx.vaultPath, { folder: "projects/" });
  assert.deepEqual(
    res.results.map((f) => f.path),
    ["projects/alpha", "projects/beta"]
  );
});

test("depth 1 unscoped keeps only top-level folders", async () => {
  const res = await listFolders(fx.vaultPath, { depth: 1 });
  assert.deepEqual(
    res.results.map((f) => f.path),
    ["daily", "projects"]
  );
});

test("depth 1 under a scope keeps only immediate children of the scope", async () => {
  const res = await listFolders(fx.vaultPath, { folder: "projects", depth: 1 });
  assert.deepEqual(
    res.results.map((f) => f.path),
    ["projects/alpha", "projects/beta"]
  );
});

test("a nonexistent folder scope returns an empty envelope", async () => {
  const res = await listFolders(fx.vaultPath, { folder: "nope" });
  assert.deepEqual(res.results, []);
  assert.equal(res.returned, 0);
  assert.equal(res.omitted, 0);
  assert.equal(res.truncated, false);
});

test("respects an explicit limit and reports truncation", async () => {
  const res = await listFolders(fx.vaultPath, { limit: 2 });
  assert.equal(res.results.length, 2);
  assert.equal(res.returned, 2);
  assert.equal(res.omitted, 2);
  assert.equal(res.truncated, true);
});

test("limit 0 returns every folder, untruncated", async () => {
  const res = await listFolders(fx.vaultPath, { limit: 0 });
  assert.equal(res.returned, 4);
  assert.equal(res.omitted, 0);
  assert.equal(res.truncated, false);
});

test("rejects a negative limit", async () => {
  await assert.rejects(
    () => listFolders(fx.vaultPath, { limit: -1 }),
    /positive integer/
  );
});

test("rejects a non-integer depth", async () => {
  await assert.rejects(
    () => listFolders(fx.vaultPath, { depth: 1.5 }),
    /positive integer/
  );
});

test("a flat vault with no subfolders returns an empty envelope", async () => {
  const flat = await makeVault([
    { path: "a.md", content: "# A" },
    { path: "b.md", content: "# B" },
  ]);
  try {
    const res = await listFolders(flat.vaultPath);
    assert.deepEqual(res.results, []);
    assert.equal(res.truncated, false);
  } finally {
    await flat.cleanup();
  }
});

test("applies a default limit of 100 and reports truncation", async () => {
  const many: FixtureNote[] = [];
  for (let i = 0; i < 150; i++) {
    const n = String(i).padStart(3, "0");
    many.push({ path: `f-${n}/note.md`, content: `# Note ${n}` });
  }
  const big = await makeVault(many);
  try {
    const res = await listFolders(big.vaultPath);
    assert.equal(res.returned, 100);
    assert.equal(res.omitted, 50);
    assert.equal(res.truncated, true);

    const all = await listFolders(big.vaultPath, { limit: 0 });
    assert.equal(all.returned, 150);
    assert.equal(all.truncated, false);
  } finally {
    await big.cleanup();
  }
});
