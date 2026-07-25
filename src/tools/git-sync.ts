import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
 * unreachable remote or a failed push throws. Conflict handling is added in
 * Task 3 — here a merge conflict aborts to a clean tree and throws.
 */
export async function syncOnce(vaultPath: string): Promise<SyncResult> {
  await assertRepoOrThrow(vaultPath);
  const remote = gitRemote();
  const branch = await currentBranch(vaultPath);

  let pulled = false;
  try {
    // --no-rebase forces a merge; --no-edit keeps the default merge message.
    await git(vaultPath, ["pull", "--no-rebase", "--no-edit", remote, branch]);
    pulled = true;
  } catch (error) {
    // Conflict? Abort to a clean tree, then throw (Task 3 replaces this branch).
    const merging = await isMerging(vaultPath);
    if (merging) {
      await git(vaultPath, ["merge", "--abort"]).catch(() => {});
      throw new Error(`Sync pull produced a merge conflict in ${vaultPath}`);
    }
    const m = error instanceof Error ? error.message : String(error);
    throw new Error(`${GIT_SYNC_ENV} pull failed (${m.trim()}).`);
  }

  let pushed = false;
  try {
    await git(vaultPath, ["push", remote, `HEAD:${branch}`]);
    pushed = true;
  } catch (error) {
    const m = error instanceof Error ? error.message : String(error);
    throw new Error(`${GIT_SYNC_ENV} push failed (${m.trim()}).`);
  }

  return { pulled, pushed, conflicts: [] };
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
