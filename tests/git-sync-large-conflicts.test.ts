import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile, readFile, mkdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { syncOnce, isConflictCopy, parseConflictCopy } from "../src/tools/git-sync.js";

/**
 * Merge-stage existence was probed with `git show`, whose stdout ran through
 * the UTF-8 `git()` helper and its default 1MB maxBuffer. Any larger blob threw
 * "maxBuffer length exceeded", which the probe's catch reported as "stage
 * absent" — misrouting every conflict branch and, for both-modified, deleting
 * the canonical note outright. These cover each branch above the old cap.
 */
const OVER_MAXBUFFER = 1024 * 1024 + 4096; // comfortably past execFile's 1MB

/** A >1MB body whose text differs per side, so a wrong branch is detectable. */
function bigBody(marker: string): string {
  const filler = `${marker} filler line for bulk\n`;
  return `# Big\n${marker}\n` + filler.repeat(Math.ceil(OVER_MAXBUFFER / filler.length));
}

const execFileAsync = promisify(execFile);
async function g(dir: string, ...args: string[]) {
  await execFileAsync("git", ["-C", dir, ...args]);
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function makeDivergingClones(file: string, base0: string | Buffer) {
  const base = await mkdtemp(join(tmpdir(), "gitsync-big-"));
  const remote = join(base, "remote.git");
  const a = join(base, "a");
  const b = join(base, "b");
  await execFileAsync("git", ["init", "-q", "--bare", remote]);
  await execFileAsync("git", ["clone", "-q", remote, a]);
  await g(a, "config", "user.email", "a@x.com");
  await g(a, "config", "user.name", "A");
  await mkdir(dirname(join(a, file)), { recursive: true });
  await writeFile(join(a, file), base0);
  await g(a, "add", "-A");
  await g(a, "commit", "-q", "-m", "base");
  await g(a, "push", "-q", "origin", "HEAD");
  await execFileAsync("git", ["clone", "-q", remote, b]);
  await g(b, "config", "user.email", "b@x.com");
  await g(b, "config", "user.name", "B");
  return { base, remote, a, b, cleanup: () => rm(base, { recursive: true, force: true }) };
}

test("both modified >1MB: canonical takes remote, local preserved as copy", async (t) => {
  process.env.OBSIDIAN_GIT_SYNC = "every-write";
  t.after(() => delete process.env.OBSIDIAN_GIT_SYNC);
  const fx = await makeDivergingClones("big.md", bigBody("base"));
  t.after(fx.cleanup);

  const remoteBody = bigBody("remote");
  const localBody = bigBody("local");

  await writeFile(join(fx.b, "big.md"), remoteBody);
  await g(fx.b, "add", "-A");
  await g(fx.b, "commit", "-q", "-m", "remote big edit");
  await g(fx.b, "push", "-q", "origin", "HEAD");

  await writeFile(join(fx.a, "big.md"), localBody);
  await g(fx.a, "add", "-A");
  await g(fx.a, "commit", "-q", "-m", "local big edit");

  const result = await syncOnce(fx.a, { now: new Date(Date.UTC(2026, 6, 24, 14, 30, 22)) });

  // The canonical path must survive — the old bug deleted it here.
  assert.ok(await exists(join(fx.a, "big.md")), "canonical note must not be deleted");
  assert.equal(await readFile(join(fx.a, "big.md"), "utf-8"), remoteBody);

  assert.equal(result.conflicts.length, 1);
  const copy = result.conflicts[0];
  assert.equal(isConflictCopy(copy), true);
  assert.equal(parseConflictCopy(copy)!.original, "big");
  assert.equal(await readFile(join(fx.a, `${copy}.md`), "utf-8"), localBody);

  const status = (await execFileAsync("git", ["-C", fx.a, "status", "--porcelain"])).stdout.trim();
  assert.equal(status, "", "tree clean after conflict resolution");
});

test("remote deleted, local modified >1MB: local preserved, canonical removed", async (t) => {
  process.env.OBSIDIAN_GIT_SYNC = "every-write";
  t.after(() => delete process.env.OBSIDIAN_GIT_SYNC);
  const fx = await makeDivergingClones("big.md", bigBody("base"));
  t.after(fx.cleanup);

  await g(fx.b, "rm", "-q", "-f", "big.md");
  await g(fx.b, "commit", "-q", "-m", "remote delete");
  await g(fx.b, "push", "-q", "origin", "HEAD");

  const localBody = bigBody("local");
  await writeFile(join(fx.a, "big.md"), localBody);
  await g(fx.a, "add", "-A");
  await g(fx.a, "commit", "-q", "-m", "local big edit");

  const result = await syncOnce(fx.a, { now: new Date(Date.UTC(2026, 6, 24, 14, 30, 22)) });

  // Deletion is the canonical outcome, but the local content must be kept aside.
  assert.equal(result.conflicts.length, 1, "local content must be preserved as a copy");
  const copy = result.conflicts[0];
  assert.equal(await readFile(join(fx.a, `${copy}.md`), "utf-8"), localBody);
  assert.equal(await exists(join(fx.a, "big.md")), false);
});

test("local deleted, remote modified >1MB: remote restored, no copy", async (t) => {
  process.env.OBSIDIAN_GIT_SYNC = "every-write";
  t.after(() => delete process.env.OBSIDIAN_GIT_SYNC);
  const fx = await makeDivergingClones("big.md", bigBody("base"));
  t.after(fx.cleanup);

  const remoteBody = bigBody("remote");
  await writeFile(join(fx.b, "big.md"), remoteBody);
  await g(fx.b, "add", "-A");
  await g(fx.b, "commit", "-q", "-m", "remote big edit");
  await g(fx.b, "push", "-q", "origin", "HEAD");

  await g(fx.a, "rm", "-q", "-f", "big.md");
  await g(fx.a, "commit", "-q", "-m", "local delete");

  const result = await syncOnce(fx.a, { now: new Date(Date.UTC(2026, 6, 24, 14, 30, 22)) });

  // Nothing local to preserve, so no copy; remote wins at the canonical path.
  assert.equal(result.conflicts.length, 0);
  assert.equal(await readFile(join(fx.a, "big.md"), "utf-8"), remoteBody);
});

test("both modified >1MB binary attachment: bytes preserved on both sides", async (t) => {
  process.env.OBSIDIAN_GIT_SYNC = "every-write";
  t.after(() => delete process.env.OBSIDIAN_GIT_SYNC);

  // High bytes throughout, so a UTF-8 round-trip anywhere would corrupt them.
  const mk = (fill: number) => {
    const buf = Buffer.alloc(OVER_MAXBUFFER, fill);
    Buffer.from([0x89, 0x50, 0x4e, 0x47]).copy(buf, 0);
    return buf;
  };
  const localBin = mk(0xfe);
  const remoteBin = mk(0xc0);

  const fx = await makeDivergingClones("assets/big.png", mk(0x7f));
  t.after(fx.cleanup);

  await writeFile(join(fx.b, "assets/big.png"), remoteBin);
  await g(fx.b, "add", "-A");
  await g(fx.b, "commit", "-q", "-m", "remote bin");
  await g(fx.b, "push", "-q", "origin", "HEAD");

  await writeFile(join(fx.a, "assets/big.png"), localBin);
  await g(fx.a, "add", "-A");
  await g(fx.a, "commit", "-q", "-m", "local bin");

  const result = await syncOnce(fx.a, { now: new Date(Date.UTC(2026, 6, 24, 14, 30, 22)) });

  assert.ok(await exists(join(fx.a, "assets/big.png")), "canonical attachment must survive");
  assert.deepEqual(await readFile(join(fx.a, "assets/big.png")), remoteBin);
  assert.equal(result.conflicts.length, 1);
  // Non-note conflict copies are reported with their extension already attached.
  assert.deepEqual(await readFile(join(fx.a, result.conflicts[0])), localBin);
});
