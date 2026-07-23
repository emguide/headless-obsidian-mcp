import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { searchNotesRanked } from "../src/tools/search-ranked.js";
import { makeVault, Fixture } from "./fixtures.js";

let fx: Fixture;
before(async () => {
  fx = await makeVault([
    { path: "work/net.md", content: ["---", "tags: [work]", "status: active", "---", "# Networking", "kubernetes networking cluster"].join("\n") },
    { path: "home/net.md", content: ["---", "tags: [home]", "---", "# Home net", "kubernetes networking at home"].join("\n") },
    { path: "work/old.md", content: ["---", "tags: [work]", "status: archived", "---", "# Old", "kubernetes networking legacy"].join("\n") },
  ]);
});
after(() => fx.cleanup());

test("folder scopes ranked search", async () => {
  const res = await searchNotesRanked(fx.vaultPath, { query: "kubernetes networking", folder: "work" });
  assert.deepEqual(res.results.map((r) => r.path).sort(), ["work/net", "work/old"]);
});

test("tags scope ranked search", async () => {
  const res = await searchNotesRanked(fx.vaultPath, { query: "kubernetes networking", tags: ["home"] });
  assert.deepEqual(res.results.map((r) => r.path), ["home/net"]);
});

test("where scopes ranked search", async () => {
  const res = await searchNotesRanked(fx.vaultPath, { query: "kubernetes networking", where: { status: "active" } });
  assert.deepEqual(res.results.map((r) => r.path), ["work/net"]);
});

test("filters compose and are still relevance-ordered", async () => {
  const res = await searchNotesRanked(fx.vaultPath, { query: "kubernetes networking", folder: "work" });
  // both work notes match; results carry scores and are sorted desc
  assert.equal(res.results.length, 2);
  assert.ok(res.results[0].score >= res.results[1].score);
});

test("a filter matching zero notes returns an empty envelope", async () => {
  const res = await searchNotesRanked(fx.vaultPath, { query: "kubernetes", folder: "nonexistent" });
  assert.deepEqual(res.results, []);
  assert.equal(res.returned, 0);
  assert.equal(res.truncated, false);
});

test("no filter is unchanged (all matches ranked)", async () => {
  const res = await searchNotesRanked(fx.vaultPath, { query: "kubernetes networking" });
  assert.equal(res.results.length, 3);
});

test("empty tags array is rejected", async () => {
  await assert.rejects(
    () => searchNotesRanked(fx.vaultPath, { query: "x", tags: [] }),
    /tags must be a non-empty array/,
  );
});
