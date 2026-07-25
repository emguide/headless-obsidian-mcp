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

/** Run a git subcommand inside the vault directory. */
export async function git(vaultPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", vaultPath, ...args]);
  return stdout;
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
 */
export async function commitAfterWrite(
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
 * Pull (merge) from the remote then push local commits. Fail-closed: an
 * unreachable remote or a failed push throws. Resolves merge conflicts
 * non-destructively: keeps local version as a (conflicted …) copy, takes
 * remote as canonical.
 */
export async function syncOnce(
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
    // Non-destructive resolution: for each conflicted file, keep the LOCAL
    // version aside as a (conflicted …) copy, then take REMOTE (theirs) as
    // canonical. Conflict copies are terminal artifacts — a conflict on one
    // never produces a copy-of-a-copy because the ORIGINAL path is copied,
    // never the copy itself (git only reports the real path as conflicted).
    const now = opts.now ?? new Date();
    const stamp = conflictStamp(now);
    const conflicted = (
      await git(vaultPath, ["diff", "--name-only", "--diff-filter=U"])
    )
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

    for (const rel of conflicted) {
      const canonical = rel.replace(/\.md$/, "");
      // Local (ours) content is at the ":2:" stage; write it aside.
      const localContent = await git(vaultPath, ["show", `:2:${rel}`]).catch(() => "");
      const copyRel = `${conflictCopyName(canonical, stamp)}.md`;
      await writeFile(join(vaultPath, copyRel), localContent, "utf-8");
      // Take remote (theirs) for the canonical path.
      await git(vaultPath, ["checkout", "--theirs", "--", rel]);
      await git(vaultPath, ["add", "--", rel, copyRel]);
      conflicts.push(conflictCopyName(canonical, stamp));
    }
    // Complete the merge commit (records both the resolved file and the copies).
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

/** True when a merge is in progress (MERGE_HEAD exists). */
async function isMerging(vaultPath: string): Promise<boolean> {
  try {
    await git(vaultPath, ["rev-parse", "--verify", "MERGE_HEAD"]);
    return true;
  } catch {
    return false;
  }
}

/** The every-write remote leg: pull + push around an already-made commit. */
export async function pushAfterWrite(vaultPath: string): Promise<void> {
  await syncOnce(vaultPath);
}
