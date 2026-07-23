import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { makeVault, Fixture } from "./fixtures.js";

const run = promisify(execFile);
const CLI = ["tsx", "src/query-cli.ts"];

async function cli(vault: string, args: string[]) {
  return run("npx", [...CLI, ...args], {
    env: { ...process.env, OBSIDIAN_VAULT_PATH: vault },
  });
}

async function vaultWithTemplates(): Promise<Fixture> {
  const fx = await makeVault([
    { path: "Templates/Daily.md", content: "# {{title}}\n{{date}}\n" },
    { path: "Templates/Meeting.md", content: "# {{title}}\nAgenda\n" },
    { path: "notes/log.md", content: "# Log\n" },
  ]);
  await mkdir(join(fx.vaultPath, ".obsidian"), { recursive: true });
  await writeFile(
    join(fx.vaultPath, ".obsidian", "templates.json"),
    JSON.stringify({ folder: "Templates" }),
    "utf-8"
  );
  return fx;
}

test("templates lists the folder", async () => {
  const fx = await vaultWithTemplates();
  try {
    const { stdout } = await cli(fx.vaultPath, ["templates"]);
    const res = JSON.parse(stdout);
    assert.deepEqual(res.results.map((r: any) => r.name).sort(), [
      "Daily",
      "Meeting",
    ]);
  } finally {
    await fx.cleanup();
  }
});

test("template-apply creates a note with expanded {{title}}", async () => {
  const fx = await vaultWithTemplates();
  try {
    await cli(fx.vaultPath, ["template-apply", "Daily", "journal/entry"]);
    const body = await readFile(
      join(fx.vaultPath, "journal/entry.md"),
      "utf-8"
    );
    assert.match(body, /# entry/);
    assert.match(body, /\d{4}-\d\d-\d\d/);
  } finally {
    await fx.cleanup();
  }
});

test("template-insert appends into an existing note", async () => {
  const fx = await vaultWithTemplates();
  try {
    await cli(fx.vaultPath, [
      "template-insert",
      "Meeting",
      "notes/log",
      "--position",
      "append",
    ]);
    const body = await readFile(join(fx.vaultPath, "notes/log.md"), "utf-8");
    assert.match(body, /# Log/); // original preserved
    assert.match(body, /Agenda/); // template inserted
  } finally {
    await fx.cleanup();
  }
});
