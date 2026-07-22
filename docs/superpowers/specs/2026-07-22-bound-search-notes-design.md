# Bound `search_notes` output

## Problem

`search_notes` (literal/regex ripgrep search) is unbounded. It has:

- no cap on the number of files returned,
- no cap on matches per file,
- a default of 5 context lines on each side of every match (11 lines/match).

One broad pattern over a large vault can return thousands of matches and flood
the agent's context window. `search_notes_ranked` already caps its output with
`limit`/`MAX_LIMIT`; the literal search — which can match far more — has no such
guard. This spec adds equivalent bounds.

## Goals

- Bound `search_notes` output so a single broad pattern cannot flood the context
  window.
- Signal to the agent when results were truncated, so a capped result is not
  mistaken for a complete answer.
- Keep the caps as *sensible defaults that prevent accidental floods*, not hard
  ceilings — the agent can always raise them or turn them off when it
  deliberately wants the full result.

## Non-goals

- Changing the ranking or matching semantics of `search_notes`.
- Killing the ripgrep process early / streaming optimization. The concern is
  context flooding, not CPU; a parse-time cap is sufficient and simpler.
- Changing the default `context_lines` (stays 5 — existing, documented behavior).
- Imposing a hard maximum. There is intentionally no `MAX_LIMIT` clamp: the caps
  exist to stop a broad pattern from *accidentally* flooding context, not to
  forbid a deliberate full search.

## Design

### New parameters

Two new optional caps on `SearchNotesParams`. Each has a **default** (bounds the
common case) and an **unlimited override**: pass `0` to disable that cap
entirely. Any positive integer is the cap; omitting the param uses the default.

| Param                  | Default | Range                | Purpose                              |
|------------------------|---------|----------------------|--------------------------------------|
| `limit`                | 20      | `0` = unlimited, else `>= 1` | Max number of files (result entries) |
| `max_matches_per_file` | 20      | `0` = unlimited, else `>= 1` | Cap matches within a single file     |
| `context_lines`        | 5       | 0–100 (unchanged)    | Unchanged                            |

Validation for each new cap: must be an integer `>= 0` (`0` means unlimited).
There is **no upper clamp** — a large value is honored. A negative or
non-integer value throws (e.g. `"limit must be a non-negative integer"`).

### Approach: parse-time cap

ripgrep runs as today (full `--json` output). The JSON parse loop enforces the
caps as it accumulates:

- Stop starting new file entries once `limit` files have been collected; count
  every additional distinct file seen into `files_omitted`. When `limit` is `0`,
  no file cap applies.
- Within a file, stop pushing matches once `max_matches_per_file` is reached;
  record the file's path in `matches_capped_in`. When `max_matches_per_file` is
  `0`, no per-file cap applies.

This is deterministic and easy to test, with no child-process management.

### Output shape (breaking change)

`searchNotes` returns a wrapper object instead of a bare `SearchResult[]`:

```jsonc
{
  "results": [ /* SearchResult[], <= limit entries, as today */ ],
  "truncated": true,               // true if any cap was hit
  "files_returned": 20,            // results.length
  "files_omitted": 137,            // distinct files seen beyond `limit`
  "matches_capped_in": ["a", "b"]  // files whose matches were truncated
}
```

When nothing is capped: `truncated: false`, `files_omitted: 0`,
`matches_capped_in: []`. An empty search returns `results: []` with those same
empty/false defaults.

## Files touched

- `src/types.ts` — add `limit`, `max_matches_per_file` to `SearchNotesParams`;
  add a `SearchNotesResponse` interface.
- `src/tools/search.ts` — validate new params; enforce caps in the parse loop;
  return the wrapper.
- `src/index.ts` — add `limit` and `max_matches_per_file` to the `search_notes`
  input schema (documenting `0` = unlimited) and update its description.
- `src/query-cli.ts` — add `-l, --limit` and `--max-matches` options to the
  `search` command (both accepting `0` for unlimited; the CLI JSON-prints the
  tool result, so the wrapper needs no special handling).
- `tests/search.test.ts` — **new** (TDD). See below.
- `CLAUDE.md` and `README.md` — document new params and output shape.

## Testing

New `tests/search.test.ts` over a temp vault fixture:

- Defaults: with more than 20 matching files, only 20 returned; `truncated` true;
  `files_omitted` reflects the remainder.
- `limit` honored above the default (e.g. `limit: 50` returns up to 50); no upper
  clamp.
- `limit: 0` disables the file cap — all matching files returned, `truncated`
  reflects only per-file capping.
- `max_matches_per_file`: a file with many matches is capped; its path appears in
  `matches_capped_in`. `max_matches_per_file: 0` returns all matches for a file.
- Invalid caps (negative, non-integer) throw.
- No truncation case: within-cap search returns `truncated: false`,
  `files_omitted: 0`, `matches_capped_in: []`.
- Empty result: no matches → empty `results`, all flags at their empty defaults.

## Rollout / compatibility

The output shape change is breaking for any direct programmatic consumer of
`searchNotes`. In-repo consumers: `src/index.ts` (JSON-stringifies the result —
works unchanged) and `src/query-cli.ts` via generic `queryTool` (JSON-prints —
works unchanged). Docs updated in the same change.
