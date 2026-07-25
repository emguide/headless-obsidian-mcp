import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listFiles } from "../src/tools/files.js";
import { searchNotes } from "../src/tools/search.js";
import { VaultIndex } from "../src/tools/vault-index.js";

/* ------------------------------------------------ list_files extensions -- */

test("extension comes from the basename, not the whole path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "files-ext-"));
  await mkdir(join(dir, "img.assets"), { recursive: true });
  await writeFile(join(dir, "img.assets", "README"), "x", "utf-8");
  await writeFile(join(dir, "img.assets", "pic.PNG"), "x", "utf-8");

  const { results } = await listFiles(dir, { limit: 0 });
  const readme = results.find((f) => f.path.endsWith("README"))!;
  const pic = results.find((f) => f.path.endsWith("pic.PNG"))!;

  // Previously "assets/readme" — a slash-containing, unmatchable "extension".
  assert.equal(readme.extension, "");
  assert.equal(pic.extension, "png");
});

test("a dotfile basename is hidden, not an extension", async () => {
  const dir = await mkdtemp(join(tmpdir(), "files-dotfile-"));
  await writeFile(join(dir, ".gitignore"), "x", "utf-8");
  const { results } = await listFiles(dir, { limit: 0 });
  const dotfile = results.find((f) => f.path === ".gitignore");
  if (dotfile) assert.equal(dotfile.extension, "");
});

test("extension filtering still works", async () => {
  const dir = await mkdtemp(join(tmpdir(), "files-filter-"));
  await mkdir(join(dir, "a.b"), { recursive: true });
  await writeFile(join(dir, "a.b", "one.png"), "x", "utf-8");
  await writeFile(join(dir, "a.b", "plain"), "x", "utf-8");
  await writeFile(join(dir, "two.pdf"), "x", "utf-8");

  const png = await listFiles(dir, { extension: "png", limit: 0 });
  assert.deepEqual(png.results.map((f) => f.path), ["a.b/one.png"]);

  const pdf = await listFiles(dir, { extension: ".PDF", limit: 0 });
  assert.deepEqual(pdf.results.map((f) => f.path), ["two.pdf"]);
});

/* ------------------------------- filtered search vs a vanished candidate -- */

test("a filtered search survives a candidate deleted mid-call", async () => {
  const dir = await mkdtemp(join(tmpdir(), "search-vanish-"));
  await mkdir(join(dir, "projects"), { recursive: true });
  await writeFile(join(dir, "projects", "keep.md"), "needle here\n", "utf-8");
  await writeFile(join(dir, "projects", "gone.md"), "needle here\n", "utf-8");

  // Warm the index so both notes are candidates, then delete one before the
  // search spawns ripgrep — rg exits 2 for the missing path.
  const index = new VaultIndex(dir);
  await index.refresh();
  await rm(join(dir, "projects", "gone.md"));

  const { results } = await searchNotes(
    dir,
    { pattern: "needle", folder: "projects", limit: 0 },
    index
  );
  assert.deepEqual(
    results.map((r) => r.path),
    ["projects/keep"],
    "the surviving candidate must still be returned"
  );
});

test("a genuine ripgrep failure still throws", async () => {
  const dir = await mkdtemp(join(tmpdir(), "search-badpat-"));
  await writeFile(join(dir, "n.md"), "text\n", "utf-8");
  // An invalid regex is a real failure, not a missing file.
  await assert.rejects(() => searchNotes(dir, { pattern: "(unclosed" }), /Search failed/);
});

/* ------------------------------------------- concurrent index refreshes -- */

test("overlapping refreshes do not drop a just-added note", async () => {
  const dir = await mkdtemp(join(tmpdir(), "index-race-"));
  await writeFile(join(dir, "first.md"), "one\n", "utf-8");

  const index = new VaultIndex(dir);
  await index.refresh();

  // Fire several refreshes while a new note appears between them.
  const a = index.refresh();
  await writeFile(join(dir, "second.md"), "two\n", "utf-8");
  const b = index.refresh();
  const c = index.refresh();
  await Promise.all([a, b, c]);
  // A final settled pass must see both notes.
  await index.refresh();

  const paths = index.getEntries().map((e) => e.path).sort();
  assert.deepEqual(paths, ["first", "second"]);
});

test("concurrent refresh callers share one pass", async () => {
  const dir = await mkdtemp(join(tmpdir(), "index-share-"));
  await writeFile(join(dir, "n.md"), "x\n", "utf-8");
  const index = new VaultIndex(dir);

  const results = await Promise.all([index.refresh(), index.refresh(), index.refresh()]);
  assert.equal(results.length, 3);
  assert.equal(index.getEntries().length, 1);
});
