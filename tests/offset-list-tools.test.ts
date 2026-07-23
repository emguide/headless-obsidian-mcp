import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { listNotes } from "../src/tools/list.js";
import { listRecentNotes } from "../src/tools/recent.js";
import { queryNotes } from "../src/tools/properties.js";
import { makeVault, sampleNotes, Fixture } from "./fixtures.js";

let fx: Fixture;
before(async () => {
  fx = await makeVault(sampleNotes()); // 4 notes
});
after(() => fx.cleanup());

test("listNotes: offset pages a non-overlapping window with correct skipped/omitted", async () => {
  const all = await listNotes(fx.vaultPath, { limit: 0 });
  const total = all.results.length;
  assert.ok(total >= 4, "fixture must have >= 4 notes");

  const page1 = await listNotes(fx.vaultPath, { limit: 2, offset: 0 });
  assert.equal(page1.returned, 2);
  assert.equal(page1.skipped, 0);
  assert.equal(page1.omitted, total - 2);
  assert.equal(page1.truncated, true);

  const page2 = await listNotes(fx.vaultPath, { limit: 2, offset: 2 });
  assert.equal(page2.returned, Math.min(2, total - 2));
  assert.equal(page2.skipped, 2);
  assert.equal(page2.omitted, total - 2 - page2.returned);

  // total is recoverable and stable across pages
  assert.equal(page1.skipped + page1.returned + page1.omitted, total);
  assert.equal(page2.skipped + page2.returned + page2.omitted, total);

  // windows don't overlap
  const p1 = new Set(page1.results.map((r) => r.path));
  assert.ok(page2.results.every((r) => !p1.has(r.path)));

  // the offset window equals the same slice of the full ordering
  assert.deepEqual(
    page2.results.map((r) => r.path),
    all.results.slice(2, 4).map((r) => r.path)
  );
});

test("listNotes: offset with limit:0 skips then returns the unbounded remainder", async () => {
  const all = await listNotes(fx.vaultPath, { limit: 0 });
  const rest = await listNotes(fx.vaultPath, { limit: 0, offset: 2 });
  assert.equal(rest.skipped, 2);
  assert.equal(rest.omitted, 0);
  assert.equal(rest.truncated, false);
  assert.deepEqual(
    rest.results.map((r) => r.path),
    all.results.slice(2).map((r) => r.path)
  );
});

test("listNotes: offset past the end returns empty, not an error", async () => {
  const all = await listNotes(fx.vaultPath, { limit: 0 });
  const r = await listNotes(fx.vaultPath, { limit: 10, offset: 99 });
  assert.deepEqual(r.results, []);
  assert.equal(r.skipped, all.results.length);
  assert.equal(r.omitted, 0);
  assert.equal(r.truncated, false);
});

test("listNotes: negative offset is rejected with the standard message", async () => {
  await assert.rejects(
    () => listNotes(fx.vaultPath, { offset: -1 }),
    /offset must be a non-negative integer/
  );
});

test("listNotes: non-integer offset is rejected", async () => {
  await assert.rejects(
    () => listNotes(fx.vaultPath, { offset: 1.5 }),
    /offset must be a non-negative integer/
  );
});

test("listRecentNotes: offset skips the newest notes (spot-check a second tool)", async () => {
  const all = await listRecentNotes(fx.vaultPath, { limit: 0 });
  const off = await listRecentNotes(fx.vaultPath, { limit: 0, offset: 1 });
  assert.equal(off.skipped, 1);
  assert.deepEqual(
    off.results.map((r) => r.path),
    all.results.slice(1).map((r) => r.path)
  );
});

test("queryNotes: offset paginates a where-filtered set", async () => {
  // Every sample note has frontmatter; use an exists-style broad filter via `where`.
  const all = await queryNotes(fx.vaultPath, { where: { title: { exists: true } }, limit: 0 });
  if (all.results.length >= 2) {
    const off = await queryNotes(fx.vaultPath, {
      where: { title: { exists: true } },
      limit: 0,
      offset: 1,
    });
    assert.equal(off.skipped, 1);
    assert.deepEqual(
      off.results.map((r) => r.path),
      all.results.slice(1).map((r) => r.path)
    );
  }
});

test("queryNotes: negative offset rejected", async () => {
  await assert.rejects(
    () => queryNotes(fx.vaultPath, { where: {}, offset: -1 }),
    /offset must be a non-negative integer/
  );
});
