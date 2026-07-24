import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { makeVault } from "./fixtures.js";

const execFileAsync = promisify(execFile);
const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "query-cli.ts");

function run(vault: string, args: string[]) {
  return execFileAsync("npx", ["tsx", CLI, ...args], {
    env: { ...process.env, OBSIDIAN_VAULT_PATH: vault },
  });
}

test("query tasks lists checkbox tasks as JSON", async () => {
  const fx = await makeVault([
    { path: "t.md", content: "# H\n- [ ] alpha\n- [x] beta\n" },
  ]);
  try {
    const { stdout } = await run(fx.vaultPath, ["tasks"]);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.results.length, 2);
    assert.equal(parsed.results[0].text, "alpha");
    assert.equal(parsed.results[0].status, "open");
  } finally {
    await fx.cleanup();
  }
});

test("query tasks --status filters", async () => {
  const fx = await makeVault([
    { path: "t.md", content: "- [ ] a\n- [x] b\n" },
  ]);
  try {
    const { stdout } = await run(fx.vaultPath, ["tasks", "--status", "done"]);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.results.length, 1);
    assert.equal(parsed.results[0].text, "b");
  } finally {
    await fx.cleanup();
  }
});

test("query set-task-state toggles a task", async () => {
  const fx = await makeVault([
    { path: "t.md", content: "- [ ] finish report\n" },
  ]);
  try {
    const { stdout } = await run(fx.vaultPath, ["set-task-state", "t", "--text", "finish report", "--status", "done"]);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.changed, true);
    assert.equal(parsed.marker, "x");
  } finally {
    await fx.cleanup();
  }
});
