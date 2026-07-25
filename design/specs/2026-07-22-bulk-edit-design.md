# Design: `bulk_edit` — query-driven bulk frontmatter mutations

**Date:** 2026-07-22
**Status:** Approved, pending implementation
**Branch:** `worktree-feat+bulk-edit`

## Problem

Frontmatter-only mutations are single-note today. "Tag these 30 notes" is 30
`add_tag` calls — 30 agent round trips and, when `OBSIDIAN_GIT_AUTOCOMMIT` is on,
30 auto-snapshot commits (each committing the *previous* call's uncommitted
write). The chattiest workflows are the frontmatter ones, and they are exactly
the deterministic, idempotent operations that batch cleanly.

## Goal

One additive MCP tool, `bulk_edit`, that applies one or more frontmatter
mutations to a set of notes selected either by explicit path list or by a
reusable filter — in a single call, under a single git snapshot, reporting
per-note results.

## Non-goals (YAGNI)

- Section/body bulk edits (only frontmatter ops are in scope).
- Bulk `write_note` / `delete_note` / `move_note`.
- Cross-note transactional rollback beyond the git snapshot.
- New selection logic — selection reuses the existing index and matchers.

## Architecture

Today every mutation funnels through `commitWrite` → `snapshotBeforeWrite`
(one git commit) → `writeResolved`. A batch must snapshot **once**, then write N
notes uncommitted. So the git guard is called explicitly by a batch runner
rather than per write.

- `snapshotBeforeWrite(vaultPath)` is unchanged; the batch runner calls it once
  at the top.
- A new `writeBatch` orchestrator (in `src/tools/write.ts`) resolves the
  selection, snapshots once, then for each note runs the
  read → parse-once → apply-all-ops → serialize → write pipeline **without**
  re-snapshotting, collecting per-note results.
- Per-note mutation reuses the existing `note-document.ts` primitives
  (`addTags`, `removeTags`, `setFrontmatter`, `addPropertyValues`,
  `removePropertyValues`, `renameProperty`) — no new mutation logic. Each note
  is parsed once, **all** operations in the `operations` array are applied to
  that single `NoteDocument`, then serialized and written once. So "add tag +
  set status" on one note = one read + one write, not two.
- The existing single-note tools are untouched; `bulk_edit` is purely additive.

## Tool contract

### Input

```
bulk_edit({
  select: {
    paths?: string[],           // explicit list, OR…
    where?: {…},                // query_notes-style frontmatter filter
    tags?: string[],            // find_by_tag-style
    match?: "all" | "any",      // for where/tags (default "all")
    folder?: string,            // optional scope (list_notes-style)
    limit?: number
  },
  operations: [                 // applied in order to each matched note
    { op: "add_tag", tags: [...] },
    { op: "remove_tag", tags: [...] },
    { op: "set_frontmatter", set?: {...}, unset?: [...] },
    { op: "add_property_values", key, values: [...] },
    { op: "remove_property_values", key, values: [...] },
    { op: "rename_property", from, to }
  ],
  dry_run?: boolean,            // default false
  expected_count?: number       // assert match count before writing
})
```

### Selection rules

- Exactly **one** of `paths` OR (`where` / `tags`) must be given. Mixing them
  errors loudly.
- `where` / `tags` / `folder` / `match` / `limit` resolve through the existing
  in-memory index and `property-match.ts`, the same machinery `query_notes`,
  `find_by_tag`, and `list_notes` use. No new selection logic.

### Safety guards

- **`dry_run: true`** → returns `{ matched, count, operations }` with **zero
  writes and no git snapshot**. The preview an agent runs to discover the match
  set before committing.
- **`expected_count`** → on a real run, if the resolved match count differs from
  `expected_count`, abort **before** any snapshot or write. Guards against a
  filter drifting between the agent's preview and its commit.

### Output (real run)

```
{
  matched_count, applied_count, failed_count,
  results: [
    { path, ok: true, changed: boolean }
    | { path, ok: false, error: string }
  ],
  dry_run: false
}
```

`changed: false` marks a note whose operations were all no-ops (e.g. a tag
already present), mirroring `editNote`'s existing no-change signal.

## Execution flow (`writeBatch`)

1. **Validate `operations`** up front — each entry has a known `op` type and its
   required args. Bad shape → abort, zero writes, zero snapshot.
2. **Resolve selection** via the index → matched path list.
3. **`expected_count` check** — if provided and ≠ match count, abort (no
   snapshot, no writes).
4. **`dry_run` short-circuit** — return the matched list; no snapshot, no writes.
5. **One `snapshotBeforeWrite(vaultPath)`** — the single batch snapshot.
   Fail-closed: if the guard is enabled but cannot snapshot, the whole batch
   aborts before any write (same guarantee as today, taken once).
6. **Per note**: read → parse once → apply all operations in order to the one
   `NoteDocument` → serialize → write once via `writeResolved` (**not**
   `commitWrite`, so no re-snapshot). Each note is wrapped in try/catch:
   - success → `{ path, ok: true, changed }`
   - throw (missing note, frontmatter validation failure, write error) →
     `{ path, ok: false, error }`, then **continue** to the next note.

### Error & git semantics

- **Frontmatter validation** (reject nested objects, non-scalar array elements,
  markdown in strings) runs per note inside the mutation primitives on the keys
  a given op touches. A note with a pre-existing violation on a touched key
  surfaces as that note's `ok: false` — it does not sink the batch.
- **Partial success + git**: the snapshot commits pre-existing state and leaves
  all batch writes uncommitted, so a partial batch still reviews as one clean
  diff and reverts wholesale via `git checkout` of the uncommitted changes. No
  half-committed state.

## Surface wiring

- **`src/index.ts`**: one new tool schema block + one `case "bulk_edit"`. Add
  `"bulk_edit"` to `WRITE_TOOL_NAMES` so it is gated by `OBSIDIAN_ALLOW_WRITES`
  like every other write tool.
- **`src/query-cli.ts`**: a `bulk-edit` subcommand for operator testing
  (`--select` / `--operations` JSON, `--dry-run`, `--expected-count`).

## Testing

- Multi-note apply writes each matched note.
- `dry_run` returns matches with zero writes (and no snapshot).
- `expected_count` mismatch aborts before any write.
- A per-note failure is isolated and reported; the rest of the batch proceeds.
- One-of selection rule: `paths` + filter together errors.
- Idempotent no-op → `changed: false`.
- A single git snapshot per batch, not per note (assert commit count).
- Operations applied in order (e.g. rename_property then set on the new key).

## Documentation

Update **both** `CLAUDE.md` and `README.md` (repo requires both kept in sync)
with a `bulk_edit` section and a CLI example.
