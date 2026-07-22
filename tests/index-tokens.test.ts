import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { getIndex } from "../src/tools/vault-index.js";
import { allHeadings } from "../src/tools/vault.js";
import { makeVault, Fixture } from "./fixtures.js";

test("allHeadings returns every heading in order", () => {
  const md = "# One\n\nbody\n\n## Two\n\n### Three\n";
  assert.deepEqual(allHeadings(md), ["One", "Two", "Three"]);
});

test("allHeadings is empty when there are no headings", () => {
  assert.deepEqual(allHeadings("just a paragraph"), []);
});

let fx: Fixture;
before(async () => {
  fx = await makeVault([
    {
      path: "note.md",
      content: [
        "---",
        "title: Kubernetes Networking",
        "tags: [infra]",
        "---",
        "# Overview",
        "The pod talks to the service.",
      ].join("\n"),
    },
  ]);
});
after(() => fx.cleanup());

test("index entry carries a boosted token stream", async () => {
  const idx = await getIndex(fx.vaultPath);
  const entry = idx.getEntry("note")!;
  assert.ok(Array.isArray(entry.tokens));
  // Body word present.
  assert.ok(entry.tokens.includes("pod"));
  // Title token 'network' (stemmed) appears at least twice: once from the
  // title's ×2 boost injection (title is not in the body here).
  const netCount = entry.tokens.filter((t) => t === "network").length;
  assert.ok(netCount >= 2, `expected boosted title token, got ${netCount}`);
  // Tag token present.
  assert.ok(entry.tokens.includes("infra"));
});
