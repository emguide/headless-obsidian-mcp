import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { writeNote, appendNote, prependNote } from "../src/tools/write.js";
import { makeVault, Fixture } from "./fixtures.js";

const read = (vault: string, name: string) => readFile(join(vault, name), "utf-8");
const exists = (vault: string, name: string) =>
  stat(join(vault, name)).then(() => true, () => false);

let fx: Fixture;
before(async () => {
  fx = await makeVault([
    { path: "existing.md", content: "---\ntitle: E\n---\nbody\n" },
  ]);
});
after(() => fx.cleanup());

test("writeNote accepts a valid inline frontmatter block", async () => {
  await writeNote(fx.vaultPath, {
    path: "ok",
    content: "---\ntitle: Ok\ntags: [a, b]\n---\n# Ok\n",
  });
  const raw = await read(fx.vaultPath, "ok.md");
  assert.match(raw, /title: Ok/);
});

test("writeNote rejects a nested-map inline block and writes nothing", async () => {
  await assert.rejects(
    () => writeNote(fx.vaultPath, { path: "bad1", content: "---\nauthor:\n  name: y\n---\nx\n" }),
    /nested object/i
  );
  assert.equal(await exists(fx.vaultPath, "bad1.md"), false);
});

test("writeNote rejects markdown-in-string inline block", async () => {
  await assert.rejects(
    () => writeNote(fx.vaultPath, { path: "bad2", content: "---\nnote: \"[[wiki]]\"\n---\nx\n" }),
    /markdown/i
  );
});

test("writeNote rejects malformed YAML inline block", async () => {
  await assert.rejects(
    () => writeNote(fx.vaultPath, { path: "bad3", content: "---\ntitle: [unclosed\n---\nx\n" }),
    /invalid frontmatter/i
  );
});

test("appendNote create-path rejects a violating leading block", async () => {
  await assert.rejects(
    () => appendNote(fx.vaultPath, { path: "app-new", content: "---\nauthor:\n  name: y\n---\nx\n", create: true }),
    /nested object/i
  );
  assert.equal(await exists(fx.vaultPath, "app-new.md"), false);
});

test("appendNote to an existing note does NOT validate leading --- as frontmatter", async () => {
  await appendNote(fx.vaultPath, { path: "existing", content: "---\nnot: frontmatter\n---\n" });
  const raw = await read(fx.vaultPath, "existing.md");
  assert.match(raw, /not: frontmatter/); // appended as body text, not rejected
});

test("prependNote create-path rejects a violating leading block", async () => {
  await assert.rejects(
    () => prependNote(fx.vaultPath, { path: "pre-new", content: "---\nauthor:\n  name: y\n---\nx\n", create: true }),
    /nested object/i
  );
});

test("prependNote to an existing note does NOT validate inserted --- as frontmatter", async () => {
  await prependNote(fx.vaultPath, { path: "existing", content: "---\nnot: frontmatter\n---\n" });
  const raw = await read(fx.vaultPath, "existing.md");
  // Original frontmatter preserved; text inserted after it, never validated.
  assert.match(raw, /title: E/);
  assert.match(raw, /not: frontmatter/);
});
