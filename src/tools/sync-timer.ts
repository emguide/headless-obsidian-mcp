import { resolveGitSyncMode, gitSyncInterval } from "./env-flags.js";
import { syncOnce } from "./git-sync.js";
import { recordSync } from "./sync-state.js";

/** One background sync tick: never throws; records the outcome. */
export async function runSyncTick(vaultPath: string): Promise<void> {
  try {
    await syncOnce(vaultPath);
    recordSync(true);
  } catch (error) {
    recordSync(false, error instanceof Error ? error.message : String(error));
  }
}

/**
 * Start the background pull/push interval when the mode is "timer". Returns a
 * stop function; a no-op when the mode is not "timer". `runOnce` is injectable
 * for tests (default performs a real tick).
 */
export function startSyncTimer(
  vaultPath: string,
  opts: { intervalMs?: number; runOnce?: () => Promise<void> } = {}
): () => void {
  if (resolveGitSyncMode().mode !== "timer") return () => {};
  const intervalMs = opts.intervalMs ?? gitSyncInterval() * 1000;
  const tick = opts.runOnce ?? (() => runSyncTick(vaultPath));
  const handle = setInterval(() => {
    void tick();
  }, intervalMs);
  // Don't keep the process alive solely for the timer.
  if (typeof handle.unref === "function") handle.unref();
  return () => clearInterval(handle);
}
