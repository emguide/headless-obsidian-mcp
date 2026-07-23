import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { listVaultIssues } from "../src/tools/vault-issues.js";
import { makeVault, Fixture } from "./fixtures.js";
import { BrokenAnchorGroup } from "../src/types.js";

let fx: Fixture;
before(async () => {
  fx = await makeVault([
    { path: "target.md", content: "# Target\n\n## Real Heading\n\nbody\n" },
    {
      path: "src.md",
      content:
        "# Src\n" +
        "good [[target#Real Heading]], " +   // valid → not broken
        "bad [[target#Gone]], " +            // broken heading anchor
        "case [[target#real heading]], " +   // valid (case-insensitive)
        "block [[target#^blk]], " +          // block ref → ignored
        "missing [[nowhere#Gone]], " +       // unresolved NOTE → not our concern
        "plain [[target]].\n",               // no anchor → ignored
    },
    { path: "clean.md", content: "# Clean\n[[target#Real Heading]]\n" },
  ]);
});
after(() => fx.cleanup());

test("broken_anchors surfaces only resolved-note heading anchors with no match", async () => {
  const res = (await listVaultIssues(fx.vaultPath, { kind: "broken_anchors" })) as {
    results: BrokenAnchorGroup[];
    returned: number;
    truncated: boolean;
  };
  assert.equal(res.results.length, 1);
  const group = res.results[0];
  assert.equal(group.source, "src");
  assert.deepEqual(group.targets, [{ target: "target", anchor: "Gone" }]);
});

test("broken_anchors truncation counts groups", async () => {
  const res = (await listVaultIssues(fx.vaultPath, { kind: "broken_anchors", limit: 0 })) as {
    returned: number;
    omitted: number;
  };
  assert.equal(res.omitted, 0);
});
