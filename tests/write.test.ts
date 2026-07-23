import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  writeNote,
  appendNote,
  deleteNote,
  addTag,
  removeTag,
  setNoteFrontmatter,
  addNoteSection,
  replaceNoteSection,
} from "../src/tools/write.js";
import { GIT_AUTOCOMMIT_ENV } from "../src/tools/git-guard.js";
import { makeVault, Fixture } from "./fixtures.js";

const execFileAsync = promisify(execFile);
const read = (vault: string, name: string) => readFile(join(vault, name), "utf-8");
const exists = (vault: string, name: string) =>
  stat(join(vault, name)).then(() => true, () => false);

/* --------------------------------------------------------------- content -- */

let fx: Fixture;
before(async () => {
  fx = await makeVault([
    { path: "note.md", content: "---\ntitle: Note\ntags: [a]\n---\n# Note\n\n## Log\n\nline one\n" },
  ]);
});
after(() => fx.cleanup());

test("writeNote creates a new note", async () => {
  const result = await writeNote(fx.vaultPath, { path: "fresh", content: "# Fresh\n" });
  assert.deepEqual(result, { path: "fresh", created: true, unresolved_links: [], broken_anchors: [] });
  assert.equal(await read(fx.vaultPath, "fresh.md"), "# Fresh\n");
});

test("writeNote refuses to clobber without overwrite", async () => {
  await assert.rejects(
    () => writeNote(fx.vaultPath, { path: "note", content: "x" }),
    /already exists/
  );
});

test("writeNote overwrites when allowed", async () => {
  const result = await writeNote(fx.vaultPath, { path: "note", content: "replaced\n", overwrite: true });
  assert.equal(result.created, false);
  assert.equal(await read(fx.vaultPath, "note.md"), "replaced\n");
});

test("appendNote appends with a separating newline", async () => {
  await writeNote(fx.vaultPath, { path: "app", content: "one" });
  await appendNote(fx.vaultPath, { path: "app", content: "two" });
  assert.equal(await read(fx.vaultPath, "app.md"), "one\ntwo\n");
});

test("appendNote errors on a missing note unless create is set", async () => {
  await assert.rejects(() => appendNote(fx.vaultPath, { path: "ghost", content: "x" }), /not found/);
  const r = await appendNote(fx.vaultPath, { path: "ghost", content: "x", create: true });
  assert.equal(r.created, true);
});

test("deleteNote removes a note and errors when missing", async () => {
  await writeNote(fx.vaultPath, { path: "temp", content: "x" });
  await deleteNote(fx.vaultPath, "temp");
  assert.equal(await exists(fx.vaultPath, "temp.md"), false);
  await assert.rejects(() => deleteNote(fx.vaultPath, "temp"), /not found/);
});

test("path traversal is rejected on write", async () => {
  await assert.rejects(
    () => writeNote(fx.vaultPath, { path: "../escape", content: "x" }),
    /path traversal/
  );
});

test("structure tools round-trip through the filesystem", async () => {
  await writeNote(fx.vaultPath, {
    path: "struct",
    content: "---\ntitle: S\ntags: [a]\n---\n# S\n\n## Log\n\nline one\n",
  });
  await addTag(fx.vaultPath, { path: "struct", tags: ["b"] });
  await removeTag(fx.vaultPath, { path: "struct", tags: ["a"] });
  await setNoteFrontmatter(fx.vaultPath, { path: "struct", set: { status: "done" } });
  await addNoteSection(fx.vaultPath, { path: "struct", heading: "Refs", content: "see also" });
  await replaceNoteSection(fx.vaultPath, { path: "struct", heading: "Log", content: "line two" });

  const out = await read(fx.vaultPath, "struct.md");
  assert.match(out, /tags:\n  - b/);
  assert.doesNotMatch(out, /- a\b/);
  assert.match(out, /status: done/);
  assert.match(out, /## Log\nline two/);
  assert.match(out, /## Refs\nsee also/);
});

/* ------------------------------------------------------------- git guard -- */

async function git(vault: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", vault, ...args]);
  return stdout;
}

async function initRepo(vault: string): Promise<void> {
  await git(vault, "init", "-q");
  await git(vault, "config", "user.email", "test@example.com");
  await git(vault, "config", "user.name", "Test");
  await git(vault, "add", "-A");
  await git(vault, "commit", "-q", "-m", "initial");
}

let gitFx: Fixture;
beforeEach(async () => {
  gitFx = await makeVault([{ path: "seed.md", content: "# Seed\n" }]);
});
afterEach(async () => {
  delete process.env[GIT_AUTOCOMMIT_ENV];
  await gitFx.cleanup();
});

test("guard off: writes work with no git repo", async () => {
  await writeNote(gitFx.vaultPath, { path: "x", content: "hi\n" });
  assert.equal(await read(gitFx.vaultPath, "x.md"), "hi\n");
});

test("guard on: snapshots dirty state, leaving the new write uncommitted", async () => {
  await initRepo(gitFx.vaultPath);
  // Make the tree dirty so there is something to snapshot.
  await writeNote(gitFx.vaultPath, { path: "seed", content: "# Seed edited\n", overwrite: true });
  const before = (await git(gitFx.vaultPath, "rev-list", "--count", "HEAD")).trim();

  process.env[GIT_AUTOCOMMIT_ENV] = "1";
  await writeNote(gitFx.vaultPath, { path: "new", content: "# New\n" });

  const afterCount = (await git(gitFx.vaultPath, "rev-list", "--count", "HEAD")).trim();
  assert.equal(Number(afterCount), Number(before) + 1, "a snapshot commit was made");

  // The snapshot captured the pre-write edit...
  const head = await git(gitFx.vaultPath, "show", "HEAD:seed.md");
  assert.equal(head, "# Seed edited\n");
  // ...and the agent's own write is left uncommitted for review.
  const status = await git(gitFx.vaultPath, "status", "--porcelain");
  assert.match(status, /new\.md/);
});

test("guard on with a clean tree: no snapshot commit, write still happens", async () => {
  await initRepo(gitFx.vaultPath);
  const before = (await git(gitFx.vaultPath, "rev-list", "--count", "HEAD")).trim();

  process.env[GIT_AUTOCOMMIT_ENV] = "1";
  await writeNote(gitFx.vaultPath, { path: "clean", content: "# Clean\n" });

  const afterCount = (await git(gitFx.vaultPath, "rev-list", "--count", "HEAD")).trim();
  assert.equal(afterCount, before, "no commit when nothing to snapshot");
  assert.equal(await read(gitFx.vaultPath, "clean.md"), "# Clean\n");
});

test("guard on but not a git repo: fail-closed, nothing written", async () => {
  process.env[GIT_AUTOCOMMIT_ENV] = "1";
  await assert.rejects(
    () => writeNote(gitFx.vaultPath, { path: "blocked", content: "x" }),
    /not a git repository/
  );
  assert.equal(await exists(gitFx.vaultPath, "blocked.md"), false);
});
