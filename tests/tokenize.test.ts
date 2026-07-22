import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenize, stem } from "../src/tools/text/tokenize.js";

test("lowercases and splits on punctuation and whitespace", () => {
  assert.deepEqual(tokenize("Hello, World!"), ["hello", "world"]);
});

test("drops common stopwords", () => {
  // "the", "of", "a" are stopwords; "kubernetes"/"networking" survive (stemmed).
  assert.deepEqual(tokenize("the state of a kubernetes networking"), [
    "kubernet",
    "network",
  ]);
});

test("stems inflected forms to a shared root", () => {
  assert.equal(stem("running"), stem("run"));
  assert.equal(stem("tested"), stem("test"));
  assert.equal(stem("tests"), stem("test"));
});

test("query and document tokenization agree", () => {
  assert.deepEqual(tokenize("Running Tests"), tokenize("run a test"));
});

test("returns an empty array for empty or symbol-only input", () => {
  assert.deepEqual(tokenize(""), []);
  assert.deepEqual(tokenize("--- ###"), []);
});

test("keeps digits and alphanumerics", () => {
  assert.deepEqual(tokenize("k8s cluster1"), ["k8s", "cluster1"]);
});
