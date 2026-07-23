import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { searchNotesRanked } from "../src/tools/search-ranked.js";
import { makeVault, Fixture } from "./fixtures.js";

// Six notes all containing "alpha", with descending term frequency so the
// BM25 ranking is deterministic (more repetitions => higher score).
function alphaNotes() {
  return [0, 1, 2, 3, 4, 5].map((i) => ({
    path: `n${i}.md`,
    content: [
      "---",
      `title: Note ${i}`,
      "---",
      `# Note ${i}`,
      ("alpha ".repeat(6 - i)).trim() + ` distinct${i}`,
    ].join("\n"),
  }));
}

let fx: Fixture;
before(async () => {
  fx = await makeVault(alphaNotes());
});
after(() => fx.cleanup());

test("offset pages the ranked window; skipped is reported and total is stable", async () => {
  const page1 = await searchNotesRanked(fx.vaultPath, { query: "alpha", limit: 2, offset: 0 });
  const page2 = await searchNotesRanked(fx.vaultPath, { query: "alpha", limit: 2, offset: 2 });

  assert.equal(page1.skipped, 0);
  assert.equal(page2.skipped, 2);

  const total1 = page1.skipped + page1.returned + page1.omitted;
  const total2 = page2.skipped + page2.returned + page2.omitted;
  assert.equal(total1, total2, "total must be stable across pages");
  assert.ok(total1 >= 4);

  // Windows don't overlap and ranking is continued, not restarted.
  const p1 = new Set(page1.results.map((r) => r.path));
  assert.ok(page2.results.every((r) => !p1.has(r.path)));
});

test("offset reaches later hits — equals the same slice of the unbounded ranking", async () => {
  const all = await searchNotesRanked(fx.vaultPath, { query: "alpha", limit: 0 });
  assert.ok(all.returned >= 4);

  const windowed = await searchNotesRanked(fx.vaultPath, { query: "alpha", limit: 2, offset: 2 });
  assert.deepEqual(
    windowed.results.map((r) => r.path),
    all.results.slice(2, 4).map((r) => r.path)
  );
});

test("offset past a positive-capped limit still lands on the right hit (the worst-case scenario, scaled down)", async () => {
  const all = await searchNotesRanked(fx.vaultPath, { query: "alpha", limit: 0 });
  // With limit:1 offset:N, we should get exactly the N-th ranked hit — the same
  // shape as limit:100 offset:100 reaching rank 101 in a large vault.
  for (let n = 0; n < all.returned; n++) {
    const one = await searchNotesRanked(fx.vaultPath, { query: "alpha", limit: 1, offset: n });
    assert.equal(one.results.length, 1);
    assert.equal(one.results[0].path, all.results[n].path, `offset ${n} must return rank ${n}`);
    assert.equal(one.skipped, n);
  }
});

test("offset past the end returns an empty, non-truncated window", async () => {
  const all = await searchNotesRanked(fx.vaultPath, { query: "alpha", limit: 0 });
  const past = await searchNotesRanked(fx.vaultPath, { query: "alpha", limit: 5, offset: 999 });
  assert.deepEqual(past.results, []);
  assert.equal(past.skipped, all.returned); // clamped to total
  assert.equal(past.omitted, 0);
  assert.equal(past.truncated, false);
});

test("offset works with the scoped (filtered) path too", async () => {
  const all = await searchNotesRanked(fx.vaultPath, { query: "alpha", limit: 0, where: { title: { exists: true } } });
  const off = await searchNotesRanked(fx.vaultPath, { query: "alpha", limit: 0, offset: 1, where: { title: { exists: true } } });
  assert.equal(off.skipped, 1);
  assert.deepEqual(
    off.results.map((r) => r.path),
    all.results.slice(1).map((r) => r.path)
  );
});

test("negative offset is rejected with the standard message", async () => {
  await assert.rejects(
    () => searchNotesRanked(fx.vaultPath, { query: "alpha", offset: -1 }),
    /offset must be a non-negative integer/
  );
});
