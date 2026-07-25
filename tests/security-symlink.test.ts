import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveNotePath, resolveVaultFile } from "../src/tools/vault.js";
import { readNotes } from "../src/tools/read.js";
import { writeNote, appendNote, moveFile } from "../src/tools/write.js";
import { getFrontmatter } from "../src/tools/frontmatter.js";

/**
 * The path guards were purely lexical (resolve/join/relative), so a symlink
 * inside the vault was followed straight past them: `relative()` only ever saw
 * the link's own name, never the target. Readers returned files from outside
 * the vault and writers clobbered them.
 */
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "symlink-guard-"));
  const vault = join(base, "vault");
  await mkdir(vault, { recursive: true });

  const outsideFile = join(base, "secret.txt");
  await writeFile(outsideFile, "TOP-SECRET\n", "utf-8");
  const outsideDir = join(base, "outside");
  await mkdir(outsideDir, { recursive: true });
  await writeFile(join(outsideDir, "hidden.md"), "hidden body\n", "utf-8");

  // A note-shaped symlink, and a symlinked directory.
  await symlink(outsideFile, join(vault, "secret.md"));
  await symlink(outsideDir, join(vault, "elsewhere"));
  await writeFile(join(vault, "real.md"), "real body\n", "utf-8");

  return { base, vault, outsideFile, outsideDir };
}

const ESCAPES = /path traversal not allowed/;

test("resolveNotePath rejects a symlinked note", async () => {
  const { vault } = await fixture();
  await assert.rejects(() => resolveNotePath(vault, "secret"), ESCAPES);
});

test("resolveNotePath rejects a path through a symlinked directory", async () => {
  const { vault } = await fixture();
  await assert.rejects(() => resolveNotePath(vault, "elsewhere/hidden"), ESCAPES);
  // Also for a target that does not exist yet inside the symlinked directory.
  await assert.rejects(() => resolveNotePath(vault, "elsewhere/brand-new"), ESCAPES);
});

test("resolveVaultFile rejects a symlinked attachment path", async () => {
  const { vault } = await fixture();
  await assert.rejects(() => resolveVaultFile(vault, "secret.md"), ESCAPES);
  await assert.rejects(() => resolveVaultFile(vault, "elsewhere/any.png"), ESCAPES);
});

test("read_notes cannot exfiltrate through a symlink", async () => {
  const { vault } = await fixture();
  await assert.rejects(() => readNotes(vault, ["secret"]), ESCAPES);
  await assert.rejects(() => readNotes(vault, ["elsewhere/hidden"]), ESCAPES);
});

test("get_frontmatter cannot read through a symlink", async () => {
  const { vault } = await fixture();
  await assert.rejects(() => getFrontmatter(vault, "secret"), ESCAPES);
});

test("writes cannot clobber a file outside the vault", async () => {
  const { vault, outsideFile } = await fixture();
  await assert.rejects(
    () => writeNote(vault, { path: "secret", content: "CLOBBERED", overwrite: true }),
    ESCAPES
  );
  await assert.rejects(
    () => appendNote(vault, { path: "secret", content: "APPENDED" }),
    ESCAPES
  );
  await assert.rejects(
    () => writeNote(vault, { path: "elsewhere/planted", content: "x" }),
    ESCAPES
  );
  assert.equal(await readFile(outsideFile, "utf-8"), "TOP-SECRET\n", "target untouched");
});

test("move_file cannot move a file out of the vault", async () => {
  const { vault } = await fixture();
  await assert.rejects(
    () => moveFile(vault, { from: "real.md", to: "elsewhere/stolen.md" }),
    ESCAPES
  );
});

test("ordinary notes are unaffected by the guard", async () => {
  const { vault } = await fixture();
  const full = await resolveNotePath(vault, "real");
  assert.ok(full.endsWith("real.md"));

  const { notes } = await readNotes(vault, ["real"]);
  assert.equal(notes[0].contents, "real body\n");

  await writeNote(vault, { path: "fresh", content: "new note\n" });
  assert.equal(await readFile(join(vault, "fresh.md"), "utf-8"), "new note\n");

  // A note in a real (non-symlinked) subfolder still resolves.
  await mkdir(join(vault, "sub"), { recursive: true });
  await writeNote(vault, { path: "sub/deep", content: "deep\n" });
  const deep = await readNotes(vault, ["sub/deep"]);
  assert.equal(deep.notes[0].contents, "deep\n");
});

test("plain ../ traversal is still rejected", async () => {
  const { vault } = await fixture();
  await assert.rejects(() => resolveNotePath(vault, "../escape"), ESCAPES);
  await assert.rejects(() => resolveVaultFile(vault, "../../etc/passwd"), ESCAPES);
});
