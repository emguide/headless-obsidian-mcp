import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { searchNotes } from "../src/tools/search.js";
import { makeVault, Fixture } from "./fixtures.js";

// 6 files each containing "needle" once, in their own folder for a stable walk.
function needleFiles() {
  return Array.from({ length: 6 }, (_, i) => ({
    path: `notes/n${i}.md`,
    content: `# Note ${i}\nThis note has a needle in it.\n`,
  }));
}

let fx: Fixture;
before(async () => {
  fx = await makeVault(needleFiles());
});
after(() => fx.cleanup());

test("offset skips whole files and reports files_skipped; counts partition the match set", async () => {
  const all = await searchNotes(fx.vaultPath, { pattern: "needle", limit: 0 });
  const allPaths = new Set(all.results.map((r) => r.path));
  assert.equal(allPaths.size, 6);

  const page = await searchNotes(fx.vaultPath, { pattern: "needle", limit: 2, offset: 1 });
  assert.equal(page.files_returned, 2);
  assert.equal(page.files_skipped, 1);
  assert.equal(page.files_omitted, 3);
  // The three counts partition the full match set (ripgrep's file order is not
  // stable across separate invocations, so assert the partition, not positions).
  assert.equal(page.files_skipped + page.files_returned + page.files_omitted, 6);
  // Every returned file is a real match, and the window holds exactly `limit` of them.
  assert.equal(page.results.length, 2);
  assert.ok(page.results.every((r) => allPaths.has(r.path)));
});

test("files_skipped tracks the requested offset and returned files are always real matches", async () => {
  // ripgrep's file order is not stable across separate invocations, so we assert
  // only order-independent facts: the reported counts and that every returned
  // file is a genuine match. (Counts are computed positionally within one call,
  // so they're deterministic for a given offset/limit regardless of order.)
  const all = await searchNotes(fx.vaultPath, { pattern: "needle", limit: 0 });
  const allPaths = new Set(all.results.map((r) => r.path));

  for (const off of [0, 2, 4]) {
    const p = await searchNotes(fx.vaultPath, { pattern: "needle", limit: 2, offset: off });
    assert.equal(p.files_skipped, off, `files_skipped should equal offset ${off}`);
    assert.equal(p.files_returned, 2);
    assert.equal(p.files_skipped + p.files_returned + p.files_omitted, 6);
    assert.ok(p.results.every((r) => allPaths.has(r.path)));
  }
});

test("offset does not by itself set truncated; a trailing window past the end is not truncated", async () => {
  // Window covering the tail with nothing omitted after it.
  const tail = await searchNotes(fx.vaultPath, { pattern: "needle", limit: 0, offset: 4 });
  assert.equal(tail.files_skipped, 4);
  assert.equal(tail.files_returned, 2);
  assert.equal(tail.files_omitted, 0);
  assert.equal(tail.truncated, false);
});

test("offset with a limit that still leaves a tail sets truncated via files_omitted", async () => {
  const page = await searchNotes(fx.vaultPath, { pattern: "needle", limit: 2, offset: 1 });
  assert.equal(page.files_omitted, 3);
  assert.equal(page.truncated, true);
});

test("offset past the end returns empty with all matching files skipped", async () => {
  const past = await searchNotes(fx.vaultPath, { pattern: "needle", limit: 5, offset: 99 });
  assert.deepEqual(past.results, []);
  assert.equal(past.files_skipped, 6);
  assert.equal(past.files_returned, 0);
  assert.equal(past.files_omitted, 0);
  assert.equal(past.truncated, false);
});

test("negative offset is rejected with the standard message", async () => {
  await assert.rejects(
    () => searchNotes(fx.vaultPath, { pattern: "needle", offset: -1 }),
    /offset must be a non-negative integer/
  );
});

test("non-integer offset is rejected", async () => {
  await assert.rejects(
    () => searchNotes(fx.vaultPath, { pattern: "needle", offset: 2.5 }),
    /offset must be a non-negative integer/
  );
});
