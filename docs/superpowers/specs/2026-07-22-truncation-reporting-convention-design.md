# Vault-wide truncation-reporting convention

**Date:** 2026-07-22
**Status:** Design approved, pending implementation

## Problem

Truncation reporting is inconsistent across the tool surface. `search_notes`
returns `{ results, truncated, files_returned, files_omitted, matches_capped_in }`,
so an agent can tell a complete result from a capped one. Every other limited
tool — `list_notes`, `find_by_tag`, `query_notes`, `list_recent_notes`, and the
rest — returns a bare array and truncates **silently** via `limit`. An agent
receiving 12 rows cannot distinguish "12 results exist" from "12 of 400 shown".

The search response's self-describing shape deserves to be the vault-wide
convention.

## The convention

A single generic envelope wraps the row array, with field names aligned to
`search_notes`' vocabulary (`truncated` / `*_returned` / `*_omitted`):

```ts
export interface ListResponse<T> {
  results: T[];
  returned: number;   // results.length
  omitted: number;    // total - returned (0 when nothing was dropped)
  truncated: boolean; // omitted > 0
}
```

`search_notes` keeps its own richer shape
(`files_returned` / `files_omitted` / `matches_capped_in`) because it counts
files **and** per-file matches — a genuinely different quantity. The two shapes
are vocabulary-aligned without being forced into one type. No change to
`search_notes`.

### Semantics

- `total` = the length of the fully filtered result set **before** the `limit`
  slice.
- `returned` = `results.length` (post-slice).
- `omitted` = `total - returned` (always `>= 0`).
- `truncated` = `omitted > 0`.
- Empty result: `{ results: [], returned: 0, omitted: 0, truncated: false }`.

### Why it is cheap

Every affected tool is index-backed and already materializes the **full
filtered set in memory before slicing**. `total` is captured on the line before
the existing `.slice(0, limit)` — no extra vault scan, no extra cost. That is
what makes the convention affordable to apply everywhere rather than only where
`search_notes` already does.

## Scope

All list-style tools adopt the envelope, uniformly.

### Limit-accepting tools (can genuinely truncate)

- `list_notes`
- `find_by_tag`
- `query_notes`
- `list_recent_notes`
- `list_files`
- `search_notes_ranked`
- `get_related_notes`
- `get_property_values`
- `list_vault_issues`

For `get_related_notes`, `total` is the count of notes with a connecting signal
(the pool that scoring produced before the limit) — so `12 of 50 related` is
meaningful.

For `list_vault_issues`, the tool returns two different row shapes depending on
`kind` (`"orphans"` → note headers; `"unresolved_links"` → `{ source, targets }`
groups). The envelope wraps whichever row type applies; `total` is the count of
those rows/groups before `limit`. For `unresolved_links`, truncation is
measured in **groups** (source notes), not individual targets: `limit` caps how
many source notes appear and `total` is the group count. The per-target total
still equals `get_vault_stats`'s `unresolved_links` when unlimited.

### No-limit tools (wrapped for uniformity, always `truncated: false`)

- `list_tags`
- `list_properties`

These return the whole set and can never truncate, so they always report
`{ ..., omitted: 0, truncated: false }`. They are wrapped anyway so every
list-style tool has one predictable shape.

### Explicitly out of scope

- `search_notes` — keeps its existing, richer file/match-oriented shape.
- Single-object tools — `get_frontmatter`, `get_outline`, `read_section`,
  `get_property`, `get_vault_stats`. Nothing to truncate.
- `read_notes` — already returns `{ notes, errors }`; not a limited list.

## Blast radius

- **MCP layer (`src/index.ts`)** — each tool handler `JSON.stringify`s the
  tool's return value directly. The envelope flows through unchanged. **No
  handler edits.**
- **Query CLI (`src/query-cli.ts`)** — likewise `JSON.stringify`s the result
  (line 140). The envelope flows through unchanged. **No CLI edits.**
- **Types (`src/types.ts`)** — add `ListResponse<T>`; update the return type of
  each affected tool signature.
- **Tool functions** — each affected tool captures `total` before slicing and
  returns the envelope instead of the bare array.
- **Tests** — every assertion of the form `result.length` / `result[0]` /
  bare-array shape moves to `result.results`. This is the bulk of the mechanical
  work.
- **Docs** — `CLAUDE.md` and `README.md`: each affected tool's "Output" line
  changes from "Array of headers" to the envelope. Per the repo rule, both files
  are updated together.

## Breaking change

This is a **breaking API change** for every consumer of the ten wrapped tools:
their return shape changes from `T[]` to `{ results: T[], ... }`. This is
acceptable because the consumers are the in-repo MCP layer and query CLI (both
already forward the value verbatim) plus the test suite. There is no external
published contract to preserve. The change is stated plainly rather than
softened with a compatibility shim, which would defeat the point of a single
consistent shape.

## Error handling

- Invalid `limit` (non-integer or `< 1`) continues to `throw` exactly as today.
  Validation runs before slicing and is unchanged.
- No new error paths are introduced. An empty filtered set is not an error; it
  yields the empty-result envelope above.

## Testing approach

TDD, per tool. For each wrapped tool:

1. **Truncation case** — a `limit` smaller than the true result count yields
   `truncated: true` with correct `returned` and `omitted` (and
   `returned + omitted === total`).
2. **Complete case** — an unlimited or generously large call yields
   `truncated: false`, `omitted: 0`, and `returned === results.length`.

For the two no-limit tools (`list_tags`, `list_properties`): one test that a
normal call reports `truncated: false, omitted: 0`.

Existing tests that assert array shape are migrated to the `.results` path as
part of the same change (red → green per tool).

## Implementation notes

- Add `ListResponse<T>` to `src/types.ts` once; reuse across every tool.
- The transformation per tool is uniform: capture `const total = rows.length`
  before the slice, then
  `return { results: sliced, returned: sliced.length, omitted: total - sliced.length, truncated: total > sliced.length }`.
  Consider a tiny shared helper (e.g. `toListResponse(fullRows, limit)`) to keep
  the eleven call sites identical and avoid off-by-one drift.
- No-limit tools call the same helper with `limit` undefined, which yields
  `omitted: 0, truncated: false` naturally.
