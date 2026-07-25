/** Process-wide last-sync observability, written by the background timer. */
let lastSync: string | null = null;
let lastError: string | null = null;

export function getSyncState(): { last_sync: string | null; last_error: string | null } {
  return { last_sync: lastSync, last_error: lastError };
}

/** Record the outcome of a sync attempt (timer or explicit). */
export function recordSync(ok: boolean, error?: string): void {
  const stamp = new Date().toISOString();
  if (ok) {
    lastSync = stamp;
    lastError = null;
  } else {
    lastError = error ?? "unknown sync error";
  }
}
