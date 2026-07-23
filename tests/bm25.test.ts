import { test } from "node:test";
import assert from "node:assert/strict";
import { BM25 } from "../src/tools/text/bm25.js";

function build(docs: Record<string, string[]>): BM25 {
  const idx = new BM25();
  for (const [id, toks] of Object.entries(docs)) idx.add(id, toks);
  idx.finalize();
  return idx;
}

test("ranks the document with more query-term hits higher", () => {
  const idx = build({
    a: ["cat", "cat", "cat", "dog"],
    b: ["cat", "dog", "dog"],
    c: ["fish"],
  });
  const { hits } = idx.search(["cat"], 10);
  assert.equal(hits[0].docId, "a");
  assert.ok(hits.find((h) => h.docId === "b"));
  assert.ok(!hits.find((h) => h.docId === "c")); // no query term -> excluded
});

test("a rarer term contributes more via IDF", () => {
  const idx = build({
    a: ["common", "rare"],
    b: ["common"],
    c: ["common"],
    d: ["common"],
  });
  // 'rare' appears in 1 of 4 docs; 'common' in all 4. A doc matching 'rare'
  // should score higher than one matching only 'common'.
  const rareHit = idx.search(["rare"], 10).hits[0];
  const commonHit = idx.search(["common"], 10).hits[0];
  assert.ok(rareHit.score > commonHit.score);
});

test("empty query or no match returns an empty array", () => {
  const idx = build({ a: ["cat"] });
  assert.deepEqual(idx.search([], 10), { hits: [], total: 0 });
  assert.deepEqual(idx.search(["zebra"], 10), { hits: [], total: 0 });
});

test("respects the limit", () => {
  const idx = build({
    a: ["x"],
    b: ["x"],
    c: ["x"],
  });
  assert.equal(idx.search(["x"], 2).hits.length, 2);
});

test("search reports total matches beyond the limit", () => {
  const idx = build({
    d1: ["x"],
    d2: ["x"],
    d3: ["x"],
  });
  const res = idx.search(["x"], 2);
  assert.equal(res.hits.length, 2);
  assert.equal(res.total, 3);
});

test("breaks score ties by docId ascending for determinism", () => {
  const idx = build({
    zeta: ["x"],
    alpha: ["x"],
    mid: ["x"],
  });
  // Identical single-token docs => identical scores => docId order.
  const { hits } = idx.search(["x"], 10);
  assert.deepEqual(
    hits.map((h) => h.docId),
    ["alpha", "mid", "zeta"]
  );
});

test("multi-term query sums per-term contributions", () => {
  const idx = build({
    a: ["cat", "dog"],
    b: ["cat"],
  });
  const { hits } = idx.search(["cat", "dog"], 10);
  assert.equal(hits[0].docId, "a"); // matches both terms
});
