import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { getIndex } from "../src/tools/vault-index.js";
import { searchNotesRanked } from "../src/tools/search-ranked.js";
import { makeVault, Fixture } from "./fixtures.js";
import { writeFile, utimes, unlink } from "node:fs/promises";
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
  assert.equal(res.results[0].path, "k8s.md".replace(/\.md$/, ""));
  assert.ok(!res.results.some((r) => r.path === "unrelated"));
  // Scores are descending.
  for (let i = 1; i < res.results.length; i++) {
    assert.ok(res.results[i - 1].score >= res.results[i].score);
  }
});

test("returns note headers with score and snippet", async () => {
  const idx = await getIndex(fx.vaultPath);
  const res = await idx.searchRanked("networking", 10);
  const top = res.results[0];
  assert.equal(typeof top.score, "number");
  assert.equal(typeof top.snippet, "string");
  assert.ok(top.snippet.length > 0);
  assert.equal(typeof top.title, "string");
  assert.ok(Array.isArray(top.tags));
});

test("respects the limit", async () => {
  const idx = await getIndex(fx.vaultPath);
  const res = await idx.searchRanked("networking", 1);
  assert.equal(res.results.length, 1);
});

test("empty query returns an empty envelope", async () => {
  const idx = await getIndex(fx.vaultPath);
  assert.deepEqual(await idx.searchRanked("   ", 10), {
    results: [],
    returned: 0,
    omitted: 0,
    truncated: false,
  });
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
  assert.ok(res.results.some((r) => r.path === "unrelated"));
});

test("searchNotesRanked wrapper validates and returns ranked results", async () => {
  const res = await searchNotesRanked(fx.vaultPath, { query: "networking" });
  assert.ok(res.results.length > 0);
  assert.equal(typeof res.results[0].score, "number");
});

test("searchNotesRanked rejects an empty query", async () => {
  await assert.rejects(
    () => searchNotesRanked(fx.vaultPath, { query: "" }),
    /query must be a non-empty string/i
  );
});

test("searchNotesRanked defaults limit to 100 and caps a positive limit at 100", async () => {
  const res = await searchNotesRanked(fx.vaultPath, { query: "networking", limit: 1000 });
  assert.ok(res.results.length <= 100);
});

test("snippet actually contains a query word, not just any text", async () => {
  const idx = await getIndex(fx.vaultPath);
  const res = await idx.searchRanked("pods", 10);
  assert.equal(res.results[0].path, "k8s");
  assert.ok(res.results[0].snippet.toLowerCase().includes("pod"));
});

test("searchRanked does not throw when a winning note's file is deleted before the snippet read", async () => {
  const fx2 = await makeVault([
    {
      path: "solo.md",
      content: ["# Solo", "This note talks about widgets extensively."].join("\n"),
    },
  ]);
  try {
    const idx = await getIndex(fx2.vaultPath);
    await unlink(join(fx2.vaultPath, "solo.md"));
    const res = await idx.searchRanked("widgets", 10);
    assert.ok(Array.isArray(res.results));
  } finally {
    await fx2.cleanup();
  }
});

test("a positive limit smaller than the match count truncates with correct counts", async () => {
  const fx3 = await makeVault([
    { path: "a.md", content: "# A\nwidgets widgets widgets everywhere in this note." },
    { path: "b.md", content: "# B\nwidgets widgets in this note too." },
    { path: "c.md", content: "# C\nwidgets appear here as well." },
  ]);
  try {
    const idx = await getIndex(fx3.vaultPath);
    const res = await idx.searchRanked("widgets", 2);
    assert.equal(res.truncated, true);
    assert.equal(res.returned, 2);
    assert.equal(res.omitted, 1);
    assert.equal(res.results.length, 2);

    const all = await idx.searchRanked("widgets", 50);
    assert.equal(all.truncated, false);
    assert.equal(all.omitted, 0);
  } finally {
    await fx3.cleanup();
  }
});

test("searchNotesRanked: limit 0 is unbounded and returns every match", async () => {
  const fx4 = await makeVault([
    { path: "a.md", content: "# A\ngizmos gizmos gizmos everywhere in this note." },
    { path: "b.md", content: "# B\ngizmos gizmos in this note too." },
    { path: "c.md", content: "# C\ngizmos appear here as well." },
  ]);
  try {
    const res = await searchNotesRanked(fx4.vaultPath, { query: "gizmos", limit: 0 });
    assert.equal(res.truncated, false);
    assert.equal(res.omitted, 0);
    assert.equal(res.results.length, 3);
    assert.equal(res.returned, 3);
  } finally {
    await fx4.cleanup();
  }
});

test("searchRanked restricts results to allowedIds", async () => {
  const idx = await getIndex(fx.vaultPath);
  const res = await idx.searchRanked("networking", 10, new Set(["aside"]));
  assert.deepEqual(res.results.map((r) => r.path), ["aside"]);
});

test("searchRanked with empty allowedIds returns nothing", async () => {
  const idx = await getIndex(fx.vaultPath);
  const res = await idx.searchRanked("networking", 10, new Set());
  assert.deepEqual(res.results, []);
  assert.equal(res.returned, 0);
});
