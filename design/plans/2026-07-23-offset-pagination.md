# Offset Pagination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an additive `offset` parameter to every envelope-returning tool so a client can page past the `limit` window without re-fetching rows it already has.

**Architecture:** The shared `toListResponse` helper absorbs offset for all standard list tools by slicing a `[offset, offset+limit)` window and reporting a new `skipped` field (rows before the window) alongside a redefined `omitted` (rows after the window). The two special-case search tools — `search_notes_ranked` (limit applied inside the BM25 index) and `search_notes` (its own file-envelope) — get parallel offset handling. At `offset: 0` every output is byte-identical to today, so all existing behavior is preserved.

**Tech Stack:** TypeScript (ESM, NodeNext), Node's built-in `node:test` runner via tsx, MCP SDK, commander (CLI). Tests live in `tests/*.test.ts` and use the `makeVault`/`sampleNotes` fixture harness in `tests/fixtures.ts`.

## Global Constraints

- `offset` validation message: **"offset must be a non-negative integer"** (rejects non-integer and `< 0`; `0` is valid and is the default).
- `offset` default is `0`. `offset` beyond the result set is NOT an error — empty `results`, `skipped = total`, `omitted = 0`, `truncated = false`.
- `skipped` counts rows dropped BEFORE the window; `omitted` counts rows dropped AFTER the window only. `truncated = omitted > 0` (skipping forward never sets `truncated`).
- `total = skipped + returned + omitted` must always be recoverable.
- Do NOT change `limit` defaults, existing `limit` validation messages, or the `MAX_LIMIT = 100` cap on `search_notes_ranked`.
- Every functionality change is mirrored in BOTH `CLAUDE.md` and `README.md`.
- Test dir is `tests/` (glob `tsx --test tests/*.test.ts`). New tests use `makeVault(notes)` from `tests/fixtures.ts` and must clear via the fixture's `cleanup()`.
- `folders.ts` has an `assertBound` helper whose message says "positive" — do NOT reuse it for offset; use the new `assertNonNegativeInt` so the message matches the constraint.

---

### Task 1: Envelope core — `skipped` field + `toListResponse` offset + shared validator (DONE inline)

- Add `skipped: number` to `ListResponse<T>` in `src/types.ts`.
- Add `assertNonNegativeInt(value, name)` and offset slicing to `src/tools/list-response.ts`.
- Extend `tests/list-response.test.ts` with offset + validator cases and add `skipped: 0` to the existing `deepEqual` envelopes.
- Verify: `npx tsx --test tests/list-response.test.ts` green; `npm test` green.

### Task 2: Thread offset through the standard list tools

Tools: `list.ts`, `files.ts`, `recent.ts`, `related.ts`, `tags.ts` (findByTag), `properties.ts` (getPropertyValues + queryNotes), `folders.ts`, `vault-issues.ts`. Each: add `offset?` to its params interface, destructure, `assertNonNegativeInt(offset, "offset")`, pass `offset` as the 3rd arg to `toListResponse`. Add `offset?: number` to the matching interfaces in `types.ts`. Test with `makeVault` in `tests/offset-list-tools.test.ts`.

### Task 3: `search_notes_ranked` — offset paging past the ranked cap

- `bm25.ts`: `search(..., offset = 0)` → `ranked.slice(offset, offset + limit)`.
- `vault-index.ts`: `searchRanked(query, limit, allowedIds?, offset = 0)` → pass offset to bm25, compute `skipped = min(offset, total)`, `omitted = total - skipped - returned`; add `skipped: 0` to empty early-returns.
- `search-ranked.ts`: validate + thread offset through both `searchRanked` calls; `skipped: 0` in the empty early-return.
- `types.ts`: `RankedSearchParams.offset`. Test `tests/offset-ranked.test.ts`.

### Task 4: `search_notes` — file-offset + `files_skipped`

- `search.ts`: validate `offset`; in the file-boundary logic apply offset first (skip first `offset` matching files, count `filesSkipped`), then the file cap; add `files_skipped` to every return object; `files_skipped` does NOT set `truncated`.
- `types.ts`: `SearchNotesResponse.files_skipped`, `SearchNotesParams.offset`. Test `tests/offset-search.test.ts`.

### Task 5: MCP schemas, CLI flags, list_tags/list_properties

- `list_tags`/`list_properties` accept offset (uniform envelope). `listTags(vaultPath, offset?)`, `listProperties(vaultPath, {..., offset})`.
- `index.ts`: add `offset` to each envelope tool's `inputSchema.properties` and pass it from each handler.
- `query-cli.ts`: add `--offset <n>` to each envelope subcommand.
- Extend `tests/offset-list-tools.test.ts`. Build + full suite.

### Task 6: Docs — CLAUDE.md + README.md

Document the `offset` input, the `skipped` / `files_skipped` fields, the ranked-offset note, and CLI `--offset` examples in both files.

### Task 7: Final verification

`npm run build` clean; `npm test` all green (original + new); confirm backward compat (offset:0 → today's shape + skipped:0); confirm the worst-case `search-ranked --limit 100 --offset 100` reaches hits 101–200.

---

*(The full step-by-step code for each task is applied inline during execution; this plan is the map. Detailed per-task code blocks were validated against the live source before execution.)*
