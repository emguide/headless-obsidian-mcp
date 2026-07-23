import { test } from "node:test";
import assert from "node:assert/strict";
import { BM25 } from "../src/tools/text/bm25.js";

function build(): BM25 {
  const b = new BM25();
  b.add("a", ["alpha", "shared"]);
  b.add("b", ["beta", "shared"]);
  b.add("c", ["gamma", "shared"]);
  b.finalize();
  return b;
}

test("allowedIds restricts scoring to the candidate set", () => {
  const b = build();
  const { hits, total } = b.search(["shared"], 10, new Set(["a", "c"]));
  const ids = hits.map((h) => h.docId).sort();
  assert.deepEqual(ids, ["a", "c"]);
  // total reflects the candidate set (post-allowedIds), not the whole corpus.
  assert.equal(total, 2);
});

test("empty allowedIds yields no hits", () => {
  const b = build();
  assert.deepEqual(b.search(["shared"], 10, new Set()), { hits: [], total: 0 });
});

test("omitting allowedIds scores the whole corpus (unchanged)", () => {
  const b = build();
  const { hits } = b.search(["shared"], 10);
  const ids = hits.map((h) => h.docId).sort();
  assert.deepEqual(ids, ["a", "b", "c"]);
});

test("top-N is taken from candidates, not the global set", () => {
  // 'b' has the strongest 'target' signal but is out of scope; scoping to
  // {a} must still return a, not silently drop to zero results.
  const b = new BM25();
  b.add("a", ["target", "filler", "filler"]);
  b.add("b", ["target", "target", "target"]);
  b.finalize();
  const { hits } = b.search(["target"], 1, new Set(["a"]));
  assert.deepEqual(hits.map((h) => h.docId), ["a"]);
});
