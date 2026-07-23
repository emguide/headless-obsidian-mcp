import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { getRelatedNotes } from "../src/tools/related.js";
import { makeVault, sampleNotes, Fixture } from "./fixtures.js";

let fx: Fixture;
before(async () => {
  fx = await makeVault(sampleNotes());
});
after(() => fx.cleanup());

test("ranks related notes by blended score, strongest first", async () => {
  const res = await getRelatedNotes(fx.vaultPath, { path: "projects/alpha" });
  // Beta Note wins: shared tag (productivity) + direct link + co-citation (index
  // links to both). index and daily each only share a direct link, so they tie
  // on score and fall back to path order.
  assert.deepEqual(
    res.results.map((r) => r.path),
    ["Beta Note", "daily/2026-07-22", "index"]
  );
  assert.equal(res.results[0].score, 9);
  assert.equal(res.results[1].score, 4);
  assert.equal(res.results[2].score, 4);
});

test("surfaces the reasons a note is related", async () => {
  const res = await getRelatedNotes(fx.vaultPath, { path: "projects/alpha" });
  const beta = res.results.find((r) => r.path === "Beta Note")!;
  assert.deepEqual(beta.shared_tags, ["productivity"]);
  assert.equal(beta.linked, true);
  assert.deepEqual(beta.shared_backlinks, ["index"]);
  assert.ok(beta.reasons.includes("directly linked"));
  assert.ok(beta.reasons.some((r) => r.includes("productivity")));
  assert.ok(beta.reasons.some((r) => r.includes("cited alongside by 1 note")));
});

test("includes header fields alongside relatedness signals", async () => {
  const res = await getRelatedNotes(fx.vaultPath, { path: "projects/alpha" });
  const beta = res.results.find((r) => r.path === "Beta Note")!;
  assert.equal(beta.title, "Beta Note");
  assert.equal(beta.headline, "Beta");
  assert.equal(typeof beta.size, "number");
  assert.equal(typeof beta.modified, "string");
});

test("excludes the source note itself and unrelated notes", async () => {
  const res = await getRelatedNotes(fx.vaultPath, { path: "projects/alpha" });
  assert.ok(!res.results.some((r) => r.path === "projects/alpha"));
  // Every returned note has at least one connecting signal.
  assert.ok(res.results.every((r) => r.score > 0));
});

test("respects the limit", async () => {
  const res = await getRelatedNotes(fx.vaultPath, { path: "projects/alpha", limit: 1 });
  assert.equal(res.results.length, 1);
  assert.equal(res.results[0].path, "Beta Note");
});

test("accepts a basename and the .md extension", async () => {
  const byBase = await getRelatedNotes(fx.vaultPath, { path: "alpha" });
  const byExt = await getRelatedNotes(fx.vaultPath, { path: "projects/alpha.md" });
  assert.deepEqual(
    byBase.results.map((r) => r.path),
    byExt.results.map((r) => r.path)
  );
});

test("throws for a note that does not exist", async () => {
  await assert.rejects(
    () => getRelatedNotes(fx.vaultPath, { path: "does/not/exist" }),
    /not found or not readable/
  );
});

test("rejects a negative limit", async () => {
  await assert.rejects(
    () => getRelatedNotes(fx.vaultPath, { path: "projects/alpha", limit: -1 }),
    /limit must be a positive integer/
  );
});

test("limit smaller than the related count truncates, with omitted/returned reported", async () => {
  const res = await getRelatedNotes(fx.vaultPath, { path: "projects/alpha", limit: 2 });
  assert.equal(res.truncated, true);
  assert.equal(res.returned, 2);
  assert.equal(res.results.length, 2);
  assert.equal(res.omitted, 1);
  // Total related count (before slicing) is 3 for this fixture.
  assert.equal(res.returned + res.omitted, 3);
});

test("limit: 0 returns all related notes, unbounded and untruncated", async () => {
  const res = await getRelatedNotes(fx.vaultPath, { path: "projects/alpha", limit: 0 });
  assert.equal(res.truncated, false);
  assert.equal(res.omitted, 0);
  assert.equal(res.results.length, 3);
  assert.equal(res.returned, 3);
});

test("defaults to DEFAULT_LIMIT (100) when limit is omitted, not truncated for a small vault", async () => {
  const res = await getRelatedNotes(fx.vaultPath, { path: "projects/alpha" });
  assert.equal(res.truncated, false);
  assert.equal(res.omitted, 0);
  assert.equal(res.results.length, 3);
});
