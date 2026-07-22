import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { makeVault } from "./fixtures.js";

const run = promisify(execFile);
const CLI = ["tsx", "src/query-cli.ts"];

test("CLI: properties lists the schema", async () => {
  const { vaultPath, cleanup } = await makeVault([
    { path: "a.md", content: "---\nstatus: active\n---\nbody\n" },
  ]);
  try {
    const { stdout } = await run("npx", [...CLI, "properties"], {
      env: { ...process.env, OBSIDIAN_VAULT_PATH: vaultPath },
    });
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.some((p: any) => p.key === "status"), true);
  } finally {
    await cleanup();
  }
});

test("CLI: query --where filters by condition", async () => {
  const { vaultPath, cleanup } = await makeVault([
    { path: "a.md", content: "---\nstatus: active\n---\nbody\n" },
    { path: "b.md", content: "---\nstatus: done\n---\nbody\n" },
  ]);
  try {
    const { stdout } = await run(
      "npx",
      [...CLI, "query", "--where", '{"status":"active"}'],
      { env: { ...process.env, OBSIDIAN_VAULT_PATH: vaultPath } }
    );
    const parsed = JSON.parse(stdout);
    assert.deepEqual(parsed.map((h: any) => h.path), ["a"]);
  } finally {
    await cleanup();
  }
});

test("CLI: add-property-values mutates the note", async () => {
  const { vaultPath, cleanup } = await makeVault([
    { path: "a.md", content: "---\naliases: [x]\n---\nbody\n" },
  ]);
  try {
    const { stdout } = await run(
      "npx",
      [...CLI, "add-property-values", "a", "aliases", "y"],
      { env: { ...process.env, OBSIDIAN_VAULT_PATH: vaultPath } }
    );
    const parsed = JSON.parse(stdout);
    assert.deepEqual(parsed.values, ["x", "y"]);
  } finally {
    await cleanup();
  }
});
