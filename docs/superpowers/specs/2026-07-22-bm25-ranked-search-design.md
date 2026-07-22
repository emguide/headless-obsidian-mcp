# BM25 ranked search — design

**Date:** 2026-07-22
**Status:** Approved, ready for implementation planning

## Goal

Add relevance-ranked full-text search to the vault, complementing (not replacing)
the existing regex/substring `search_notes` tool. Inspired by
[bitbonsai/mcpvault](https://github.com/bitbonsai/mcpvault)'s BM25 search, but
built on this project's persistent, incrementally-refreshed `VaultIndex` instead
of re-scanning the whole vault on every query.

## Motivation

The current `search_notes` shells out to `ripgrep`: fast literal/regex matching
with no notion of relevance. An agent asking "which notes are *most about*
kubernetes networking" gets an unordered list of every line that mentions any of
those words. BM25 ranks whole notes by how well they match a multi-word query,
so the most relevant notes come first.

mcpvault re-reads and re-tokenizes the entire vault on every search (O(vault) per
query). This project already maintains a `VaultIndex` that parses each note once
and refreshes only files whose size/mtime changed. Building the BM25 index there
means queries are map lookups, and re-indexing touches only changed notes.

## Decisions (from brainstorming)

| Decision | Choice |
|----------|--------|
| Tool shape | **New separate tool** `search_notes_ranked`; leave `search_notes` (ripgrep) untouched. |
| Index storage | **In-memory, on `VaultIndex`**, reusing its incremental refresh. No new deps, no disk. |
| Tokenization | Lowercase + split + small stopword list + **light Porter stemming** (pure-JS, no dependency). |
| Index scope | **Body + title + headings + tags** (frontmatter otherwise excluded, matching `read_notes`). |
| Field boost | **Boost title/headings/tags** via token duplication (×2), scored as one BM25 value. |
| Snippet source | **Read top-N result files at query time** (N = limit); do not store body previews in the index. |

## Architecture

### New module: `src/tools/text/tokenize.ts`

```
tokenize(text: string): string[]
```

- Lowercase the input.
- Split on runs of non-word characters (keep `[a-z0-9]`).
- Drop tokens in a small built-in stopword set (the, a, an, of, to, and, …).
- Stem each remaining token with a self-contained pure-JS **Porter stemmer**
  (`stem(word: string): string`, also in this module or a sibling file).
- Return the resulting token array (may contain duplicates — callers count them).

The **same** `tokenize` is used to index documents and to parse queries, so the
two token streams are normalized identically. This is the single source of truth
for text normalization.

### New module: `src/tools/text/bm25.ts`

A pure, filesystem-agnostic ranking structure.

```
class BM25 {
  add(docId: string, tokens: string[]): void   // called during index build
  finalize(): void                              // compute avgdl, freeze df/N
  search(queryTokens: string[], limit: number): { docId: string; score: number }[]
}
```

- Stored state: per-doc term-frequency map, per-doc length, global document
  frequency per term, total doc count, average doc length.
- Constants: `k1 = 1.2`, `b = 0.75` (standard defaults).
- IDF: `Math.log(1 + (N - df + 0.5) / (df + 0.5))`.
- Score per doc: `Σ_term idf(term) * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (docLen / avgdl)))`.
- `search` scores **only** docs that contain ≥1 query term (walk the query
  terms' postings, accumulate per-doc scores), sorts by score descending, breaks
  ties by `docId` ascending for determinism, and returns the top `limit`.
- Empty query or no matches → `[]`.

The BM25 instance is rebuilt from cached per-note token data on each refresh; it
holds no raw text.

### Changes to `src/tools/vault-index.ts`

- `IndexEntry` gains `tokens: string[]` — the indexed token stream produced in
  `buildEntry` (BM25 counts term frequencies from it at `add` time). Stored
  instead of raw body text, preserving the index's memory-light property.
- `buildEntry` builds the token stream from:
  - the parsed body (`parsed.content`), tokenized;
  - plus **title, each heading, and each tag** tokenized and appended an extra
    time (×2 total) to implement the field boost via duplication.
  - (Headings: extract all markdown headings from the body, not just the first;
    `firstHeading` currently returns only the first — add a `headings()` helper
    or inline extraction. Reuse existing `collectTags` for tags.)
- After `refresh()`, `rebuildDerived()` also constructs a fresh `BM25` instance:
  for each entry, `bm25.add(entry.path, entry.tokens)`, then `finalize()`.
  Unchanged entries are not re-tokenized (their cached tokens are reused); only
  the BM25 aggregate is recomputed, which is cheap.
- New method:
  ```
  searchRanked(query: string, limit: number): RankedSearchResult[]
  ```
  Tokenizes the query, runs `bm25.search`, maps each `docId` back to its
  `IndexEntry`, reads the top-N winning files to build snippets, and returns
  header + score + snippet objects.

### Snippet generation

At query time only, for the ≤ `limit` winning notes:
- Read the file, strip frontmatter (via `gray-matter`), find the first line/region
  containing a raw (case-insensitive) query word, and return a short excerpt
  (a line or a bounded character window) as `snippet`.
- Best-effort: if no literal query word is found (e.g. match was via stemming),
  fall back to the note's first non-empty body line. Never throw on snippet
  failure — return an empty/opening snippet instead.

### New tool: `search_notes_ranked`

`src/tools/search-ranked.ts` (new) exports:

```
searchNotesRanked(vaultPath, params): Promise<RankedSearchResult[]>
```

- `params`: `{ query: string; limit?: number }`.
- Validation: `query` non-empty string, ≤ 1000 chars; `limit` a positive integer
  (default 10, sane max e.g. 100).
- Gets the shared index via `getIndex(vaultPath)` and delegates to
  `index.searchRanked`.

Register in `src/index.ts`:
- Add the tool definition to the `list_tools` response (read tool, always
  exposed — not gated by `OBSIDIAN_ALLOW_WRITES`).
- Add a dispatch branch in the `CallTool` handler.

### Tool contract

```
search_notes_ranked
  input:  { query: string   (required, max 1000 chars)
            limit?: number   (default 10, max 100) }
  output: [ { path, title, tags, headline, size, modified,   // standard note header
              score,      // BM25 relevance, higher = more relevant
              snippet }   // short matched excerpt
          ]               // ordered by score desc, ties by path asc
```

### Types

Add to `src/types.ts`:
- `RankedSearchParams { query: string; limit?: number }`
- `RankedSearchResult` = `NoteHeader & { score: number; snippet: string }`

### Query CLI

Add a `search-ranked "<query>" [--limit N]` subcommand to `src/query-cli.ts`,
mirroring the existing `search` subcommand's output style, for manual testing.

### Documentation

Per the project rule, update **both**:
- `CLAUDE.md` — new `search_notes_ranked` section under Tools; note the shared
  index now also holds a BM25 index; add a CLI example.
- `README.md` — corresponding user-facing description.

## Testing (TDD)

Write tests first, in `tests/`.

**`tokenize`**
- Punctuation/whitespace splitting; lowercasing.
- Stopword removal.
- Stemming: `running` → `run`, `tests`/`tested` share a stem, etc.
- Query and document tokenization agree on the same input.

**`bm25`** (toy in-memory corpus, hand-checked)
- Ordering: doc with more query-term occurrences ranks higher.
- IDF: a rare term contributes more than a common one.
- Length normalization: a short doc isn't unfairly beaten by a long one.
- Title/heading boost: a note matching only in its title outranks a note with a
  single passing body mention.
- No-match / empty query → `[]`; determinism on ties (by docId).

**`searchNotesRanked`** (integration, temp vault fixture)
- Multi-word query returns notes ranked most-relevant-first.
- `limit` caps the result count.
- Snippet contains context around a matched term (or graceful fallback).
- Incremental refresh: editing a note changes its score on the next query.
- Missing/invalid vault path and empty query raise the expected errors.

## Non-goals (v1)

- No SQLite/FTS5 or on-disk persistence.
- No true per-field BM25F (token duplication approximates field boost).
- No phrase/proximity queries, fuzzy matching, or synonyms.
- No changes to the existing `search_notes` (ripgrep) tool.

## Files touched

New:
- `src/tools/text/tokenize.ts`
- `src/tools/text/bm25.ts`
- `src/tools/search-ranked.ts`
- `tests/tokenize.test.ts`, `tests/bm25.test.ts`, `tests/search-ranked.test.ts`

Modified:
- `src/tools/vault-index.ts` (token field on `IndexEntry`, BM25 build in
  `rebuildDerived`, `searchRanked` method, all-headings helper)
- `src/index.ts` (register `search_notes_ranked`)
- `src/types.ts` (`RankedSearchParams`, `RankedSearchResult`)
- `src/query-cli.ts` (`search-ranked` subcommand)
- `CLAUDE.md`, `README.md`
