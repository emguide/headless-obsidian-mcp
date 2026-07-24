import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { makeVault } from "./fixtures.js";

const run = promisify(execFile);
const CLI = ["tsx", "src/query-cli.ts"];

async function cli(vault: string, args: string[]) {
  return run("npx", [...CLI, ...args], {
    env: { ...process.env, OBSIDIAN_VAULT_PATH: vault },
  });
}

test("config prints the whole config object", async () => {
  const fx = await makeVault([{ path: "a.md", content: "# A\n" }]);
  await mkdir(join(fx.vaultPath, ".obsidian"), { recursive: true });
  await writeFile(
    join(fx.vaultPath, ".obsidian", "templates.json"),
    JSON.stringify({ folder: "Templates" }),
    "utf-8"
  );
  try {
    const { stdout } = await cli(fx.vaultPath, ["config"]);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.template.folder, "Templates");
    assert.equal(parsed.vault.path, fx.vaultPath);
    assert.ok("writes" in parsed);
  } finally {
    await fx.cleanup();
  }
});

test("config template prints just the template section", async () => {
  const fx = await makeVault([{ path: "a.md", content: "# A\n" }]);
  try {
    const { stdout } = await cli(fx.vaultPath, ["config", "template"]);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.folder, null);
    assert.equal(parsed.date_format, "YYYY-MM-DD");
  } finally {
    await fx.cleanup();
  }
});
