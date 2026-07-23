# `list_notes` default limit + truncation signal

**Date:** 2026-07-22
**Status:** Approved, pending implementation

## Problem

`list_notes` is the orientation tool — the one an agent calls first to discover
what exists before searching or reading. It is the only listing tool with **no
default limit**: omitting `limit` returns every note header in the vault. On a
5,000-note vault, that first move is a five-figure-token dump.

Worse, when a result *is* capped (an explicit `limit` was passed), the caller
gets a bare `NoteHeader[]` with no signal that more notes existed. A truncated
list is indistinguishable from a complete one.

## Goal

1. Give `list_notes` a sensible default limit so the first move is bounded.
2. Emit a truncation signal so a capped result is never mistaken for complete.

Non-goals: no change to the `folder` filter, to `NoteHeader` contents, or to any
other listing tool. This is a scoped change to `list_notes` alone.

## Decision: return an envelope

`list_notes` currently returns a bare `NoteHeader[]`. `search_notes` already
solved this exact problem with a `{ results, truncated, files_returned, ... }`
envelope. We follow that established precedent — it is the only shape that can
carry a first-class truncation signal, and it keeps the two listing/search tools
consistent.

### New response type (`src/types.ts`)

```ts
/** The bounded result of `listNotes`, with truncation metadata. */
export interface ListNotesResponse {
  /** Matching note headers, at most `limit` entries (unless limit is 0). */
  notes: NoteHeader[];
  /** Notes matching the folder filter, before the limit was applied. */
  total: number;
  /** Number of notes in `notes` (== notes.length). */
  returned: number;
  /** True if the limit dropped notes (total > returned). */
  truncated: boolean;
}
```

`ListNotesParams` is unchanged (`folder?`, `limit?`).

## Behavior

- **Default limit: 100.** Applied when `limit` is omitted. Generous enough to
  orient on a mid-size vault in one call, ~50× smaller than a 5,000-note dump.
- **`limit: 0` → unbounded.** Matches `search_notes`' convention where `0` means
  "no cap". This is the escape hatch for a caller that genuinely wants every
  note. **This changes current behavior** — today `limit: 0` throws
  (`limit must be a positive integer`). After this change, `0` is the one
  special non-positive value that is accepted and means unbounded.
- **Validation otherwise unchanged.** Any `limit` that is not a non-negative
  integer (e.g. `-1`, `1.5`, `"x"`) still throws `limit must be a positive
  integer`. Only the `0` case moves from "throws" to "unbounded".
- **`folder` filter unchanged.** `total` counts notes *after* the folder filter
  and *before* the limit. `truncated` is `total > returned`.

### Behavior table

| Input               | Result                                            |
|---------------------|---------------------------------------------------|
| `{}` (no limit)     | up to 100 notes; `truncated` iff `total > 100`    |
| `{ limit: 25 }`     | up to 25 notes; `truncated` iff `total > 25`      |
| `{ limit: 0 }`      | all notes; `truncated: false`                     |
| `{ limit: -1 }`     | throws `limit must be a positive integer`         |
| `{ limit: 1.5 }`    | throws `limit must be a positive integer`         |
| `{ folder: "p" }`   | up to 100 notes under `p/`; `total` = count under `p/` |

## Files touched

- **`src/types.ts`** — add `ListNotesResponse`; leave `ListNotesParams` and
  `NoteHeader` as-is.
- **`src/tools/list.ts`** — accept `0` in validation; apply the `DEFAULT_LIMIT =
  100` when `limit` is omitted; compute `total`/`returned`/`truncated`; return
  the envelope instead of the bare array.
- **`src/index.ts`** — extend the `list_notes` tool `description` and its `limit`
  schema description to state the default (100) and the `0 = unbounded`
  convention. The `list_notes` case body already just `JSON.stringify`s whatever
  `listNotes` returns, so no handler-logic change.
- **`src/query-cli.ts`** — `list_notes` prints the result verbatim; confirm the
  envelope prints acceptably (it will — it is JSON-stringified like other tools).
  No unwrap needed for correctness; the CLI is an operator tool, not a consumer
  of `.notes`.
- **`tests/list.test.ts`** — update existing assertions to the envelope shape
  (`.notes`, `.total`, `.truncated`); update the `limit: 0` test from "rejects"
  to "returns all, untruncated"; add a default-limit test and a truncation test.
- **`tests/cache.test.ts`** — `listNotes(...)` result is now an envelope; the
  two call sites that read the result must read `.notes` (or `.total`).
- **`CLAUDE.md`** and **`README.md`** — update the `list_notes` section to
  document the default limit, the `0 = unbounded` convention, and the new
  `{ notes, total, returned, truncated }` output shape. (Both files must stay in
  sync per the repo's documentation rule.)

## Testing

TDD. New/updated cases in `tests/list.test.ts`:

1. **Default limit applies** — with a fixture of >100 notes (or a lowered
   constant via a large-enough fixture), an unlimited call returns exactly the
   default and reports `truncated: true`, `total` = full count. *(If building a
   >100-note fixture is heavy, assert the default by generating 101 notes; keep
   it in a dedicated test with its own fixture so the shared sample vault stays
   small.)*
2. **Truncation signal** — a small fixture with `limit` below `total` returns
   `truncated: true`, `returned < total`.
3. **No truncation** — `limit` ≥ `total` (or `limit: 0`) returns
   `truncated: false`, `returned === total`.
4. **`limit: 0` is unbounded** — returns every note, `truncated: false`
   (replaces the current "rejects a non-positive limit" test for the `0` case).
5. **Negative / non-integer limit still throws** — keep coverage that `-1` (and
   ideally `1.5`) still rejects.
6. **Envelope shape** — existing "lists every note", "title fallback",
   "headline", and "folder filter" tests updated to read `.notes`.

All 254 existing tests must still pass after the ripple (notably `cache.test.ts`).

## Out of scope

- No changes to `list_files`, `list_recent_notes`, `find_by_tag`, or other
  header-returning tools. They can adopt the same envelope later if desired;
  this spec deliberately touches only the first-move orientation tool.
- No pagination cursor / offset. A caller who needs more raises `limit` or passes
  `0`. Offset-based paging is a larger design and not needed to solve the
  token-blowup problem.
