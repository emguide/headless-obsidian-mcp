# Additive `offset` pagination for envelope-returning tools

**Date:** 2026-07-23
**Status:** approved

## Problem

Every list-style tool returns the `ListResponse<T>` truncation envelope
(`{ results, returned, omitted, truncated }`), which faithfully reports how many
rows were dropped by the `limit` — but offers no way to *fetch* those dropped
rows. The only recourse is re-running with a larger `limit`, re-paying tokens for
the rows already in hand.

`search_notes_ranked` is the worst case: a positive `limit` is hard-capped at
`MAX_LIMIT = 100`, so results 101–150 are reachable only via `limit: 0`
(everything) — there is no window into the middle of a large ranked result set.

An additive `offset` parameter completes the truncation convention: the envelope
already tells you rows were dropped; `offset` lets you skip forward to them.

## Design

### Envelope: add `skipped`, redefine `omitted`

`ListResponse<T>` gains one field and refines the meaning of another:

```ts
interface ListResponse<T> {
  results: T[];
  returned: number;   // results.length
  skipped: number;    // NEW — rows dropped BEFORE the window (== min(offset, total))
  omitted: number;    // REDEFINED — rows dropped AFTER the window only
  truncated: boolean;  // omitted > 0
}
```

- A window `[offset, offset + limit)` is sliced out of the fully-materialized
  `fullRows`.
- `skipped` = rows before the window (the effect of `offset`).
- `omitted` = rows after the window (the effect of `limit`).
- `total = skipped + returned + omitted` remains fully recoverable.
- **"Is there a next page?"** is exactly `truncated` (`omitted > 0`).

**Backward compatibility.** At `offset: 0` — today's only behavior — `skipped = 0`
and `omitted` = "everything not returned", byte-identical to today. The
redefinition of `omitted` only diverges once `offset > 0`, which is entirely new
surface, so no existing caller's reading of `omitted` breaks.

### The shared helper

All standard list tools funnel through `toListResponse`. It absorbs the offset:

```ts
export function toListResponse<T>(
  fullRows: T[],
  limit?: number,
  offset = 0
): ListResponse<T> {
  const skipped = Math.min(offset, fullRows.length);
  const afterSkip = fullRows.slice(skipped);
  const results = limit !== undefined ? afterSkip.slice(0, limit) : afterSkip;
  const omitted = afterSkip.length - results.length;
  return {
    results,
    returned: results.length,
    skipped,
    omitted,
    truncated: omitted > 0,
  };
}
```

Every standard tool threads its validated `offset` through to this call. No
per-tool slicing logic changes.

Tools covered by the shared helper: `list_notes`, `find_by_tag`,
`list_recent_notes`, `get_related_notes`, `list_files`, `list_folders`,
`list_vault_issues`, `query_notes`, `get_property_values`, `list_tags`,
`list_properties`. The last two have no `limit` but still accept `offset` (skip
the first N) so the envelope convention stays uniform.

### Validation & semantics

- `offset` reuses the `limit` validation shape: reject non-integer or `< 0`;
  error text **"offset must be a non-negative integer"**. Default `0`.
- An `offset` beyond the result set is **not an error** — it yields
  `results: []`, `skipped = total`, `omitted = 0`. (Same spirit as an over-large
  `limit` today.)
- `offset` composes with `limit: 0` (unbounded): skip N, return the rest.

### `search_notes_ranked` (special case — limit applied inside the index)

`index.searchRanked(query, limit, allowedIds)` gains an `offset` parameter.
BM25 already yields a fully-ranked hit list with a `total` count. The index
fetches `offset + limit` hits, then slices from `offset`:

- `MAX_LIMIT = 100` on `limit` **stays** — a single response is still ≤ 100 rows.
- `offset: 100, limit: 100` now returns ranked hits **101–200**, directly
  solving the stated worst case without the "re-fetch everything via `limit: 0`"
  penalty.
- The returned envelope carries `skipped` / redefined `omitted`, matching the
  standard shape (`skipped = min(offset, total)`, `omitted = total - skipped -
  returned`).

`bm25.search` currently returns `{ hits, total }` where `hits` is already capped
to the requested count. It gains an `offset` so it can drop the first `offset`
ranked hits before returning at most `limit` — `total` stays the full match
count.

### `search_notes` (special case — its own file-envelope)

`search_notes` keeps its richer, non-`ListResponse` shape. It gains a parallel
offset over **files**:

```ts
interface SearchNotesResponse {
  results: SearchResult[];
  truncated: boolean;
  files_returned: number;
  files_skipped: number;   // NEW — files dropped before the window (offset)
  files_omitted: number;   // files dropped after the window (limit)
  matches_capped_in: string[];
}
```

- `offset` skips whole *files* in the ripgrep stream before the file window
  begins; `files_skipped` counts them.
- `files_omitted` keeps its meaning ("distinct matching files beyond the window,
  not returned") — now measured after the offset window rather than from file 0.
- `truncated` becomes `files_omitted > 0 || matches_capped_in.length > 0`
  (unchanged form; `files_skipped` does not by itself set `truncated`, matching
  the envelope rule that skipping-forward is not truncation).
- Validation mirrors the others: `offset must be a non-negative integer`,
  default `0`.

### Surface to update

- `src/types.ts` — add `skipped` to `ListResponse`; `files_skipped` to
  `SearchNotesResponse`; `offset?: number` to every params interface
  (`ListNotesParams`, `ListFoldersParams`, `FindByTagParams`,
  `RelatedNotesParams`, `RecentNotesParams`, `RankedSearchParams`,
  `SearchNotesParams`, `ListVaultIssuesParams`, `QueryNotesParams`,
  `PropertyValuesParamsRead`, `ListPropertiesParams`, `ListFilesParams`).
- `src/tools/list-response.ts` — `offset` param on `toListResponse`.
- Each tool module — validate `offset`, thread it through.
- `src/tools/vault-index.ts` + `src/tools/text/bm25.ts` — `offset` on
  `searchRanked` / `search`.
- `src/tools/search.ts` — file-offset in the ripgrep-stream parser +
  `files_skipped`.
- `src/index.ts` — add `offset` to each envelope tool's MCP input schema.
- `src/query-cli.ts` — add `--offset` to each corresponding subcommand.
- Tests — cover offset windows, offset-past-end, offset + `limit: 0`,
  offset paging past the ranked cap, and `search_notes` file offset.
- `CLAUDE.md` + `README.md` — document `offset` and the `skipped` /
  `files_skipped` fields on every affected tool.

## Testing strategy

For a representative standard tool and each special case:

- `offset` in the middle of a result set returns the correct window and
  `skipped`/`omitted`/`truncated`.
- `offset` past the end → empty `results`, `skipped = total`, `omitted = 0`,
  `truncated = false`.
- `offset` with `limit: 0` → skip N, return the remainder unbounded.
- `search_notes_ranked`: `offset: 100, limit: 100` returns hits 101–200 (the
  worst-case scenario), with correct `skipped`/`omitted`.
- `search_notes`: `offset` skips files and populates `files_skipped`;
  `files_omitted` measured from the window.
- Invalid `offset` (negative, non-integer) rejected with the standard message.
- Regression: every existing envelope test still passes unchanged (offset
  defaults to 0 → identical output).

## Out of scope

- No cursor/opaque-token pagination — a numeric `offset` is sufficient and
  matches the existing numeric `limit`.
- No change to `limit` defaults or the `MAX_LIMIT = 100` cap on ranked search.
- No pagination for non-envelope tools (`read_notes`, `get_links`,
  `get_outline`, `get_frontmatter`, `get_vault_stats`, `resolve_note`, write
  tools) — they do not return list envelopes.
