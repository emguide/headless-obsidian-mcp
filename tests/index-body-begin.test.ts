import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { getIndex } from "../src/tools/vault-index.js";
import { makeVault, Fixture } from "./fixtures.js";

let fx: Fixture;
before(async () => {
  fx = await makeVault([
    {
      path: "fm.md",
      content: ["---", "tags: [work]", "status: active", "---", "# Head", "body line"].join("\n"),
    },
    { path: "plain.md", content: "# Plain\nno frontmatter here\n" },
    {
      // Closing fence with trailing spaces: the case where gray-matter and
      // NoteDocument disagree. bodyBegin must follow gray-matter (the index's
      // own stripper), whatever it decides — asserted via the parsed task line.
      path: "tricky.md",
      content: "---\nk: v\n---   \n- [ ] tricky task\n",
    },
  ]);
});
after(async () => {
  await fx.cleanup();
});

test("bodyBegin counts the frontmatter block's raw lines", async () => {
  const index = await getIndex(fx.vaultPath);
  assert.equal(index.getEntry("fm")?.bodyBegin, 4);
});

test("bodyBegin is 0 for a note without frontmatter", async () => {
  const index = await getIndex(fx.vaultPath);
  assert.equal(index.getEntry("plain")?.bodyBegin, 0);
});

test("bodyBegin agrees with the index's own task line on a trailing-space fence", async () => {
  const index = await getIndex(fx.vaultPath);
  const entry = index.getEntry("tricky");
  assert.ok(entry);
  // The task sits on raw line 4 (1-based). Index task lines are 0-based
  // body-relative; bodyBegin must bridge the two exactly.
  const task = entry.tasks.find((t) => t.text.includes("tricky task"));
  assert.ok(task);
  assert.equal(entry.bodyBegin + task.line + 1, 4);
});
