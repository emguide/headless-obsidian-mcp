import { test } from "node:test";
import assert from "node:assert/strict";
import { readSection } from "../src/tools/section.js";
import { makeVault } from "./fixtures.js";

const NOTE = [
  "---",
  "title: T",
  "---",
  "# Alpha",
  "alpha body",
  "## Log",
  "alpha log line",
  "### Detail",
  "detail line",
  "# Projects",
  "## Log",
  "projects log line",
].join("\n");

test("bare unique heading returns heading + own body, excluding subsections", async () => {
  const fx = await makeVault([{ path: "n.md", content: NOTE }]);
  try {
    const r = await readSection(fx.vaultPath, { path: "n", section: "Alpha" });
    assert.equal(r.section, "Alpha");
    assert.equal(r.level, 1);
    // Excludes ## Log and everything after it.
    assert.equal(r.content, "# Alpha\nalpha body");
  } finally {
    await fx.cleanup();
  }
});

test("include_subsections keeps descendants up to the next same-or-higher heading", async () => {
  const fx = await makeVault([{ path: "n.md", content: NOTE }]);
  try {
    const r = await readSection(fx.vaultPath, {
      path: "n",
      section: "Alpha",
      include_subsections: true,
    });
    assert.equal(
      r.content,
      ["# Alpha", "alpha body", "## Log", "alpha log line", "### Detail", "detail line"].join("\n")
    );
  } finally {
    await fx.cleanup();
  }
});

test("ambiguous bare heading errors with candidate full paths", async () => {
  const fx = await makeVault([{ path: "n.md", content: NOTE }]);
  try {
    await assert.rejects(
      () => readSection(fx.vaultPath, { path: "n", section: "Log" }),
      /Ambiguous section "Log".*Alpha > Log.*Projects > Log/s
    );
  } finally {
    await fx.cleanup();
  }
});

test("full path resolves the exact section", async () => {
  const fx = await makeVault([{ path: "n.md", content: NOTE }]);
  try {
    const r = await readSection(fx.vaultPath, { path: "n", section: "Projects > Log" });
    assert.equal(r.section, "Projects > Log");
    assert.equal(r.content, "## Log\nprojects log line");
  } finally {
    await fx.cleanup();
  }
});

test("missing section errors", async () => {
  const fx = await makeVault([{ path: "n.md", content: NOTE }]);
  try {
    await assert.rejects(
      () => readSection(fx.vaultPath, { path: "n", section: "Nope" }),
      /not found/i
    );
  } finally {
    await fx.cleanup();
  }
});

test("content never includes frontmatter", async () => {
  const fx = await makeVault([{ path: "n.md", content: NOTE }]);
  try {
    const r = await readSection(fx.vaultPath, { path: "n", section: "Alpha" });
    assert.ok(!r.content.includes("title: T"));
  } finally {
    await fx.cleanup();
  }
});

test("rejects path traversal", async () => {
  const fx = await makeVault([{ path: "n.md", content: NOTE }]);
  try {
    await assert.rejects(
      () => readSection(fx.vaultPath, { path: "../escape", section: "Alpha" }),
      /path traversal/
    );
  } finally {
    await fx.cleanup();
  }
});
