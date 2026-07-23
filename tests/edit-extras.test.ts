import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { prependNote, patchNote } from "../src/tools/write.js";
import { makeVault, Fixture } from "./fixtures.js";

const read = (vault: string, name: string) => readFile(join(vault, name), "utf-8");

let fx: Fixture;
before(async () => {
  fx = await makeVault([
    { path: "note.md", content: "---\ntitle: Note\ntags: [a]\n---\n# Note\n\nbody line\n" },
    { path: "plain.md", content: "# Plain\nfox fox fox\n" },
  ]);
});
after(() => fx.cleanup());

/* ------------------------------------------------------------- prepend -- */

test("prependNote inserts after the frontmatter, preserving it byte-for-byte", async () => {
  const result = await prependNote(fx.vaultPath, { path: "note", content: "> callout" });
  assert.deepEqual(result, { path: "note", created: false });
  const out = await read(fx.vaultPath, "note.md");
  assert.equal(out, "---\ntitle: Note\ntags: [a]\n---\n> callout\n# Note\n\nbody line\n");
});

test("prependNote on a note without frontmatter prepends to the top", async () => {
  const result = await prependNote(fx.vaultPath, { path: "plain", content: "top" });
  assert.equal(result.created, false);
  assert.match(await read(fx.vaultPath, "plain.md"), /^top\n# Plain/);
});

test("prependNote errors on a missing note unless create is set", async () => {
  await assert.rejects(() => prependNote(fx.vaultPath, { path: "ghost", content: "x" }), /not found/);
  const created = await prependNote(fx.vaultPath, { path: "ghost", content: "hello", create: true });
  assert.equal(created.created, true);
  assert.equal(await read(fx.vaultPath, "ghost.md"), "hello\n");
});

/* --------------------------------------------------------------- patch -- */

test("patchNote replaces a unique occurrence with all:false", async () => {
  const local = await makeVault([{ path: "p.md", content: "one two three\n" }]);
  const result = await patchNote(local.vaultPath, { path: "p", find: "one", replace: "X" });
  assert.deepEqual(result, { path: "p", replacements: 1 });
  assert.equal(await read(local.vaultPath, "p.md"), "X two three\n");
  await local.cleanup();
});

test("patchNote errors on a non-unique find unless all is set", async () => {
  const local = await makeVault([{ path: "p.md", content: "one two one\n" }]);
  await assert.rejects(
    () => patchNote(local.vaultPath, { path: "p", find: "one", replace: "X" }),
    /occurs 2 times.*all:true/s
  );
  // The note is untouched — the write never happened.
  assert.equal(await read(local.vaultPath, "p.md"), "one two one\n");
  await local.cleanup();
});

test("patchNote with all:true replaces every occurrence of a non-unique find", async () => {
  const local = await makeVault([{ path: "p.md", content: "one two one\n" }]);
  const result = await patchNote(local.vaultPath, { path: "p", find: "one", replace: "X", all: true });
  assert.equal(result.replacements, 2);
  assert.equal(await read(local.vaultPath, "p.md"), "X two X\n");
  await local.cleanup();
});

test("patchNote replaces every occurrence with all:true", async () => {
  const local = await makeVault([{ path: "p.md", content: "a a a\n" }]);
  const result = await patchNote(local.vaultPath, { path: "p", find: "a", replace: "b", all: true });
  assert.equal(result.replacements, 3);
  assert.equal(await read(local.vaultPath, "p.md"), "b b b\n");
  await local.cleanup();
});

test("patchNote errors when the text to find is absent", async () => {
  await assert.rejects(
    () => patchNote(fx.vaultPath, { path: "plain", find: "not-there", replace: "x" }),
    /not found/
  );
});

test("patchNote validates its arguments", async () => {
  await assert.rejects(
    () => patchNote(fx.vaultPath, { path: "plain", find: "", replace: "x" }),
    /non-empty/
  );
});

test("patchNote treats the pattern literally (no regex interpretation)", async () => {
  const local = await makeVault([{ path: "p.md", content: "value = a.b(c)\n" }]);
  const result = await patchNote(local.vaultPath, { path: "p", find: "a.b(c)", replace: "d" });
  assert.equal(result.replacements, 1);
  assert.equal(await read(local.vaultPath, "p.md"), "value = d\n");
  await local.cleanup();
});
