import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHeadings, headingPaths, firstHeading } from "../src/tools/vault.js";

test("parses headings with level and 0-based line", () => {
  const md = ["# Top", "body", "## Sub", "more"].join("\n");
  assert.deepEqual(parseHeadings(md), [
    { text: "Top", level: 1, line: 0 },
    { text: "Sub", level: 2, line: 2 },
  ]);
});

test("skips ATX headings inside fenced code blocks", () => {
  const md = ["# Real", "```", "# Not a heading", "```", "~~~", "## Also not", "~~~", "## Real2"].join("\n");
  assert.deepEqual(
    parseHeadings(md).map((h) => h.text),
    ["Real", "Real2"]
  );
});

test("derives > -joined ancestor paths via the level stack", () => {
  const md = ["# A", "## B", "### C", "## D", "# E"].join("\n");
  assert.deepEqual(headingPaths(parseHeadings(md)), [
    "A",
    "A > B",
    "A > B > C",
    "A > D",
    "E",
  ]);
});

test("a level skip attaches to the nearest shallower ancestor", () => {
  const md = ["# A", "#### Deep"].join("\n");
  assert.deepEqual(headingPaths(parseHeadings(md)), ["A", "A > Deep"]);
});

test("firstHeading returns the first heading text", () => {
  assert.equal(firstHeading("intro\n## Second\n# First-ish"), "Second");
});
