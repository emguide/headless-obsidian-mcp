import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  syncOnce,
  isConflictCopy,
  parseConflictCopy,
  conflictCopyName,
} from "../src/tools/git-sync.js";

const execFileAsync = promisify(execFile);
async function g(dir: string, ...args: string[]) {
  await execFileAsync("git", ["-C", dir, ...args]);
}

/** Remote + two clones that will diverge on the same file. */
async function makeDivergingClones(file: string, base0: string) {
  const base = await mkdtemp(join(tmpdir(), "gitsync-conflict-"));
  const remote = join(base, "remote.git");
  const a = join(base, "a");
  const b = join(base, "b");
  await execFileAsync("git", ["init", "-q", "--bare", remote]);
  await execFileAsync("git", ["clone", "-q", remote, a]);
  await g(a, "config", "user.email", "a@x.com");
  await g(a, "config", "user.name", "A");
  await writeFile(join(a, file), base0);
  await g(a, "add", "-A");
  await g(a, "commit", "-q", "-m", "base");
  await g(a, "push", "-q", "origin", "HEAD");
  await execFileAsync("git", ["clone", "-q", remote, b]);
  await g(b, "config", "user.email", "b@x.com");
  await g(b, "config", "user.name", "B");
  return { base, remote, a, b, cleanup: () => rm(base, { recursive: true, force: true }) };
}

test("isConflictCopy / parseConflictCopy round-trip", () => {
  const name = conflictCopyName("projects/alpha", "2026-07-24 143022");
  assert.equal(name, "projects/alpha (conflicted 2026-07-24 143022)");
  assert.equal(isConflictCopy(name), true);
  assert.equal(isConflictCopy("projects/alpha"), false);
  assert.deepEqual(parseConflictCopy(name), {
    original: "projects/alpha",
    stamp: "2026-07-24 143022",
  });
  assert.equal(parseConflictCopy("projects/alpha"), null);
});

test("conflict: keeps both, remote canonical, tree clean, copy reported", async (t) => {
  process.env.OBSIDIAN_GIT_SYNC = "every-write";
  t.after(() => delete process.env.OBSIDIAN_GIT_SYNC);
  const fx = await makeDivergingClones("note.md", "# Base\nshared\n");
  t.after(fx.cleanup);

  // Remote (via clone b) changes the shared line and pushes.
  await writeFile(join(fx.b, "note.md"), "# Base\nremote-wins\n");
  await g(fx.b, "add", "-A");
  await g(fx.b, "commit", "-q", "-m", "remote edit");
  await g(fx.b, "push", "-q", "origin", "HEAD");

  // Local (clone a) changes the same line, commits, then syncs.
  await writeFile(join(fx.a, "note.md"), "# Base\nlocal-change\n");
  await g(fx.a, "add", "-A");
  await g(fx.a, "commit", "-q", "-m", "local edit");
  const result = await syncOnce(fx.a, { now: new Date(Date.UTC(2026, 6, 24, 14, 30, 22)) });

  // Exactly one conflict copy, reported.
  assert.equal(result.conflicts.length, 1);
  const copy = result.conflicts[0];
  assert.equal(isConflictCopy(copy), true);
  assert.equal(parseConflictCopy(copy)!.original, "note");

  // Canonical note holds the REMOTE version.
  assert.equal(await readFile(join(fx.a, "note.md"), "utf-8"), "# Base\nremote-wins\n");
  // The copy holds the LOCAL version, byte-for-byte, no merge markers.
  const copyContent = await readFile(join(fx.a, `${copy}.md`), "utf-8");
  assert.equal(copyContent, "# Base\nlocal-change\n");
  assert.doesNotMatch(copyContent, /<<<<<<<|=======|>>>>>>>/);

  // Working tree clean and converged.
  const status = (await execFileAsync("git", ["-C", fx.a, "status", "--porcelain"])).stdout.trim();
  assert.equal(status, "", "tree clean after conflict resolution");
});

test("terminal artifact: a conflict copy never spawns a second-order copy", async (t) => {
  process.env.OBSIDIAN_GIT_SYNC = "every-write";
  t.after(() => delete process.env.OBSIDIAN_GIT_SYNC);
  const fx = await makeDivergingClones("note.md", "# Base\nshared\n");
  t.after(fx.cleanup);
  // Pre-seed a conflict copy on both sides at base, so it exists before divergence.
  const existing = conflictCopyName("note", "2026-07-01 000000");
  await writeFile(join(fx.a, `${existing}.md`), "old local\n");
  await g(fx.a, "add", "-A"); await g(fx.a, "commit", "-q", "-m", "seed copy");
  await g(fx.a, "push", "-q", "origin", "HEAD");
  await g(fx.b, "pull", "-q", "origin", "HEAD");

  // Diverge on note.md again.
  await writeFile(join(fx.b, "note.md"), "# Base\nremote2\n");
  await g(fx.b, "add", "-A"); await g(fx.b, "commit", "-q", "-m", "r2"); await g(fx.b, "push", "-q", "origin", "HEAD");
  await writeFile(join(fx.a, "note.md"), "# Base\nlocal2\n");
  await g(fx.a, "add", "-A"); await g(fx.a, "commit", "-q", "-m", "l2");
  const result = await syncOnce(fx.a, { now: new Date(Date.UTC(2026, 6, 24, 14, 30, 22)) });

  // Only note.md conflicts; the pre-existing copy is untouched (not re-copied).
  assert.equal(result.conflicts.length, 1);
  assert.equal(parseConflictCopy(result.conflicts[0])!.original, "note");
  const files = (await readdir(fx.a)).filter((f) => f.includes("conflicted"));
  // The seed copy + exactly one new copy — no copy-of-a-copy.
  assert.equal(files.length, 2, files.join(", "));
});

test("delete/modify conflict: remote deletes, local modifies", async (t) => {
  process.env.OBSIDIAN_GIT_SYNC = "every-write";
  t.after(() => delete process.env.OBSIDIAN_GIT_SYNC);
  const fx = await makeDivergingClones("note.md", "# Base\nshared\n");
  t.after(fx.cleanup);

  // Remote deletes note.md and pushes.
  await g(fx.b, "rm", "-f", "note.md");
  await g(fx.b, "add", "-A");
  await g(fx.b, "commit", "-q", "-m", "remote delete");
  await g(fx.b, "push", "-q", "origin", "HEAD");

  // Local modifies note.md and commits.
  await writeFile(join(fx.a, "note.md"), "# Base\nlocal-modify\n");
  await g(fx.a, "add", "-A");
  await g(fx.a, "commit", "-q", "-m", "local modify");
  const result = await syncOnce(fx.a, { now: new Date(Date.UTC(2026, 6, 24, 14, 30, 22)) });

  // No throw; conflict reported.
  assert.equal(result.conflicts.length, 1);
  const copy = result.conflicts[0];
  assert.equal(isConflictCopy(copy), true);
  assert.equal(parseConflictCopy(copy)!.original, "note");

  // Canonical note is GONE (remote deletion wins).
  assert.equal((await readdir(fx.a)).includes("note.md"), false, "note.md deleted");
  // Conflict copy preserves the local edit.
  const copyContent = await readFile(join(fx.a, `${copy}.md`), "utf-8");
  assert.equal(copyContent, "# Base\nlocal-modify\n");

  // Working tree clean.
  const status = (await execFileAsync("git", ["-C", fx.a, "status", "--porcelain"])).stdout.trim();
  assert.equal(status, "", "tree clean after delete/modify resolution");
});

test("delete/modify conflict: local deletes, remote modifies", async (t) => {
  process.env.OBSIDIAN_GIT_SYNC = "every-write";
  t.after(() => delete process.env.OBSIDIAN_GIT_SYNC);
  const fx = await makeDivergingClones("note.md", "# Base\nshared\n");
  t.after(fx.cleanup);

  // Remote modifies note.md and pushes.
  await writeFile(join(fx.b, "note.md"), "# Base\nremote-modify\n");
  await g(fx.b, "add", "-A");
  await g(fx.b, "commit", "-q", "-m", "remote modify");
  await g(fx.b, "push", "-q", "origin", "HEAD");

  // Local deletes note.md and commits.
  await g(fx.a, "rm", "-f", "note.md");
  await g(fx.a, "add", "-A");
  await g(fx.a, "commit", "-q", "-m", "local delete");
  const result = await syncOnce(fx.a, { now: new Date(Date.UTC(2026, 6, 24, 14, 30, 22)) });

  // No throw; no conflict copy (nothing to preserve locally).
  assert.equal(result.conflicts.length, 0, "no conflict copy when local deleted");

  // Canonical note exists with remote content.
  const content = await readFile(join(fx.a, "note.md"), "utf-8");
  assert.equal(content, "# Base\nremote-modify\n", "remote content preserved");

  // Working tree clean.
  const status = (await execFileAsync("git", ["-C", fx.a, "status", "--porcelain"])).stdout.trim();
  assert.equal(status, "", "tree clean after delete/modify resolution");
});
