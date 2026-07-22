import { test } from "node:test";
import assert from "node:assert/strict";
import { getIndex } from "../src/tools/vault-index.js";
import { makeVault } from "./fixtures.js";

test("index stores fence-aware structured headings per note", async () => {
  const fx = await makeVault([
    {
      path: "n.md",
      content: ["# Top", "```", "# fake", "```", "## Sub"].join("\n"),
    },
  ]);
  try {
    const index = await getIndex(fx.vaultPath);
    const entry = index.getEntry("n");
    assert.ok(entry);
    assert.deepEqual(
      entry!.headings.map((h) => [h.text, h.level]),
      [["Top", 1], ["Sub", 2]]
    );
  } finally {
    await fx.cleanup();
  }
});
