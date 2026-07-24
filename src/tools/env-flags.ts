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
