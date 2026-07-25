import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);
const CLI = join(process.cwd(), "src", "query-cli.ts");

async function runCli(vault: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("npx", ["tsx", CLI, ...args], {
    env: { ...process.env, OBSIDIAN_VAULT_PATH: vault },
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

async function vaultWithTags(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cli-fixes-"));
  await writeFile(join(dir, "one.md"), "---\ntags: [a, b, c]\n---\nbody\n", "utf-8");
  await writeFile(join(dir, "two.md"), "---\ntags: [d, e]\n---\nbody\n", "utf-8");
  return dir;
}

test("tags --offset is honoured, not silently dropped", async () => {
  const vault = await vaultWithTags();

  const all = JSON.parse(await runCli(vault, ["tags"]));
  assert.equal(all.returned, 5);
  assert.equal(all.skipped, 0);

  const paged = JSON.parse(await runCli(vault, ["tags", "--offset", "2"]));
  assert.equal(paged.skipped, 2, "offset must reach listTags");
  assert.equal(paged.returned, 3);
  assert.deepEqual(
    paged.results.map((r: { tag: string }) => r.tag),
    all.results.slice(2).map((r: { tag: string }) => r.tag)
  );
});

test("set-frontmatter coerces scalars like the MCP tool", async () => {
  const vault = await vaultWithTags();
  await runCli(vault, [
    "set-frontmatter",
    "one",
    "--set",
    "priority=3",
    "--set",
    "done=true",
    "--set",
    "name=alpha",
  ]);

  const raw = await readFile(join(vault, "one.md"), "utf-8");
  // Numbers and booleans unquoted; a plain word stays a plain word.
  assert.match(raw, /priority: 3\n/);
  assert.match(raw, /done: true\n/);
  assert.match(raw, /name: alpha\n/);
});

test("a quoted value stays a string", async () => {
  const vault = await vaultWithTags();
  await runCli(vault, ["set-frontmatter", "one", "--set", 'version="7"']);
  const raw = await readFile(join(vault, "one.md"), "utf-8");
  assert.match(raw, /version: '7'\n/, "explicit quoting forces string storage");
});

test("vault-issues help lists every supported kind", async () => {
  const vault = await vaultWithTags();
  const help = await runCli(vault, ["vault-issues", "--help"]);
  for (const kind of ["orphans", "unresolved_links", "broken_anchors", "conflicts"]) {
    assert.ok(help.includes(kind), `help must mention ${kind}`);
  }
});

test("recent --limit help states the real default", async () => {
  const vault = await vaultWithTags();
  const help = await runCli(vault, ["recent", "--help"]);
  assert.ok(help.includes("100"), "documented default must match recent.ts");
  assert.ok(!/default: 20\b/.test(help), "stale default: 20 must be gone");
});

test("vault-issues still dispatches the newer kinds", async () => {
  const vault = await vaultWithTags();
  for (const kind of ["orphans", "unresolved_links", "broken_anchors", "conflicts"]) {
    const out = JSON.parse(await runCli(vault, ["vault-issues", kind]));
    assert.ok(Array.isArray(out.results), `${kind} must return a result envelope`);
  }
});
