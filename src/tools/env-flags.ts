import process from "node:process";

/** Values treated as "on" for a boolean environment flag. */
const TRUTHY = new Set(["1", "true", "yes", "on"]);

/** Whether the named environment variable is set to a truthy value. */
export function flagEnabled(name: string): boolean {
  const raw = process.env[name];
  return raw != null && TRUTHY.has(raw.trim().toLowerCase());
}

/** Snapshot the vault into a git commit before every write (see git-guard.ts). */
export const GIT_AUTOCOMMIT_ENV = "OBSIDIAN_GIT_AUTOCOMMIT";

/** Selector policy naming the tools the server exposes (see tool-policy.ts). */
export const TOOLS_ENV = "OBSIDIAN_TOOLS";

export function gitGuardEnabled(): boolean {
  return flagEnabled(GIT_AUTOCOMMIT_ENV);
}

export const GIT_SYNC_ENV = "OBSIDIAN_GIT_SYNC";
export const GIT_SYNC_INTERVAL_ENV = "OBSIDIAN_GIT_SYNC_INTERVAL";
export const GIT_REMOTE_ENV = "OBSIDIAN_GIT_REMOTE";

export type GitSyncMode = "off" | "commit" | "every-write" | "timer";

const GIT_SYNC_MODES: GitSyncMode[] = ["off", "commit", "every-write", "timer"];

/**
 * Resolve the active git-sync mode from the environment, applying the legacy
 * OBSIDIAN_GIT_AUTOCOMMIT migration (warn-and-map to "commit"). An explicit
 * OBSIDIAN_GIT_SYNC always wins; an unknown value fails loud. Returns a warning
 * string when the legacy flag was set (regardless of who won), else null.
 */
export function resolveGitSyncMode(
  env: NodeJS.ProcessEnv = process.env
): { mode: GitSyncMode; warning: string | null } {
  const legacyOn =
    env[GIT_AUTOCOMMIT_ENV] != null &&
    TRUTHY.has(env[GIT_AUTOCOMMIT_ENV]!.trim().toLowerCase());
  const warning = legacyOn
    ? `${GIT_AUTOCOMMIT_ENV} is deprecated; use ${GIT_SYNC_ENV}=commit (or every-write/timer). ` +
      `Mapping it to ${GIT_SYNC_ENV}=commit for now.`
    : null;

  const raw = env[GIT_SYNC_ENV]?.trim().toLowerCase();
  if (raw) {
    if (!(GIT_SYNC_MODES as string[]).includes(raw)) {
      throw new Error(
        `${GIT_SYNC_ENV} must be one of: ${GIT_SYNC_MODES.join(", ")} (got "${env[GIT_SYNC_ENV]}")`
      );
    }
    return { mode: raw as GitSyncMode, warning };
  }
  return { mode: legacyOn ? "commit" : "off", warning };
}

export function gitSyncInterval(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[GIT_SYNC_INTERVAL_ENV];
  const n = raw != null ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n)) return 300;
  return Math.max(1, n);
}

export function gitRemote(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env[GIT_REMOTE_ENV]?.trim();
  return raw && raw.length > 0 ? raw : "origin";
}
