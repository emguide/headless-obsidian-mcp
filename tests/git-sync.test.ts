import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveGitSyncMode,
  gitSyncInterval,
  gitRemote,
} from "../src/tools/env-flags.js";
import {
  git,
  isGitRepo,
  commitAfterWrite,
  syncOnce,
  withGitLock,
} from "../src/tools/git-sync.js";
import { runSyncTick } from "../src/tools/sync-timer.js";
import { getSyncState } from "../src/tools/sync-state.js";

const execFileAsync = promisify(execFile);
async function g(dir: string, ...args: string[]) {
  await execFileAsync("git", ["-C", dir, ...args]);
}

/** A bare "remote" plus a working clone wired to it, with identity configured. */
async function makeRemoteAndClone() {
  const base = await mkdtemp(join(tmpdir(), "gitsync-"));
  const remote = join(base, "remote.git");
  const work = join(base, "work");
  await execFileAsync("git", ["init", "-q", "--bare", remote]);
  await execFileAsync("git", ["clone", "-q", remote, work]);
  await g(work, "config", "user.email", "t@example.com");
  await g(work, "config", "user.name", "T");
  await writeFile(join(work, "seed.md"), "# Seed\n");
  await g(work, "add", "-A");
  await g(work, "commit", "-q", "-m", "seed");
  await g(work, "push", "-q", "origin", "HEAD");
  return { base, remote, work, cleanup: () => rm(base, { recursive: true, force: true }) };
}

test("mode: unset env → off, no warning", () => {
  const { mode, warning } = resolveGitSyncMode({});
  assert.equal(mode, "off");
  assert.equal(warning, null);
});

test("mode: explicit values pass through", () => {
  for (const m of ["off", "commit", "every-write", "timer"] as const) {
    assert.equal(resolveGitSyncMode({ OBSIDIAN_GIT_SYNC: m }).mode, m);
  }
});

test("mode: unknown value throws (fail-loud)", () => {
  assert.throws(() => resolveGitSyncMode({ OBSIDIAN_GIT_SYNC: "sync-please" }), /OBSIDIAN_GIT_SYNC/);
});

test("migration: legacy autocommit alone maps to commit with a warning", () => {
  const { mode, warning } = resolveGitSyncMode({ OBSIDIAN_GIT_AUTOCOMMIT: "1" });
  assert.equal(mode, "commit");
  assert.match(warning ?? "", /OBSIDIAN_GIT_AUTOCOMMIT/);
});

test("migration: explicit OBSIDIAN_GIT_SYNC wins over legacy flag (still warns)", () => {
  const { mode, warning } = resolveGitSyncMode({
    OBSIDIAN_GIT_AUTOCOMMIT: "1",
    OBSIDIAN_GIT_SYNC: "every-write",
  });
  assert.equal(mode, "every-write");
  assert.match(warning ?? "", /OBSIDIAN_GIT_AUTOCOMMIT/);
});

test("migration: falsy legacy flag does not warn or change mode", () => {
  const { mode, warning } = resolveGitSyncMode({ OBSIDIAN_GIT_AUTOCOMMIT: "0" });
  assert.equal(mode, "off");
  assert.equal(warning, null);
});

test("interval: default 300, parsed, floored at 1", () => {
  assert.equal(gitSyncInterval({}), 300);
  assert.equal(gitSyncInterval({ OBSIDIAN_GIT_SYNC_INTERVAL: "60" }), 60);
  assert.equal(gitSyncInterval({ OBSIDIAN_GIT_SYNC_INTERVAL: "0" }), 1);
  assert.equal(gitSyncInterval({ OBSIDIAN_GIT_SYNC_INTERVAL: "notnum" }), 300);
});

test("remote: default origin, override respected", () => {
  assert.equal(gitRemote({}), "origin");
  assert.equal(gitRemote({ OBSIDIAN_GIT_REMOTE: "backup" }), "backup");
});

test("commitAfterWrite (mode off): no commit", async (t) => {
  const fx = await makeRemoteAndClone();
  t.after(fx.cleanup);
  delete process.env.OBSIDIAN_GIT_SYNC;
  const before = (await execFileAsync("git", ["-C", fx.work, "rev-list", "--count", "HEAD"])).stdout.trim();
  await writeFile(join(fx.work, "a.md"), "hi\n");
  await commitAfterWrite(fx.work, "write_note: a");
  const after = (await execFileAsync("git", ["-C", fx.work, "rev-list", "--count", "HEAD"])).stdout.trim();
  assert.equal(after, before, "off mode makes no commit");
});

test("commitAfterWrite (mode commit): commits the change with the message", async (t) => {
  const fx = await makeRemoteAndClone();
  t.after(fx.cleanup);
  process.env.OBSIDIAN_GIT_SYNC = "commit";
  t.after(() => delete process.env.OBSIDIAN_GIT_SYNC);
  await writeFile(join(fx.work, "a.md"), "hi\n");
  await commitAfterWrite(fx.work, "write_note: a (created)");
  const log = (await execFileAsync("git", ["-C", fx.work, "log", "-1", "--pretty=%s"])).stdout.trim();
  assert.equal(log, "write_note: a (created)");
  const status = (await execFileAsync("git", ["-C", fx.work, "status", "--porcelain"])).stdout.trim();
  assert.equal(status, "", "working tree clean after commit");
});

test("commitAfterWrite (mode commit): no staged changes → no commit, no throw", async (t) => {
  const fx = await makeRemoteAndClone();
  t.after(fx.cleanup);
  process.env.OBSIDIAN_GIT_SYNC = "commit";
  t.after(() => delete process.env.OBSIDIAN_GIT_SYNC);
  const before = (await execFileAsync("git", ["-C", fx.work, "rev-list", "--count", "HEAD"])).stdout.trim();
  await commitAfterWrite(fx.work, "noop");
  const after = (await execFileAsync("git", ["-C", fx.work, "rev-list", "--count", "HEAD"])).stdout.trim();
  assert.equal(after, before);
});

test("commitAfterWrite: enabled but not a repo → fail-closed throw", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "gitsync-norepo-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  process.env.OBSIDIAN_GIT_SYNC = "commit";
  t.after(() => delete process.env.OBSIDIAN_GIT_SYNC);
  await assert.rejects(() => commitAfterWrite(base, "x"), /not a git repository/);
});

test("syncOnce: fast-forward pull brings remote commits, push sends local", async (t) => {
  const fx = await makeRemoteAndClone();
  t.after(fx.cleanup);
  // Second clone advances the remote.
  const work2 = join(fx.base, "work2");
  await execFileAsync("git", ["clone", "-q", fx.remote, work2]);
  await g(work2, "config", "user.email", "t2@example.com");
  await g(work2, "config", "user.name", "T2");
  await writeFile(join(work2, "b.md"), "# B\n");
  await g(work2, "add", "-A");
  await g(work2, "commit", "-q", "-m", "add b");
  await g(work2, "push", "-q", "origin", "HEAD");
  // Local clone makes its own commit, then syncs.
  process.env.OBSIDIAN_GIT_SYNC = "every-write";
  t.after(() => delete process.env.OBSIDIAN_GIT_SYNC);
  await writeFile(join(fx.work, "c.md"), "# C\n");
  await g(fx.work, "add", "-A");
  await g(fx.work, "commit", "-q", "-m", "add c");
  const result = await syncOnce(fx.work);
  assert.equal(result.conflicts.length, 0);
  assert.equal(await readFile(join(fx.work, "b.md"), "utf-8"), "# B\n", "pulled b");
  // Remote now has c (verify via a fresh clone).
  const verify = join(fx.base, "verify");
  await execFileAsync("git", ["clone", "-q", fx.remote, verify]);
  assert.equal(await readFile(join(verify, "c.md"), "utf-8"), "# C\n", "pushed c");
});

test("runSyncTick: records success on a clean sync", async (t) => {
  const fx = await makeRemoteAndClone();
  t.after(fx.cleanup);
  process.env.OBSIDIAN_GIT_SYNC = "timer";
  t.after(() => delete process.env.OBSIDIAN_GIT_SYNC);
  await runSyncTick(fx.work);
  const state = getSyncState();
  assert.match(state.last_sync ?? "", /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(state.last_error, null);
});

test("withGitLock: serializes overlapping critical sections (no interleave)", async () => {
  // Two tasks whose bodies would interleave without the lock: each records its
  // start, awaits a macrotask, then records its end. Under a serial lock the
  // trace must be paired (A-start, A-end, B-start, B-end), never interleaved.
  const trace: string[] = [];
  const body = (id: string) => async () => {
    trace.push(`${id}-start`);
    await new Promise((r) => setTimeout(r, 5));
    trace.push(`${id}-end`);
  };
  await Promise.all([withGitLock(body("A")), withGitLock(body("B"))]);
  // Whichever ran first, its start and end must be adjacent (not interleaved).
  const firstEnd = trace.indexOf(trace[0].replace("-start", "-end"));
  assert.equal(firstEnd, 1, `not interleaved: ${trace.join(",")}`);
  assert.equal(trace.length, 4);
});

test("withGitLock: a rejecting op does not wedge the queue for the next", async () => {
  const boom = withGitLock(async () => {
    throw new Error("boom");
  });
  await assert.rejects(boom, /boom/);
  // The next op must still run and succeed on the same chain.
  const ok = await withGitLock(async () => "ok");
  assert.equal(ok, "ok");
});

test("concurrent syncOnce: two overlapping syncs converge to a clean, consistent repo", async (t) => {
  const fx = await makeRemoteAndClone();
  t.after(fx.cleanup);
  process.env.OBSIDIAN_GIT_SYNC = "every-write";
  t.after(() => delete process.env.OBSIDIAN_GIT_SYNC);

  // Advance the remote from a second clone so the local sync has something to pull.
  const work2 = join(fx.base, "work2");
  await execFileAsync("git", ["clone", "-q", fx.remote, work2]);
  await g(work2, "config", "user.email", "t2@example.com");
  await g(work2, "config", "user.name", "T2");
  await writeFile(join(work2, "remote-add.md"), "# R\n");
  await g(work2, "add", "-A");
  await g(work2, "commit", "-q", "-m", "remote add");
  await g(work2, "push", "-q", "origin", "HEAD");

  // Local makes two commits, then fires TWO syncOnce concurrently. Without the
  // module-level lock these interleave (two pulls/merges/pushes racing on one
  // repo) and can wedge a merge or drop a commit; with it they serialize.
  await writeFile(join(fx.work, "local-a.md"), "# A\n");
  await g(fx.work, "add", "-A");
  await g(fx.work, "commit", "-q", "-m", "local a");
  await writeFile(join(fx.work, "local-b.md"), "# B\n");
  await g(fx.work, "add", "-A");
  await g(fx.work, "commit", "-q", "-m", "local b");

  const [r1, r2] = await Promise.all([syncOnce(fx.work), syncOnce(fx.work)]);
  assert.ok(r1.pushed && r2.pushed, "both syncs pushed");

  // Working tree is clean and no merge is wedged.
  const status = (await execFileAsync("git", ["-C", fx.work, "status", "--porcelain"])).stdout.trim();
  assert.equal(status, "", "clean tree, no wedged merge");
  await assert.rejects(
    () => execFileAsync("git", ["-C", fx.work, "rev-parse", "--verify", "MERGE_HEAD"]),
    "no in-progress merge remains"
  );

  // Local and remote HEAD agree — nothing lost. A fresh clone sees every commit.
  const verify = join(fx.base, "verify-concurrent");
  await execFileAsync("git", ["clone", "-q", fx.remote, verify]);
  const localHead = (await execFileAsync("git", ["-C", fx.work, "rev-parse", "HEAD"])).stdout.trim();
  const remoteHead = (await execFileAsync("git", ["-C", verify, "rev-parse", "HEAD"])).stdout.trim();
  assert.equal(localHead, remoteHead, "local and remote converged");
  // All three of the pulled-remote and both local files are present.
  for (const f of ["remote-add.md", "local-a.md", "local-b.md", "seed.md"]) {
    assert.equal((await readdir(verify)).includes(f), true, `remote has ${f}`);
  }
});

test("concurrent commitAfterWrite: two overlapping commits both land, tree clean", async (t) => {
  const fx = await makeRemoteAndClone();
  t.after(fx.cleanup);
  process.env.OBSIDIAN_GIT_SYNC = "commit";
  t.after(() => delete process.env.OBSIDIAN_GIT_SYNC);

  const before = Number(
    (await execFileAsync("git", ["-C", fx.work, "rev-list", "--count", "HEAD"])).stdout.trim()
  );
  // Two writers stage+commit their own file concurrently. `git add -A` in each
  // sees both files, but the serial lock guarantees each commit is atomic:
  // exactly two commits land and the tree ends clean (no "nothing to commit"
  // wedge, no both-files-in-one-commit race that loses a message).
  await writeFile(join(fx.work, "x.md"), "x\n");
  await writeFile(join(fx.work, "y.md"), "y\n");
  await Promise.all([
    commitAfterWrite(fx.work, "write_note: x"),
    commitAfterWrite(fx.work, "write_note: y"),
  ]);

  const after = Number(
    (await execFileAsync("git", ["-C", fx.work, "rev-list", "--count", "HEAD"])).stdout.trim()
  );
  // Both files land. Because `git add -A` is greedy, the first locked commit may
  // capture both files (2nd then finds nothing to commit) OR each captures one —
  // either way the net is one or two new commits and BOTH files are tracked with
  // a clean tree. The invariant that matters: no wedge, no lost data.
  assert.ok(after >= before + 1 && after <= before + 2, `commit count sane: ${before}->${after}`);
  const status = (await execFileAsync("git", ["-C", fx.work, "status", "--porcelain"])).stdout.trim();
  assert.equal(status, "", "clean tree after concurrent commits");
  const tracked = (await execFileAsync("git", ["-C", fx.work, "ls-files"])).stdout;
  assert.match(tracked, /x\.md/);
  assert.match(tracked, /y\.md/);
});

test("runSyncTick: records error (not throws) on a broken remote", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "gitsync-broken-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const work = join(base, "work");
  await execFileAsync("git", ["init", "-q", work]);
  await g(work, "config", "user.email", "t@x.com");
  await g(work, "config", "user.name", "T");
  await writeFile(join(work, "a.md"), "# A\n");
  await g(work, "add", "-A");
  await g(work, "commit", "-q", "-m", "a");
  await g(work, "remote", "add", "origin", join(base, "does-not-exist.git"));
  process.env.OBSIDIAN_GIT_SYNC = "timer";
  t.after(() => delete process.env.OBSIDIAN_GIT_SYNC);
  await runSyncTick(work); // must NOT throw
  assert.notEqual(getSyncState().last_error, null);
});
