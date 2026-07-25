import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  GIT_SYNC_ENV,
  resolveGitSyncMode,
  gitRemote,
} from "./env-flags.js";

const execFileAsync = promisify(execFile);

export interface SyncResult {
  pulled: boolean;
  pushed: boolean;
  conflicts: string[];
}

/* --------------------------------------------------------------- git lock -- */

/**
 * A single in-process serialization point for every git-mutating sequence.
 * MCP handlers run concurrently and, in `timer` mode, a background `syncOnce`
 * can interleave with an inline write's commit. Two overlapping git sequences
 * against the same repo can make git consume an in-progress merge into the
 * wrong commit, mislabel history, and break the fail-closed contract. We chain
 * every public entry point on a module-level promise so their git work runs
 * strictly one-at-a-time, process-wide.
 *
 * The lock is NOT re-entrant: only the public API boundary
 * ({@link commitAfterWrite}, {@link syncOnce}, {@link pushAfterWrite}, and the
 * combined {@link commitAndSync}) acquires it. Everything they call internally
 * uses unlocked `*Unlocked` helpers, so nothing re-acquires from within a held
 * lock (which would deadlock). The chain never rejects — each link swallows the
 * settled outcome of the previous one — so one failing op cannot wedge the
 * queue for the next.
 */
let gitLockTail: Promise<unknown> = Promise.resolve();

export async function withGitLock<T>(fn: () => Promise<T>): Promise<T> {
  // Wait for the current tail to settle (success OR failure) before running,
  // then become the new tail. Callers still see their own fn's rejection.
  const run = gitLockTail.then(fn, fn);
  // The tail must not reject, or the next waiter's `.then(fn, fn)` would run
  // fn as the rejection handler AND we'd surface an unhandled rejection.
  gitLockTail = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/** `<canonical> (conflicted <stamp>)` — no .md suffix. */
export function conflictCopyName(canonical: string, stamp: string): string {
  return `${canonical} (conflicted ${stamp})`;
}

const CONFLICT_SUFFIX = / \(conflicted (\d{4}-\d{2}-\d{2} \d{6})\)$/;

/** True iff a note path (no .md) is a conflict copy. */
export function isConflictCopy(path: string): boolean {
  return CONFLICT_SUFFIX.test(path);
}

/** Inverse of conflictCopyName; null when the path is not a conflict copy. */
export function parseConflictCopy(
  path: string
): { original: string; stamp: string } | null {
  const m = path.match(CONFLICT_SUFFIX);
  if (!m) return null;
  return { original: path.slice(0, m.index), stamp: m[1] };
}

/** HHMMSS-stamped conflict timestamp; deterministic when `now` is injected. */
function conflictStamp(now: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${now.getUTCFullYear()}-${p(now.getUTCMonth() + 1)}-${p(now.getUTCDate())} ` +
    `${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`
  );
}

/**
 * Split a vault-relative path into `{ stem, ext }` where `ext` includes the
 * leading dot (or is empty). Used to build a conflict-copy name that preserves
 * the real extension: `image.png` → copy `image (conflicted …).png`, while a
 * note `foo.md` → `foo (conflicted …).md`. A path with no dot in its basename
 * (e.g. `LICENSE`) keeps an empty ext.
 */
function splitExt(rel: string): { stem: string; ext: string } {
  const slash = rel.lastIndexOf("/");
  const dot = rel.lastIndexOf(".");
  // A dot only counts as an extension when it is in the basename (after the
  // last slash) and not the first char of the basename (dotfile like `.env`).
  if (dot > slash + 1) return { stem: rel.slice(0, dot), ext: rel.slice(dot) };
  return { stem: rel, ext: "" };
}

/** Run a git subcommand inside the vault directory (stdout as UTF-8 text). */
export async function git(vaultPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", vaultPath, ...args]);
  return stdout;
}

/**
 * Run a git subcommand and capture stdout as a raw Buffer (no UTF-8 decode),
 * so binary blobs (e.g. `git show :2:<image.png>`) survive byte-for-byte. A
 * UTF-8 string round-trip corrupts every byte ≥0x80 to U+FFFD, destroying the
 * very local data a conflict copy exists to preserve.
 */
export async function gitBuffer(vaultPath: string, args: string[]): Promise<Buffer> {
  const { stdout } = await execFileAsync("git", ["-C", vaultPath, ...args], {
    encoding: "buffer",
    // A large note/attachment blob can exceed the default 1MB stdout cap.
    maxBuffer: 512 * 1024 * 1024,
  });
  return stdout as unknown as Buffer;
}

export async function isGitRepo(vaultPath: string): Promise<boolean> {
  try {
    await git(vaultPath, ["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

/** Fail-closed guard: enabled but no usable repo → throw a clear reason. */
async function assertRepoOrThrow(vaultPath: string): Promise<void> {
  try {
    await git(vaultPath, ["rev-parse", "--is-inside-work-tree"]);
  } catch (error) {
    const reason =
      error instanceof Error && "code" in error && (error as { code?: string }).code === "ENOENT"
        ? "git executable was not found"
        : `'${vaultPath}' is not a git repository`;
    throw new Error(
      `${GIT_SYNC_ENV} is enabled but ${reason}. Refusing to write without a commit.`
    );
  }
}

/**
 * Commit the just-written change with a tool-derived message. No-op when the
 * mode is "off". Fail-closed when enabled but the repo is unusable. A clean
 * index (nothing staged, e.g. a no-op write) simply makes no commit.
 *
 * Public entry point: acquires the git lock so it never interleaves with a
 * concurrent {@link syncOnce} / {@link pushAfterWrite} / another commit.
 */
export async function commitAfterWrite(
  vaultPath: string,
  message: string
): Promise<void> {
  return withGitLock(() => commitAfterWriteUnlocked(vaultPath, message));
}

/** {@link commitAfterWrite} without acquiring the lock (caller must hold it). */
async function commitAfterWriteUnlocked(
  vaultPath: string,
  message: string
): Promise<void> {
  const { mode } = resolveGitSyncMode();
  if (mode === "off") return;
  await assertRepoOrThrow(vaultPath);
  await git(vaultPath, ["add", "-A"]);
  const status = await git(vaultPath, ["status", "--porcelain"]);
  if (status.trim() === "") return; // nothing to commit
  try {
    await git(vaultPath, ["commit", "--no-verify", "-m", message]);
  } catch (error) {
    const m = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${GIT_SYNC_ENV} is enabled but the commit failed (${m.trim()}). Refusing to write without a commit.`
    );
  }
}

/** Current branch name (for explicit push refspec). */
async function currentBranch(vaultPath: string): Promise<string> {
  return (await git(vaultPath, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
}

/**
 * Check if a specific stage exists for a file in a merge conflict.
 *
 * Uses `cat-file -e`, which reports existence via exit status without writing
 * the blob to stdout. `git show` would stream the whole object through the
 * UTF-8 `git()` helper and blow its 1MB maxBuffer on any larger note or
 * attachment; the resulting throw was indistinguishable from "stage absent",
 * so a both-modified conflict on a >1MB file fell through to the unclassified
 * branch and deleted the canonical path.
 */
async function checkStageExists(
  vaultPath: string,
  rel: string,
  stage: "2" | "3"
): Promise<boolean> {
  try {
    await git(vaultPath, ["cat-file", "-e", `:${stage}:${rel}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pull (merge) from the remote then push local commits. Fail-closed: an
 * unreachable remote or a failed push throws. Resolves merge conflicts
 * non-destructively: keeps local version as a (conflicted …) copy, takes
 * remote as canonical.
 *
 * Public entry point: acquires the git lock for the whole pull→resolve→push
 * sequence, so a background timer tick and an inline write can never drive two
 * merges into the same repo at once.
 */
export async function syncOnce(
  vaultPath: string,
  opts: { now?: Date } = {}
): Promise<SyncResult> {
  return withGitLock(() => syncOnceUnlocked(vaultPath, opts));
}

/** {@link syncOnce} without acquiring the lock (caller must hold it). */
async function syncOnceUnlocked(
  vaultPath: string,
  opts: { now?: Date } = {}
): Promise<SyncResult> {
  await assertRepoOrThrow(vaultPath);
  const remote = gitRemote();
  const branch = await currentBranch(vaultPath);
  const conflicts: string[] = [];

  let pulled = false;
  try {
    await git(vaultPath, ["pull", "--no-rebase", "--no-edit", remote, branch]);
    pulled = true;
  } catch (error) {
    if (!(await isMerging(vaultPath))) {
      const m = error instanceof Error ? error.message : String(error);
      throw new Error(`${GIT_SYNC_ENV} pull failed (${m.trim()}).`);
    }
    // Non-destructive resolution: for each conflicted file, determine which
    // stages exist and resolve accordingly to keep both versions without
    // wedging the merge. Conflict copies are terminal artifacts — a conflict
    // on one never produces a copy-of-a-copy because the ORIGINAL path is
    // copied, never the copy itself (git only reports the real path as conflicted).
    const now = opts.now ?? new Date();
    const stamp = conflictStamp(now);
    const conflicted = (
      await git(vaultPath, ["diff", "--name-only", "--diff-filter=U"])
    )
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

    for (const rel of conflicted) {
      // Detect which stages exist (2=local/ours, 3=remote/theirs).
      const stage2Exists = await checkStageExists(vaultPath, rel, "2");
      const stage3Exists = await checkStageExists(vaultPath, rel, "3");

      if (stage2Exists && stage3Exists) {
        // Both modified: keep local as copy, take remote for canonical.
        const copyRel = conflictCopyRel(rel, stamp);
        await writeLocalStageCopy(vaultPath, rel, copyRel);
        await git(vaultPath, ["checkout", "--theirs", "--", rel]);
        await git(vaultPath, ["add", "--", rel, copyRel]);
        conflicts.push(conflictReported(rel, stamp));
      } else if (stage2Exists && !stage3Exists) {
        // Remote deleted, local modified: preserve local in copy, delete canonical.
        const copyRel = conflictCopyRel(rel, stamp);
        await writeLocalStageCopy(vaultPath, rel, copyRel);
        await git(vaultPath, ["rm", "--", rel]);
        await git(vaultPath, ["add", "--", copyRel]);
        conflicts.push(conflictReported(rel, stamp));
      } else if (!stage2Exists && stage3Exists) {
        // Local deleted, remote modified: take remote for canonical, no copy.
        await git(vaultPath, ["checkout", "--theirs", "--", rel]);
        await git(vaultPath, ["add", "--", rel]);
        // No conflict copy: nothing local to preserve.
      } else {
        // Fallback for any conflict git reports that fits none of the three
        // stage patterns above (e.g. rename/rename, add/add, or an unexpected
        // stage combo). Without this branch the path would be left UNMERGED and
        // the merge-completing `git commit --no-edit` below would fail and wedge
        // the repo. Safe default that ALWAYS resolves: preserve any local
        // content as a conflict copy, then take theirs when a remote side
        // exists, else drop the path. Either way the path ends merged.
        const local = await tryReadStage(vaultPath, rel, "2");
        if (local != null) {
          const copyRel = conflictCopyRel(rel, stamp);
          await writeFile(join(vaultPath, copyRel), local);
          await git(vaultPath, ["add", "--", copyRel]);
          conflicts.push(conflictReported(rel, stamp));
        }
        if (stage3Exists) {
          await git(vaultPath, ["checkout", "--theirs", "--", rel]);
          await git(vaultPath, ["add", "--", rel]);
        } else {
          // No remote side to take; ensure the path is no longer unmerged.
          await git(vaultPath, ["rm", "-f", "--", rel]);
        }
      }
    }
    // Complete the merge commit (records resolved files and any copies).
    await git(vaultPath, ["commit", "--no-verify", "--no-edit"]);
    pulled = true;
  }

  let pushed = false;
  try {
    await git(vaultPath, ["push", remote, `HEAD:${branch}`]);
    pushed = true;
  } catch (error) {
    const m = error instanceof Error ? error.message : String(error);
    throw new Error(`${GIT_SYNC_ENV} push failed (${m.trim()}).`);
  }

  return { pulled, pushed, conflicts };
}

/**
 * The vault-relative path of the conflict copy for a conflicted file `rel`,
 * preserving its real extension. `.md` notes keep the historical
 * `<note> (conflicted …).md` shape; a non-md file keeps its own extension
 * (`image.png` → `image (conflicted …).png`), so a binary attachment's copy is
 * not mis-named `.md` and parsed as a broken note.
 */
function conflictCopyRel(rel: string, stamp: string): string {
  const { stem, ext } = splitExt(rel);
  return `${conflictCopyName(stem, stamp)}${ext}`;
}

/**
 * The value reported in {@link SyncResult.conflicts} for a conflicted file.
 * For a `.md` note this is the note-path form (no extension), matching the rest
 * of the tool surface and the `parseConflictCopy` round-trip. For a non-md file
 * we report the vault-relative COPY PATH WITH extension, because there is no
 * "note path" identity to strip to — the reader needs the real on-disk path.
 */
function conflictReported(rel: string, stamp: string): string {
  const { stem, ext } = splitExt(rel);
  if (ext === ".md") return conflictCopyName(stem, stamp);
  return conflictCopyRel(rel, stamp);
}

/**
 * Read the local (stage 2) blob of a conflicted file as raw bytes and write it
 * to `copyRel` byte-for-byte. Reading via {@link gitBuffer} (not the UTF-8
 * `git` helper) is what keeps a binary attachment's high bytes intact.
 */
async function writeLocalStageCopy(
  vaultPath: string,
  rel: string,
  copyRel: string
): Promise<void> {
  const buf = await gitBuffer(vaultPath, ["show", `:2:${rel}`]);
  await writeFile(join(vaultPath, copyRel), buf);
}

/** Read a conflict stage as raw bytes, or null when that stage does not exist. */
async function tryReadStage(
  vaultPath: string,
  rel: string,
  stage: "2" | "3"
): Promise<Buffer | null> {
  try {
    return await gitBuffer(vaultPath, ["show", `:${stage}:${rel}`]);
  } catch {
    return null;
  }
}

/** True when a merge is in progress (MERGE_HEAD exists). */
async function isMerging(vaultPath: string): Promise<boolean> {
  try {
    await git(vaultPath, ["rev-parse", "--verify", "MERGE_HEAD"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * The every-write remote leg: pull + push around an already-made commit.
 * Public entry point — acquires the git lock (delegates to the unlocked sync).
 */
export async function pushAfterWrite(vaultPath: string): Promise<void> {
  await withGitLock(() => syncOnceUnlocked(vaultPath));
}

/**
 * Combined commit-then-sync under a SINGLE held lock, so a write's commit and
 * its subsequent pull/push are atomic with respect to a background timer tick
 * (or another write). If `commitAfterWrite` and `pushAfterWrite` each locked
 * independently, a timer `syncOnce` could acquire the lock in the gap between
 * them — pushing the write's commit or driving a merge before the write's own
 * push. Holding the lock across both closes that window. Used by the
 * every-write funnel (write.ts `afterWrite`).
 */
export async function commitAndSync(
  vaultPath: string,
  message: string
): Promise<void> {
  await withGitLock(async () => {
    await commitAfterWriteUnlocked(vaultPath, message);
    await syncOnceUnlocked(vaultPath);
  });
}
