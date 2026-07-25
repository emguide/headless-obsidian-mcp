import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { listNotes } from "../src/tools/list.js";
import { makeVault, sampleNotes, FixtureNote, Fixture } from "./fixtures.js";

let fx: Fixture;
before(async () => {
  fx = await makeVault(sampleNotes());
});
after(() => fx.cleanup());

test("returns an envelope with notes sorted by path", async () => {
  const res = await listNotes(fx.vaultPath);
  assert.deepEqual(
    res.results.map((n) => n.path),
    ["Beta Note", "daily/2026-07-22", "index", "projects/alpha"]
  );
});

test("reports returned and untruncated for a small vault", async () => {
  const res = await listNotes(fx.vaultPath);
  assert.equal(res.returned, 4);
  assert.equal(res.returned, res.results.length);
  assert.equal(res.omitted, 0);
  assert.equal(res.truncated, false);
});

test("uses frontmatter title, falling back to basename", async () => {
  const res = await listNotes(fx.vaultPath);
  const byPath = Object.fromEntries(res.results.map((n) => [n.path, n]));
  assert.equal(byPath["index"].title, "Home"); // frontmatter title
  assert.equal(byPath["Beta Note"].title, "Beta Note"); // basename fallback
});

test("extracts the first heading as headline", async () => {
  const res = await listNotes(fx.vaultPath);
  const alpha = res.results.find((n) => n.path === "projects/alpha");
  assert.equal(alpha?.headline, "Alpha");
});

test("filters by folder without matching sibling prefixes", async () => {
  const res = await listNotes(fx.vaultPath, { folder: "projects" });
  assert.deepEqual(
    res.results.map((n) => n.path),
    ["projects/alpha"]
  );
  assert.equal(res.omitted, 0);
  assert.equal(res.truncated, false);
});

test("respects an explicit limit and reports truncation", async () => {
  const res = await listNotes(fx.vaultPath, { limit: 2 });
  assert.equal(res.results.length, 2);
  assert.equal(res.returned, 2);
  assert.equal(res.omitted, 2);
  assert.equal(res.truncated, true);
});

test("limit >= total is not truncated", async () => {
  const res = await listNotes(fx.vaultPath, { limit: 4 });
  assert.equal(res.returned, 4);
  assert.equal(res.truncated, false);
});

test("limit 0 returns every note, untruncated", async () => {
  const res = await listNotes(fx.vaultPath, { limit: 0 });
  assert.equal(res.returned, 4);
  assert.equal(res.omitted, 0);
  assert.equal(res.truncated, false);
});

test("rejects a negative limit", async () => {
  await assert.rejects(
    () => listNotes(fx.vaultPath, { limit: -1 }),
    /non-negative integer/
  );
});

test("rejects a non-integer limit", async () => {
  await assert.rejects(
    () => listNotes(fx.vaultPath, { limit: 1.5 }),
    /non-negative integer/
  );
});

test("applies a default limit of 100 and reports truncation", async () => {
  const many: FixtureNote[] = [];
  for (let i = 0; i < 150; i++) {
    const n = String(i).padStart(3, "0");
    many.push({ path: `bulk/note-${n}.md`, content: `# Note ${n}\n` });
  }
  const big = await makeVault(many);
  try {
    const res = await listNotes(big.vaultPath);
    assert.equal(res.returned, 100);
    assert.equal(res.omitted, 50);
    assert.equal(res.results.length, 100);
    assert.equal(res.truncated, true);

    // limit 0 escapes the default and returns all 150.
    const all = await listNotes(big.vaultPath, { limit: 0 });
    assert.equal(all.returned, 150);
    assert.equal(all.omitted, 0);
    assert.equal(all.truncated, false);
  } finally {
    await big.cleanup();
  }
});

test("list_notes reports truncation via the envelope", async () => {
  const vault = await makeVault([
    { path: "a.md", content: "# A" },
    { path: "b.md", content: "# B" },
    { path: "c.md", content: "# C" },
  ]);
  try {
    const res = await listNotes(vault.vaultPath, { limit: 2 });
    assert.equal(res.truncated, true);
    assert.equal(res.returned, 2);
    assert.equal(res.omitted, 1);
    assert.equal(res.results.length, 2);

    const all = await listNotes(vault.vaultPath);
    assert.equal(all.truncated, false);
    assert.equal(all.omitted, 0);
    assert.equal(all.returned, all.results.length);
  } finally {
    await vault.cleanup();
  }
});
