import { test } from "node:test";
import assert from "node:assert/strict";
import { getOutline } from "../src/tools/outline.js";
import { makeVault } from "./fixtures.js";

const NOTE = [
  "---",
  "title: T",
  "---",
  "# Alpha",
  "intro",
  "## Log",
  "a",
  "# Projects",
  "## Log",
  "b",
  "```",
  "## In code",
  "```",
].join("\n");

test("returns level, 1-based line, full path, and ambiguity", async () => {
  const fx = await makeVault([{ path: "n.md", content: NOTE }]);
  try {
    const { path, outline } = await getOutline(fx.vaultPath, "n");
    assert.equal(path, "n");
    assert.deepEqual(outline, [
      { heading: "Alpha", level: 1, path: "Alpha", line: 1, ambiguous: false },
      { heading: "Log", level: 2, path: "Alpha > Log", line: 3, ambiguous: true },
      { heading: "Projects", level: 1, path: "Projects", line: 5, ambiguous: false },
      { heading: "Log", level: 2, path: "Projects > Log", line: 6, ambiguous: true },
    ]);
  } finally {
    await fx.cleanup();
  }
});

test("empty for a note with no headings", async () => {
  const fx = await makeVault([{ path: "e.md", content: "just body text" }]);
  try {
    const { outline } = await getOutline(fx.vaultPath, "e");
    assert.deepEqual(outline, []);
  } finally {
    await fx.cleanup();
  }
});

test("rejects path traversal", async () => {
  const fx = await makeVault([{ path: "n.md", content: "# H" }]);
  try {
    await assert.rejects(() => getOutline(fx.vaultPath, "../escape"), /path traversal/);
  } finally {
    await fx.cleanup();
  }
});

test("throws for a missing note", async () => {
  const fx = await makeVault([{ path: "n.md", content: "# H" }]);
  try {
    await assert.rejects(() => getOutline(fx.vaultPath, "nope"), /not found/i);
  } finally {
    await fx.cleanup();
  }
});
