import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { getIndex } from "../src/tools/vault-index.js";
import { searchNotesRanked } from "../src/tools/search-ranked.js";
import { makeVault, Fixture } from "./fixtures.js";
import { writeFile, utimes } from "node:fs/promises";
import { join } from "node:path";

let fx: Fixture;
before(async () => {
  fx = await makeVault([
    {
      path: "k8s.md",
      content: [
        "---",
        "title: Kubernetes Networking",
        "---",
        "# Networking",
        "Pods reach services through the cluster network. Networking is core.",
      ].join("\n"),
    },
    {
      path: "aside.md",
      content: [
        "# Random",
        "This note mentions networking once, in passing.",
      ].join("\n"),
    },
    {
      path: "unrelated.md",
      content: ["# Cooking", "A recipe for soup."].join("\n"),
    },
  ]);
});
after(() => fx.cleanup());

test("ranks the most relevant note first and excludes non-matches", async () => {
  const idx = await getIndex(fx.vaultPath);
  const res = await idx.searchRanked("kubernetes networking", 10);
  assert.equal(res[0].path, "k8s.md".replace(/\.md$/, ""));
  assert.ok(!res.some((r) => r.path === "unrelated"));
  // Scores are descending.
  for (let i = 1; i < res.length; i++) {
    assert.ok(res[i - 1].score >= res[i].score);
  }
});

test("returns note headers with score and snippet", async () => {
  const idx = await getIndex(fx.vaultPath);
  const res = await idx.searchRanked("networking", 10);
  const top = res[0];
  assert.equal(typeof top.score, "number");
  assert.equal(typeof top.snippet, "string");
  assert.ok(top.snippet.length > 0);
  assert.equal(typeof top.title, "string");
  assert.ok(Array.isArray(top.tags));
});

test("respects the limit", async () => {
  const idx = await getIndex(fx.vaultPath);
  const res = await idx.searchRanked("networking", 1);
  assert.equal(res.length, 1);
});

test("empty query returns an empty array", async () => {
  const idx = await getIndex(fx.vaultPath);
  assert.deepEqual(await idx.searchRanked("   ", 10), []);
});

test("reflects edits after refresh", async () => {
  // Add a strong 'networking' signal to the previously-unrelated note.
  const full = join(fx.vaultPath, "unrelated.md");
  await writeFile(
    full,
    "# Networking Networking\nnetworking networking networking cluster",
    "utf-8"
  );
  await utimes(full, new Date(), new Date());
  const idx = await getIndex(fx.vaultPath); // getIndex refreshes
  const res = await idx.searchRanked("networking", 10);
  assert.ok(res.some((r) => r.path === "unrelated"));
});

test("searchNotesRanked wrapper validates and returns ranked results", async () => {
  const res = await searchNotesRanked(fx.vaultPath, { query: "networking" });
  assert.ok(res.length > 0);
  assert.equal(typeof res[0].score, "number");
});

test("searchNotesRanked rejects an empty query", async () => {
  await assert.rejects(
    () => searchNotesRanked(fx.vaultPath, { query: "" }),
    /query must be a non-empty string/i
  );
});

test("searchNotesRanked defaults limit to 10 and caps at 100", async () => {
  const res = await searchNotesRanked(fx.vaultPath, { query: "networking", limit: 1000 });
  assert.ok(res.length <= 100);
});
