import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { searchNotes } from "../src/tools/search.js";
import { listNotes } from "../src/tools/list.js";

const execFileAsync = promisify(execFile);

/**
 * The whole-vault ripgrep invocation honoured .gitignore while the index does
 * not, so a gitignored note was invisible to a plain search but visible to
 * every other tool — including a *filtered* search of the same pattern, which
 * passes explicit candidate paths. search must see exactly what walkVault
 * indexes.
 */
async function mixedVault(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "search-corpus-"));
  await execFileAsync("git", ["init", "-q", dir]);
  await writeFile(join(dir, ".gitignore"), "private/\n", "utf-8");

  for (const sub of ["private", ".secret", "node_modules", "sub"]) {
    await mkdir(join(dir, sub), { recursive: true });
  }
  await writeFile(join(dir, "private/sec.md"), "needle here\n", "utf-8");
  await writeFile(join(dir, "pub.md"), "needle here\n", "utf-8");
  await writeFile(join(dir, ".hidden.md"), "needle here\n", "utf-8");
  await writeFile(join(dir, ".secret/deep.md"), "needle here\n", "utf-8");
  await writeFile(join(dir, "node_modules/dep.md"), "needle here\n", "utf-8");
  await writeFile(join(dir, "sub/ok.md"), "needle here\n", "utf-8");
  return dir;
}

test("unfiltered search sees exactly the indexed corpus", async () => {
  const dir = await mixedVault();

  const indexed = (await listNotes(dir, { limit: 0 })).results.map((n) => n.path).sort();
  const found = (await searchNotes(dir, { pattern: "needle", limit: 0 })).results
    .map((r) => r.path)
    .sort();

  assert.deepEqual(found, indexed);
  // Spelled out, so a regression names the offender.
  assert.deepEqual(found, [".hidden", "private/sec", "pub", "sub/ok"]);
});

test("a gitignored note is searchable", async () => {
  const dir = await mixedVault();
  const found = (await searchNotes(dir, { pattern: "needle", limit: 0 })).results.map(
    (r) => r.path
  );
  assert.ok(found.includes("private/sec"), "gitignored note must not be hidden from search");
});

test("filtered and unfiltered search agree on a gitignored note", async () => {
  const dir = await mixedVault();
  // The original symptom: the same query returned a different corpus depending
  // on whether a filter was present (filters pass explicit candidate paths).
  const unfiltered = (await searchNotes(dir, { pattern: "needle", limit: 0 })).results
    .map((r) => r.path)
    .filter((p) => p.startsWith("private/"));
  const filtered = (
    await searchNotes(dir, { pattern: "needle", folder: "private", limit: 0 })
  ).results.map((r) => r.path);

  assert.deepEqual(unfiltered, filtered);
  assert.deepEqual(filtered, ["private/sec"]);
});

test("machinery directories stay out of search results", async () => {
  const dir = await mixedVault();
  const found = (await searchNotes(dir, { pattern: "needle", limit: 0 })).results.map(
    (r) => r.path
  );
  assert.ok(!found.some((p) => p.startsWith("node_modules/")), "node_modules excluded");
  assert.ok(!found.some((p) => p.startsWith(".secret/")), "hidden directories excluded");
  assert.ok(!found.some((p) => p.includes(".git/")), ".git excluded");
});

test("a hidden note file is searchable, matching the index", async () => {
  const dir = await mixedVault();
  const found = (await searchNotes(dir, { pattern: "needle", limit: 0 })).results.map(
    (r) => r.path
  );
  assert.ok(found.includes(".hidden"), "hidden note files are indexed, so must be searchable");
});
