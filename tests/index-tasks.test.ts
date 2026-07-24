import { test } from "node:test";
import assert from "node:assert/strict";
import { getIndex } from "../src/tools/vault-index.js";
import { makeVault } from "./fixtures.js";

test("index stores parsed tasks per note", async () => {
  const fx = await makeVault([
    { path: "n.md", content: "# H\n- [ ] a\n- [x] b\n- plain\n" },
    { path: "empty.md", content: "# No tasks\njust text\n" },
  ]);
  try {
    const index = await getIndex(fx.vaultPath);
    const n = index.getEntry("n");
    assert.deepEqual(
      n?.tasks.map((t) => [t.text, t.status]),
      [["a", "open"], ["b", "done"]]
    );
    assert.deepEqual(index.getEntry("empty")?.tasks, []);
  } finally {
    await fx.cleanup();
  }
});
