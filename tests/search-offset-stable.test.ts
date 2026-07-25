import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchNotes } from "../src/tools/search.js";

/**
 * ripgrep's parallel walker emits files in a nondeterministic order that can
 * differ between invocations, and each paginated call re-runs it. Windowing raw
 * emission order therefore let page 2 repeat files from page 1 and drop others.
 * Results are now sorted by path before the offset/limit window is applied.
 */
async function bigVault(count: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "search-offset-"));
  await Promise.all(
    Array.from({ length: count }, (_, i) =>
      writeFile(join(dir, `note-${String(i).padStart(3, "0")}.md`), "NEEDLE here\n", "utf-8")
    )
  );
  return dir;
}

test("pages are disjoint and their union is the whole result set", async () => {
  const vault = await bigVault(30);
  const pageSize = 10;

  const all = await searchNotes(vault, { pattern: "NEEDLE", limit: 0 });
  assert.equal(all.results.length, 30);

  const seen: string[] = [];
  for (let offset = 0; offset < 30; offset += pageSize) {
    const page = await searchNotes(vault, { pattern: "NEEDLE", limit: pageSize, offset });
    assert.equal(page.files_skipped, offset);
    seen.push(...page.results.map((r) => r.path));
  }

  assert.equal(new Set(seen).size, seen.length, "pages must not repeat a file");
  assert.deepEqual(
    [...seen].sort(),
    all.results.map((r) => r.path).sort(),
    "pages must cover exactly the full result set"
  );
});

test("the same page is identical across repeated calls", async () => {
  const vault = await bigVault(25);
  const first = await searchNotes(vault, { pattern: "NEEDLE", limit: 5, offset: 10 });
  for (let i = 0; i < 4; i++) {
    const again = await searchNotes(vault, { pattern: "NEEDLE", limit: 5, offset: 10 });
    assert.deepEqual(
      again.results.map((r) => r.path),
      first.results.map((r) => r.path),
      "a given offset/limit window must be stable across invocations"
    );
  }
});

test("results are ordered by path", async () => {
  const vault = await bigVault(12);
  const { results } = await searchNotes(vault, { pattern: "NEEDLE", limit: 0 });
  const paths = results.map((r) => r.path);
  assert.deepEqual(paths, [...paths].sort(), "results must be path-ordered");
});

test("offset past the end is an empty page, not an error", async () => {
  const vault = await bigVault(5);
  const page = await searchNotes(vault, { pattern: "NEEDLE", limit: 10, offset: 99 });
  assert.deepEqual(page.results, []);
  assert.equal(page.files_skipped, 5);
  assert.equal(page.files_omitted, 0);
});
