import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { searchNotes } from "../src/tools/search.js";
import { makeVault, Fixture } from "./fixtures.js";

// 30 files each containing the word "needle" once.
function manyFiles(): { path: string; content: string }[] {
  return Array.from({ length: 30 }, (_, i) => ({
    path: `notes/n${i}.md`,
    content: `# Note ${i}\nThis note has a needle in it.\n`,
  }));
}

let fx: Fixture;
before(async () => {
  fx = await makeVault([
    ...manyFiles(),
    {
      path: "busy.md",
      content: ["# Busy"].concat(Array.from({ length: 50 }, () => "needle line")).join("\n"),
    },
    { path: "empty-topic.md", content: "# Nothing here\nplain text only\n" },
  ]);
});
after(async () => {
  await fx.cleanup();
});

test("defaults cap files at 20 and report truncation", async () => {
  const res = await searchNotes(fx.vaultPath, { pattern: "needle" });
  assert.equal(res.results.length, 20);
  assert.equal(res.files_returned, 20);
  assert.equal(res.truncated, true);
  // 31 files match (30 n* + busy.md); 20 returned, 11 omitted.
  assert.equal(res.files_omitted, 11);
});

test("limit above default is honored with no upper clamp", async () => {
  const res = await searchNotes(fx.vaultPath, {
    pattern: "needle",
    limit: 100,
    max_matches_per_file: 0,
  });
  assert.equal(res.results.length, 31);
  assert.equal(res.files_omitted, 0);
  assert.equal(res.truncated, false);
});

test("limit 0 disables the file cap", async () => {
  const res = await searchNotes(fx.vaultPath, { pattern: "needle", limit: 0 });
  assert.equal(res.results.length, 31);
  assert.equal(res.files_omitted, 0);
});

test("max_matches_per_file caps matches within a file", async () => {
  const res = await searchNotes(fx.vaultPath, {
    pattern: "needle",
    limit: 0,
    max_matches_per_file: 10,
  });
  const busy = res.results.find((r) => r.path === "busy");
  assert.ok(busy);
  assert.equal(busy.matches.length, 10);
  assert.ok(res.matches_capped_in.includes("busy"));
  assert.equal(res.truncated, true);
});

test("max_matches_per_file 0 returns all matches for a file", async () => {
  const res = await searchNotes(fx.vaultPath, {
    pattern: "needle",
    limit: 0,
    max_matches_per_file: 0,
  });
  const busy = res.results.find((r) => r.path === "busy");
  assert.ok(busy);
  assert.equal(busy.matches.length, 50);
  assert.deepEqual(res.matches_capped_in, []);
});

test("no matches returns empty results with empty flags", async () => {
  const res = await searchNotes(fx.vaultPath, { pattern: "zzz-no-such-token" });
  assert.deepEqual(res.results, []);
  assert.equal(res.truncated, false);
  assert.equal(res.files_returned, 0);
  assert.equal(res.files_omitted, 0);
  assert.deepEqual(res.matches_capped_in, []);
});

test("negative limit throws", async () => {
  await assert.rejects(
    () => searchNotes(fx.vaultPath, { pattern: "needle", limit: -1 }),
    /limit must be a non-negative integer/
  );
});

test("non-integer max_matches_per_file throws", async () => {
  await assert.rejects(
    () => searchNotes(fx.vaultPath, { pattern: "needle", max_matches_per_file: 2.5 }),
    /max_matches_per_file must be a non-negative integer/
  );
});
