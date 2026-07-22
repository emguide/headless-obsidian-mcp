import { execFile } from "node:child_process";
import { promisify } from "node:util";
import process from "node:process";

const execFileAsync = promisify(execFile);

/** Environment variable that turns the pre-write git snapshot on. */
export const GIT_AUTOCOMMIT_ENV = "OBSIDIAN_GIT_AUTOCOMMIT";

const TRUTHY = new Set(["1", "true", "yes", "on"]);

/**
 * Whether the git guard is enabled. When on, every mutation is preceded by a
 * commit of the vault's current state (see {@link snapshotBeforeWrite}).
 */
export function gitGuardEnabled(): boolean {
  const raw = process.env[GIT_AUTOCOMMIT_ENV];
  return raw != null && TRUTHY.has(raw.trim().toLowerCase());
}

/** Run a git subcommand inside the vault directory. */
async function git(vaultPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", vaultPath, ...args]);
  return stdout;
}

/**
 * Snapshot the vault's current state into a git commit before a write mutates
 * it, so the agent's change lands as an isolated, revertible diff.
 *
 * Only runs when {@link gitGuardEnabled} is true. It is **fail-closed**: if the
 * flag is on but the snapshot cannot be taken (git missing, vault not a repo,
 * or the commit fails) the returned promise rejects and the caller must abort
 * the write, so the safety guarantee is never silently void. A clean working
 * tree is not an error — there is simply nothing to snapshot.
 */
export async function snapshotBeforeWrite(vaultPath: string): Promise<void> {
  if (!gitGuardEnabled()) return;

  // Confirm git is available and the vault is a work tree (fail-closed).
  try {
    await git(vaultPath, ["rev-parse", "--is-inside-work-tree"]);
  } catch (error) {
    const reason =
      error instanceof Error && "code" in error && error.code === "ENOENT"
        ? "git executable was not found"
        : `'${vaultPath}' is not a git repository`;
    throw new Error(
      `${GIT_AUTOCOMMIT_ENV} is enabled but ${reason}. ` +
        `Refusing to write without a snapshot commit.`
    );
  }

  // Nothing staged or unstaged means the pre-write state is already committed.
  const status = await git(vaultPath, ["status", "--porcelain"]);
  if (status.trim() === "") return;

  try {
    await git(vaultPath, ["add", "-A"]);
    await git(vaultPath, [
      "commit",
      "--no-verify",
      "-m",
      "notes-mcp: auto-snapshot before write",
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${GIT_AUTOCOMMIT_ENV} is enabled but the snapshot commit failed ` +
        `(${message.trim()}). Refusing to write without a snapshot commit.`
    );
  }
}
