import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { makeVault, FixtureNote, Fixture } from "./fixtures.js";

const run = promisify(execFile);
const CLI = ["tsx", "src/query-cli.ts"];

function tree(): FixtureNote[] {
  return [
    { path: "root.md", content: "# Root" },
    { path: "projects/overview.md", content: "# Overview" },
    { path: "projects/alpha/index.md", content: "# Alpha" },
    { path: "daily/2026-07-22.md", content: "# Daily" },
  ];
}

let fx: Fixture;
before(async () => {
  fx = await makeVault(tree());
});
after(() => fx.cleanup());

async function folders(args: string[]): Promise<any> {
  const { stdout } = await run("npx", [...CLI, "folders", ...args], {
    env: { ...process.env, OBSIDIAN_VAULT_PATH: fx.vaultPath },
  });
  return JSON.parse(stdout);
}

test("folders subcommand lists folders sorted by path", async () => {
  const res = await folders([]);
  assert.deepEqual(
    res.results.map((f: any) => f.path),
    ["daily", "projects", "projects/alpha"]
  );
});

test("folders subcommand honors --folder and --depth", async () => {
  const res = await folders(["--folder", "projects", "--depth", "1"]);
  assert.deepEqual(
    res.results.map((f: any) => f.path),
    ["projects/alpha"]
  );
});
