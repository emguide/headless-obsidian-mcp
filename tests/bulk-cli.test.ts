import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { makeVault } from "./fixtures.js";

const run = promisify(execFile);
const CLI = ["tsx", "src/query-cli.ts"];

test("CLI: bulk-edit --dry-run reports matches without writing", async () => {
  const { vaultPath, cleanup } = await makeVault([
    { path: "a.md", content: "---\nstatus: draft\n---\nbody\n" },
    { path: "b.md", content: "---\nstatus: draft\n---\nbody\n" },
    { path: "c.md", content: "---\nstatus: done\n---\nbody\n" },
  ]);
  try {
    const { stdout } = await run("npx", [
      ...CLI, "bulk-edit",
      "--select", JSON.stringify({ where: { status: "draft" } }),
      "--operations", JSON.stringify([{ op: "add_tag", tags: ["review"] }]),
      "--dry-run",
    ], { env: { ...process.env, OBSIDIAN_VAULT_PATH: vaultPath } });
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.dry_run, true);
    assert.equal(parsed.matched_count, 2);
  } finally {
    await cleanup();
  }
});

test("CLI: bulk-edit applies operations", async () => {
  const { vaultPath, cleanup } = await makeVault([
    { path: "a.md", content: "---\nstatus: draft\n---\nbody\n" },
  ]);
  try {
    const { stdout } = await run("npx", [
      ...CLI, "bulk-edit",
      "--select", JSON.stringify({ paths: ["a"] }),
      "--operations", JSON.stringify([{ op: "set_frontmatter", set: { status: "active" } }]),
    ], { env: { ...process.env, OBSIDIAN_VAULT_PATH: vaultPath } });
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.applied_count, 1);
  } finally {
    await cleanup();
  }
});
