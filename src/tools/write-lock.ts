/**
 * Per-vault serialization for the read-modify-write span.
 *
 * Git operations were already serialized by `withGitLock`, which makes the gap
 * easy to miss: the *snapshot* was atomic, the *file edit* was not. Two
 * concurrent tool calls (clients may pipeline requests, parallel subagents may
 * share one server, and the `timer` sync mode runs alongside writes) could both
 * read a note, both mutate their own copy, and both write — the second write
 * silently discarding the first's edit. Two `write_note` calls without
 * `overwrite` could likewise both pass the exists-check and the second clobber
 * the first, despite `overwrite:false` being documented as "refuses to clobber".
 *
 * The lock is per vault rather than per note: multi-file operations (move_note
 * rewriting backlinks, bulk_edit, rename_section rewriting anchors) span notes,
 * and mixing granularities invites lost updates at the seams. Contention is a
 * non-issue in practice — writes are already serialized behind the git lock
 * whenever sync is on, and a vault has one writer in the normal case.
 *
 * Reentrant by async context: a public operation may take the lock and still
 * call helpers that take it again (`editNote` inside `bulk_edit`, say) without
 * deadlocking.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { resolve } from "node:path";

/** Lock keys held by the current async context. */
const heldLocks = new AsyncLocalStorage<Set<string>>();

/** Tail of the waiter chain per vault. */
const chains = new Map<string, Promise<void>>();

/**
 * Run `fn` with exclusive access to `vaultPath`'s write path. Re-entering from
 * within a section that already holds the lock runs inline.
 */
export async function withVaultWriteLock<T>(
  vaultPath: string,
  fn: () => Promise<T>
): Promise<T> {
  const key = resolve(vaultPath);
  const held = heldLocks.getStore();
  if (held?.has(key)) return fn();

  const previous = chains.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => {
    release = r;
  });
  const tail = previous.then(() => mine);
  chains.set(key, tail);

  // Wait for the predecessor. Its rejection is its caller's problem, not ours.
  await previous.catch(() => {});

  const store = new Set(held ?? []);
  store.add(key);
  try {
    return await heldLocks.run(store, fn);
  } finally {
    release();
    // Drop the entry once we are the last waiter, so the map cannot grow
    // without bound across many vaults.
    if (chains.get(key) === tail) chains.delete(key);
  }
}
