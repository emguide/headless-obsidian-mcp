import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { makeVault, Fixture } from "./fixtures.js";

const run = promisify(execFile);
const CLI = ["tsx", "src/query-cli.ts"];

let fx: Fixture;
before(async () => {
  fx = await makeVault([
    { path: "t.md", content: "# T\n\n## Old Heading\n\nbody\n" },
    { path: "r.md", content: "# R\n[[t#Old Heading]] and [[t#Dead]].\n" },
  ]);
});
after(() => fx.cleanup());

const cli = async (args: string[]) =>
  run("npx", [...CLI, ...args], { env: { ...process.env, OBSIDIAN_VAULT_PATH: fx.vaultPath } });

test("rename-section CLI renames and rewrites anchors", async () => {
  const { stdout } = await cli(["rename-section", "t", "Old Heading", "New Heading"]);
  const res = JSON.parse(stdout);
  assert.equal(res.updated_notes, 1);
  assert.match(await readFile(join(fx.vaultPath, "t.md"), "utf-8"), /## New Heading/);
  assert.match(await readFile(join(fx.vaultPath, "r.md"), "utf-8"), /\[\[t#New Heading\]\]/);
});

test("vault-issues broken_anchors CLI lists dead anchors", async () => {
  const { stdout } = await cli(["vault-issues", "broken_anchors"]);
  const res = JSON.parse(stdout);
  // After the rename above, r.md's [[t#Dead]] is the surviving broken anchor.
  assert.ok(res.results.some((g: any) => g.targets.some((t: any) => t.anchor === "Dead")));
});
