# Scoped ranked search — design

**Date:** 2026-07-22
**Branch:** `feat/scoped-ranked-search`

## Problem

`search_notes_ranked` (BM25 relevance) accepts only `query` and `limit`. It cannot
be scoped to a subset of the vault, so the arguably-most-common ranked query —
*"the most relevant note about X **among my work notes**"* — is inexpressible.

`search_notes` already grew `folder` / `tags` / `where` / `match` filters
(commit `be988d0`) and the candidate-set machinery that resolves them against the
shared index. Ranked search should compose with the same machinery.

## Goal

1. Give `search_notes_ranked` the same `folder` / `tags` / `where` / `match`
   filters as `search_notes`, with identical names and semantics.
2. Extract the duplicated candidate-resolution logic (currently inline in both
   `search.ts` and `bulk.ts`) into one shared resolver.

Non-goal: changing BM25 ranking math, snippet behavior, or any observable
behavior of the existing tools when no filter is supplied.

## Design decisions

- **Filter cut happens *inside* BM25**, not after. `bm25.search()` gains an
  optional `allowedIds?: Set<string>`; it scores only docs in the set and then
  takes the top-N. This guarantees a *correct* top-N over the candidate set: a
  `limit=10` scoped query returns up to 10 in-scope results even when the
  globally-top hits are all out of scope. Filtering after scoring could
  under-return.
- **Filter surface mirrors `search_notes` exactly:** `folder`, `tags`, `where`,
  `match` — same names, same semantics, so an agent that knows one knows the
  other and the docs reuse the same descriptions.
- **Shared resolver, and migrate existing callers.** One definition of "scope a
  query to a candidate set," consumed by `search_notes`, `search_notes_ranked`,
  and `bulk_edit`.
- **Per-field match parameterization.** `search_notes` and `bulk_edit` apply
  `match` differently: in `search_notes`, `match` governs only `tags` and
  `where` is always evaluated as `"all"`; in `bulk_edit`, `match` governs both.
  The resolver takes `tagMatch` and `whereMatch` separately so every caller
  keeps its current behavior byte-for-byte. `search_notes`/`search_notes_ranked`
  pass `tagMatch = match, whereMatch = "all"`; `bulk_edit` passes
  `tagMatch = match, whereMatch = match`.

## Components

### 1. `src/tools/candidate-filter.ts` (new)

```ts
interface CandidateFilter {
  folder?: string;
  tags?: string[];
  where?: Record<string, Condition>;
  tagMatch?: "any" | "all";   // default "any"
  whereMatch?: "any" | "all"; // default "all"
}

// Validates the filter inputs with the same messages search_notes uses.
function validateCandidateFilter(f: {
  tags?: unknown; where?: unknown; match?: unknown;
}): void;

// Applies folder-prefix → tags → where filters over index entries.
function resolveCandidates(index: VaultIndex, f: CandidateFilter): IndexEntry[];
```

- `folder`: normalized to a `"<folder>/"` prefix; an entry matches when its
  `path` is under that prefix (same predicate as today: `(path + "/").startsWith(prefix)`).
- `tags`: leading `#` stripped, lowercased; `tagMatch` chooses `every`/`some`.
- `where`: `matchesWhere(entry.frontmatter, where, whereMatch)`.
- Returns the surviving entries (callers take `.path` or `.fullPath` as needed).

`validateCandidateFilter` centralizes the three checks currently inline in
`search.ts`: `tags` non-empty array, `where` is a plain object, `match` is
`"any"`/`"all"`.

### 2. `src/tools/text/bm25.ts`

```ts
search(queryTokens: string[], limit: number, allowedIds?: Set<string>): BM25Hit[]
```

When `allowedIds` is supplied, skip any `docId` not in the set while walking
postings (`if (allowedIds && !allowedIds.has(docId)) continue;`). Omitted →
unchanged behavior.

### 3. `src/tools/vault-index.ts`

`searchRanked(query, limit, allowedIds?)` threads `allowedIds` through to
`bm25.search`. When `allowedIds` is an empty set, short-circuit to `[]` before
calling BM25.

### 4. `src/tools/search-ranked.ts`

Accept `folder`, `tags`, `where`, `match` on `RankedSearchParams`. When any is
present:
1. `validateCandidateFilter({ tags, where, match })`.
2. `const entries = resolveCandidates(index, { folder, tags, where, tagMatch: match, whereMatch: "all" })`.
3. Zero entries → return `[]` (no BM25 call).
4. Else `index.searchRanked(query, limit, new Set(entries.map(e => e.path)))`.

`docId` in BM25 is `entry.path`, so the allowed-id set is built from `.path`.

### 5. `src/tools/search.ts` and `src/tools/bulk.ts` (migrate)

Replace the inline filter blocks with `validateCandidateFilter` +
`resolveCandidates`. `search.ts` passes `tagMatch = match, whereMatch = "all"`
and builds `candidatePaths` from `.fullPath` (it feeds ripgrep). `bulk.ts` passes
`tagMatch = match, whereMatch = match` and keeps its `paths`-vs-filter branching
and `limit` handling around the resolver call. No observable behavior change.

## Data flow (ranked, scoped)

```
params → validate query + filter
       → resolveCandidates(index, filter) → IndexEntry[]
       → allowedIds = Set(entries.map(e => e.path))
       → index.searchRanked(query, limit, allowedIds)
       → bm25.search(tokens, limit, allowedIds)   // scores only candidates
       → per-hit snippet read → RankedSearchResult[]
```

## Error handling

- Filter validation reuses `search_notes`' messages verbatim
  (`tags must be a non-empty array when provided`,
  `where must be an object of property conditions`,
  `match must be "any" or "all"`).
- Zero candidates → `[]`, BM25 never invoked.
- No filter → identical to today's ranked search (regression-guarded).
- Existing `query`/`limit` validation is unchanged.

## Types

`RankedSearchParams` gains optional `folder?: string`, `tags?: string[]`,
`where?: Record<string, Condition>`, `match?: "any" | "all"`.

## Testing

- **Scoped by `folder`** → only in-folder notes, correctly ranked.
- **Scoped by `tags`** (`any` and `all`) → only tag-matching notes.
- **Scoped by `where`** → only frontmatter-matching notes.
- **Correct top-N**: a query whose globally-top hits are out of scope still
  returns up to `limit` in-scope results — proves filtering happens inside BM25.
- **Zero-match filter** → `[]`.
- **No-filter ranked search unchanged** (regression).
- **`resolveCandidates` unit tests**: each field independently, plus `tagMatch`
  vs `whereMatch` combinations.
- **Migration regression**: existing `search_notes` and `bulk_edit` suites stay
  green (proves no behavior change from the extraction).

## Docs

- Update the `search_notes_ranked` section in **CLAUDE.md** and **README.md**
  with the new inputs.
- Add a `search-ranked` CLI example using `--folder` / `--tag` / `--where`
  (and wire those flags in the query CLI if not already present).
