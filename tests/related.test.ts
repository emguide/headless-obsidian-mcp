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
    res.map((r) => r.path),
    ["Beta Note", "daily/2026-07-22", "index"]
  );
  assert.equal(res[0].score, 9);
  assert.equal(res[1].score, 4);
  assert.equal(res[2].score, 4);
});

test("surfaces the reasons a note is related", async () => {
  const res = await getRelatedNotes(fx.vaultPath, { path: "projects/alpha" });
  const beta = res.find((r) => r.path === "Beta Note")!;
  assert.deepEqual(beta.shared_tags, ["productivity"]);
  assert.equal(beta.linked, true);
  assert.deepEqual(beta.shared_backlinks, ["index"]);
  assert.ok(beta.reasons.includes("directly linked"));
  assert.ok(beta.reasons.some((r) => r.includes("productivity")));
  assert.ok(beta.reasons.some((r) => r.includes("cited alongside by 1 note")));
});

test("includes header fields alongside relatedness signals", async () => {
  const res = await getRelatedNotes(fx.vaultPath, { path: "projects/alpha" });
  const beta = res.find((r) => r.path === "Beta Note")!;
  assert.equal(beta.title, "Beta Note");
  assert.equal(beta.headline, "Beta");
  assert.equal(typeof beta.size, "number");
  assert.equal(typeof beta.modified, "string");
});

test("excludes the source note itself and unrelated notes", async () => {
  const res = await getRelatedNotes(fx.vaultPath, { path: "projects/alpha" });
  assert.ok(!res.some((r) => r.path === "projects/alpha"));
  // Every returned note has at least one connecting signal.
  assert.ok(res.every((r) => r.score > 0));
});

test("respects the limit", async () => {
  const res = await getRelatedNotes(fx.vaultPath, { path: "projects/alpha", limit: 1 });
  assert.equal(res.length, 1);
  assert.equal(res[0].path, "Beta Note");
});

test("accepts a basename and the .md extension", async () => {
  const byBase = await getRelatedNotes(fx.vaultPath, { path: "alpha" });
  const byExt = await getRelatedNotes(fx.vaultPath, { path: "projects/alpha.md" });
  assert.deepEqual(byBase.map((r) => r.path), byExt.map((r) => r.path));
});

test("throws for a note that does not exist", async () => {
  await assert.rejects(
    () => getRelatedNotes(fx.vaultPath, { path: "does/not/exist" }),
    /not found or not readable/
  );
});

test("rejects a non-positive limit", async () => {
  await assert.rejects(
    () => getRelatedNotes(fx.vaultPath, { path: "projects/alpha", limit: 0 }),
    /limit must be a positive integer/
  );
});
