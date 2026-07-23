import { test } from "node:test";
import assert from "node:assert/strict";
import { extractLinkRefs, headingMatchesAnchor } from "../src/tools/vault.js";

test("extractLinkRefs keeps anchor, alias-stripped, block-ref flagged", () => {
  const refs = extractLinkRefs(
    "See [[note#Heading]], [[other|alias]], [[a#Sec|b]], [[c#^blk]], [[#Self]]."
  );
  assert.deepEqual(refs, [
    { target: "note", anchor: "Heading", isBlockRef: false },
    { target: "other", anchor: null, isBlockRef: false },
    { target: "a", anchor: "Sec", isBlockRef: false },
    { target: "c", anchor: "blk", isBlockRef: true },
    { target: "", anchor: "Self", isBlockRef: false },
  ]);
});

test("extractLinkRefs handles embeds and trims anchor", () => {
  const refs = extractLinkRefs("![[img#  Spaced  ]]");
  assert.deepEqual(refs, [{ target: "img", anchor: "Spaced", isBlockRef: false }]);
});

test("headingMatchesAnchor is case-insensitive and trimmed", () => {
  assert.equal(headingMatchesAnchor("My Heading", "my heading"), true);
  assert.equal(headingMatchesAnchor("  My Heading  ", "My Heading"), true);
  assert.equal(headingMatchesAnchor("My Heading", "my-heading"), false);
  assert.equal(headingMatchesAnchor("Other", "My Heading"), false);
});
