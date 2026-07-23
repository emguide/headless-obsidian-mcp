# Truncation-Reporting Convention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wrap every list-style tool's return value in a self-describing `ListResponse<T>` envelope (`{ results, returned, omitted, truncated }`) so an agent can tell a complete result from a truncated one.

**Architecture:** Add a generic `ListResponse<T>` type and a single `toListResponse(fullRows, limit)` helper. Each of eleven tools captures its full filtered set before slicing, then returns the helper's output instead of a bare array. The MCP layer (`src/index.ts`) and query CLI (`src/query-cli.ts`) already `JSON.stringify` the tool's return value verbatim, so they need no edits. `search_notes` keeps its own richer shape and is untouched.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), `tsx --test` (Node's built-in `node:test`), no extra deps.

## Global Constraints

- Import specifiers end in `.js` even for `.ts` sources (ESM/NodeNext). Copy the existing pattern in each file.
- Tests run with `npm test` (`tsx --test tests/*.test.ts`). A single file: `npx tsx --test tests/<name>.test.ts`.
- The envelope field names are exactly: `results`, `returned`, `omitted`, `truncated`. No other names.
- `omitted = total - returned`, always `>= 0`. `truncated = omitted > 0`. `returned = results.length`.
- No-limit tools (`list_tags`, `list_properties`) call the same helper with `limit` undefined, yielding `omitted: 0, truncated: false`.
- `search_notes` (`src/tools/search.ts`) is OUT OF SCOPE — do not touch it or its tests.
- Every `limit`-validation `throw` in each tool stays exactly as it is today; it runs before slicing.
- Existing tests that assert bare-array shape (`result.length`, `result[0]`) migrate to `result.results` in the same task that changes the tool.

---

### Task 1: Add `ListResponse<T>` type and `toListResponse` helper

**Files:**
- Modify: `src/types.ts` (add the interface near `SearchNotesResponse`, ~line 52)
- Create: `src/tools/list-response.ts`
- Test: `tests/list-response.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface ListResponse<T> { results: T[]; returned: number; omitted: number; truncated: boolean }` (in `src/types.ts`)
  - `function toListResponse<T>(fullRows: T[], limit?: number): ListResponse<T>` (in `src/tools/list-response.ts`) — slices `fullRows` to `limit` (or returns all when `limit` is undefined) and computes the envelope fields. Every later task calls this.

- [ ] **Step 1: Write the failing test**

Create `tests/list-response.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { toListResponse } from "../src/tools/list-response.js";

test("no limit returns everything, not truncated", () => {
  const r = toListResponse([1, 2, 3]);
  assert.deepEqual(r, { results: [1, 2, 3], returned: 3, omitted: 0, truncated: false });
});

test("limit larger than length is not truncated", () => {
  const r = toListResponse([1, 2, 3], 10);
  assert.deepEqual(r, { results: [1, 2, 3], returned: 3, omitted: 0, truncated: false });
});

test("limit smaller than length truncates and reports omitted", () => {
  const r = toListResponse([1, 2, 3, 4, 5], 2);
  assert.deepEqual(r, { results: [1, 2], returned: 2, omitted: 3, truncated: true });
});

test("limit exactly equal to length is not truncated", () => {
  const r = toListResponse([1, 2, 3], 3);
  assert.deepEqual(r, { results: [1, 2, 3], returned: 3, omitted: 0, truncated: false });
});

test("empty input yields empty non-truncated envelope", () => {
  const r = toListResponse([], 5);
  assert.deepEqual(r, { results: [], returned: 0, omitted: 0, truncated: false });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/list-response.test.ts`
Expected: FAIL — cannot find module `../src/tools/list-response.js`.

- [ ] **Step 3: Add the type to `src/types.ts`**

Insert directly after the `SearchNotesResponse` interface (after its closing `}` near line 64):

```ts
/**
 * The self-describing shape every list-style tool returns: the (possibly
 * limited) rows plus enough metadata to tell a complete result from a
 * truncated one. `omitted = total - returned`; `truncated = omitted > 0`.
 */
export interface ListResponse<T> {
  /** The returned rows (at most `limit` when a limit was applied). */
  results: T[];
  /** Number of rows in `results` (== results.length). */
  returned: number;
  /** Rows dropped by the limit (0 when nothing was dropped). */
  omitted: number;
  /** True when at least one row was omitted. */
  truncated: boolean;
}
```

- [ ] **Step 4: Create the helper `src/tools/list-response.ts`**

```ts
import { ListResponse } from "../types.js";

/**
 * Wrap a fully-materialized result set in the standard list envelope, applying
 * `limit` (undefined = no limit) and reporting how many rows were dropped.
 * Every list-style tool funnels through this so the envelope fields never drift.
 */
export function toListResponse<T>(fullRows: T[], limit?: number): ListResponse<T> {
  const results = limit !== undefined ? fullRows.slice(0, limit) : fullRows;
  const omitted = fullRows.length - results.length;
  return {
    results,
    returned: results.length,
    omitted,
    truncated: omitted > 0,
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx tsx --test tests/list-response.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/tools/list-response.ts tests/list-response.test.ts
git commit -m "feat: add ListResponse envelope + toListResponse helper"
```

---

### Task 2: `list_notes` returns the envelope

**Files:**
- Modify: `src/tools/list.ts`
- Test: `tests/list.test.ts`

**Interfaces:**
- Consumes: `toListResponse` (Task 1); `ListResponse<NoteHeader>`, `NoteHeader`, `ListNotesParams` (types).
- Produces: `listNotes(vaultPath, params): Promise<ListResponse<NoteHeader>>`.

- [ ] **Step 1: Read the existing test to learn its fixture helpers**

Run: `sed -n '1,40p' tests/list.test.ts`
Note how it builds a temp vault and calls `listNotes` — reuse that fixture style in the new assertions.

- [ ] **Step 2: Add a failing truncation test**

Append to `tests/list.test.ts` a test that creates (at least) 3 notes and calls `listNotes(vault, { limit: 2 })`:

```ts
test("list_notes reports truncation via the envelope", async () => {
  const vault = await makeVault({
    "a.md": "# A",
    "b.md": "# B",
    "c.md": "# C",
  });
  const res = await listNotes(vault, { limit: 2 });
  assert.equal(res.truncated, true);
  assert.equal(res.returned, 2);
  assert.equal(res.omitted, 1);
  assert.equal(res.results.length, 2);

  const all = await listNotes(vault);
  assert.equal(all.truncated, false);
  assert.equal(all.omitted, 0);
  assert.equal(all.returned, all.results.length);
});
```

If `tests/list.test.ts` does not already have a `makeVault`-style helper, use whatever fixture function the file already defines (read it in Step 1) and match its call convention. Do not invent a new helper.

- [ ] **Step 3: Migrate existing assertions in `tests/list.test.ts`**

In every existing test in this file, change bare-array access to the envelope:
- `result.length` → `result.results.length`
- `result[0]` → `result.results[0]`
- `result.map(...)` / `result.find(...)` → `result.results.map(...)` / `result.results.find(...)`
Read the whole file and update each site.

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx tsx --test tests/list.test.ts`
Expected: FAIL — `listNotes` still returns an array, so `.results` is undefined.

- [ ] **Step 5: Change `listNotes` to return the envelope**

In `src/tools/list.ts`:
- Add import: `import { toListResponse } from "./list-response.js";`
- Change the signature return type from `Promise<NoteHeader[]>` to `Promise<ListResponse<NoteHeader>>` and add `ListResponse` to the type import from `../types.js`.
- Remove the `if (limit !== undefined) { entries = entries.slice(0, limit); }` block.
- Change the final `return entries.map(entryToHeader);` to:

```ts
  return toListResponse(entries.map(entryToHeader), limit);
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx tsx --test tests/list.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/tools/list.ts tests/list.test.ts
git commit -m "feat: list_notes returns ListResponse envelope"
```

---

### Task 3: `find_by_tag` returns the envelope

**Files:**
- Modify: `src/tools/tags.ts` (the `findByTag` function only)
- Test: `tests/tags.test.ts`

**Interfaces:**
- Consumes: `toListResponse` (Task 1).
- Produces: `findByTag(vaultPath, params): Promise<ListResponse<NoteHeader>>`. (`listTags` unchanged in this task — it is Task 12.)

- [ ] **Step 1: Read `tests/tags.test.ts` fixture style**

Run: `sed -n '1,40p' tests/tags.test.ts`

- [ ] **Step 2: Add a failing truncation test for `findByTag`**

Append a test that creates 3 notes all carrying tag `#x` and calls `findByTag(vault, { tags: ["x"], limit: 2 })`, asserting `truncated === true`, `returned === 2`, `omitted === 1`; plus an unlimited call asserting `truncated === false`, `omitted === 0`. Match the file's existing fixture helper.

- [ ] **Step 3: Migrate existing `findByTag` assertions in `tests/tags.test.ts`**

For every existing test that calls `findByTag`, change `result.length`/`result[0]`/`result.map` to the `.results` form. Leave `listTags` assertions untouched (that tool changes in Task 12).

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx tsx --test tests/tags.test.ts`
Expected: FAIL on the `findByTag` tests.

- [ ] **Step 5: Change `findByTag` to return the envelope**

In `src/tools/tags.ts`:
- Add `import { toListResponse } from "./list-response.js";`
- Add `ListResponse` to the `../types.js` import.
- Change `findByTag`'s return type to `Promise<ListResponse<NoteHeader>>`.
- Replace:

```ts
  const limited = limit !== undefined ? matched.slice(0, limit) : matched;
  return limited.map(entryToHeader);
```

with:

```ts
  return toListResponse(matched.map(entryToHeader), limit);
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx tsx --test tests/tags.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/tools/tags.ts tests/tags.test.ts
git commit -m "feat: find_by_tag returns ListResponse envelope"
```

---

### Task 4: `query_notes` returns the envelope

**Files:**
- Modify: `src/tools/properties.ts` (the `queryNotes` function only)
- Test: `tests/query-read.test.ts`

**Interfaces:**
- Consumes: `toListResponse` (Task 1).
- Produces: `queryNotes(vaultPath, params): Promise<ListResponse<NoteHeader>>`.

- [ ] **Step 1: Read `tests/query-read.test.ts` fixture style**

Run: `sed -n '1,40p' tests/query-read.test.ts`

- [ ] **Step 2: Add a failing truncation test**

Append a test creating 3 notes with frontmatter `status: active`, calling `queryNotes(vault, { where: { status: "active" }, limit: 2 })`, asserting `truncated`, `returned === 2`, `omitted === 1`; plus an unlimited call asserting `truncated === false`.

- [ ] **Step 3: Migrate existing `queryNotes` assertions**

Change every `result.length`/`result[0]`/`result.map`/`result.find` for `queryNotes` results to `.results` form throughout the file.

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx tsx --test tests/query-read.test.ts`
Expected: FAIL.

- [ ] **Step 5: Change `queryNotes` to return the envelope**

In `src/tools/properties.ts`:
- Add `import { toListResponse } from "./list-response.js";` (add to existing imports).
- Add `ListResponse` to the `../types.js` import list.
- Change `queryNotes`'s return type to `Promise<ListResponse<NoteHeader>>`.
- Replace:

```ts
  const limited = limit !== undefined ? matched.slice(0, limit) : matched;
  return limited.map(entryToHeader);
```

with:

```ts
  return toListResponse(matched.map(entryToHeader), limit);
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx tsx --test tests/query-read.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/tools/properties.ts tests/query-read.test.ts
git commit -m "feat: query_notes returns ListResponse envelope"
```

---

### Task 5: `list_recent_notes` returns the envelope

**Files:**
- Modify: `src/tools/recent.ts`
- Test: `tests/recent.test.ts`

**Interfaces:**
- Consumes: `toListResponse` (Task 1).
- Produces: `listRecentNotes(vaultPath, params): Promise<ListResponse<NoteHeader>>`.

Note: `listRecentNotes` defaults `limit = 20` and already slices as the last step. The full set is `selected` **after** filtering/sorting but **before** the final `.slice(0, limit)`. Capture total there.

- [ ] **Step 1: Read `tests/recent.test.ts` fixture style**

Run: `sed -n '1,40p' tests/recent.test.ts`

- [ ] **Step 2: Add a failing truncation test**

Append a test creating 3 notes and calling `listRecentNotes(vault, { limit: 2 })`, asserting `truncated`, `returned === 2`, `omitted === 1`; plus a call with `limit: 50` asserting `truncated === false`, `omitted === 0`.

- [ ] **Step 3: Migrate existing assertions**

Change every `result.length`/`result[0]`/`result.map` for `listRecentNotes` results to `.results` form.

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx tsx --test tests/recent.test.ts`
Expected: FAIL.

- [ ] **Step 5: Change `listRecentNotes` to return the envelope**

In `src/tools/recent.ts`:
- Add `import { toListResponse } from "./list-response.js";`
- Add `ListResponse` to the `../types.js` import.
- Change the return type to `Promise<ListResponse<NoteHeader>>`.
- Replace the final block:

```ts
  selected = selected
    .slice()
    .sort((a, b) => sortDateOf(b) - sortDateOf(a))
    .slice(0, limit);

  return selected.map(entryToHeader);
```

with (sort the full set, then hand the full sorted set to the helper so it slices and counts):

```ts
  const sorted = selected
    .slice()
    .sort((a, b) => sortDateOf(b) - sortDateOf(a));

  return toListResponse(sorted.map(entryToHeader), limit);
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx tsx --test tests/recent.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/tools/recent.ts tests/recent.test.ts
git commit -m "feat: list_recent_notes returns ListResponse envelope"
```

---

### Task 6: `get_related_notes` returns the envelope

**Files:**
- Modify: `src/tools/related.ts`
- Test: `tests/related.test.ts`

**Interfaces:**
- Consumes: `toListResponse` (Task 1).
- Produces: `getRelatedNotes(vaultPath, params): Promise<ListResponse<RelatedNote>>`. `total` is the count of notes with a connecting signal (the `related` array before slicing).

- [ ] **Step 1: Read `tests/related.test.ts` fixture style**

Run: `sed -n '1,40p' tests/related.test.ts`

- [ ] **Step 2: Add a failing truncation test**

Append a test building a source note plus at least 3 notes that share a tag or link with it (so ≥3 score > 0), calling `getRelatedNotes(vault, { path: "<source>", limit: 2 })` and asserting `truncated`, `returned === 2`, `omitted >= 1`; plus an unlimited-ish call (`limit: 50`) asserting `truncated === false`. Reuse the file's existing related-notes fixture.

- [ ] **Step 3: Migrate existing assertions**

Change every `result.length`/`result[0]`/`result.map`/`result.find` for `getRelatedNotes` results to `.results` form.

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx tsx --test tests/related.test.ts`
Expected: FAIL.

- [ ] **Step 5: Change `getRelatedNotes` to return the envelope**

In `src/tools/related.ts`:
- Add `import { toListResponse } from "./list-response.js";`
- Add `ListResponse` to the `../types.js` import (which currently imports `RelatedNotesParams, RelatedNote`).
- Change the return type to `Promise<ListResponse<RelatedNote>>`.
- Replace:

```ts
  related.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return related.slice(0, limit);
```

with:

```ts
  related.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return toListResponse(related, limit);
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx tsx --test tests/related.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/tools/related.ts tests/related.test.ts
git commit -m "feat: get_related_notes returns ListResponse envelope"
```

---

### Task 7: `list_files` returns the envelope

**Files:**
- Modify: `src/tools/files.ts`
- Test: `tests/files.test.ts`

**Interfaces:**
- Consumes: `toListResponse` (Task 1).
- Produces: `listFiles(vaultPath, params): Promise<ListResponse<VaultFileEntry>>`.

- [ ] **Step 1: Read `tests/files.test.ts` fixture style**

Run: `sed -n '1,40p' tests/files.test.ts`

- [ ] **Step 2: Add a failing truncation test**

Append a test creating ≥3 non-markdown files (e.g. `a.png`, `b.png`, `c.png`) and calling `listFiles(vault, { limit: 2 })`, asserting `truncated`, `returned === 2`, `omitted === 1`; plus an unlimited call asserting `truncated === false`, `omitted === 0`.

- [ ] **Step 3: Migrate existing assertions**

Change every `result.length`/`result[0]`/`result.map`/`result.find` for `listFiles` results to `.results` form.

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx tsx --test tests/files.test.ts`
Expected: FAIL.

- [ ] **Step 5: Change `listFiles` to return the envelope**

In `src/tools/files.ts`:
- Add `import { toListResponse } from "./list-response.js";`
- Add `ListResponse` to the `../types.js` import.
- Change the return type to `Promise<ListResponse<VaultFileEntry>>`.
- Replace the final line:

```ts
  return limit !== undefined ? out.slice(0, limit) : out;
```

with:

```ts
  return toListResponse(out, limit);
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx tsx --test tests/files.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/tools/files.ts tests/files.test.ts
git commit -m "feat: list_files returns ListResponse envelope"
```

---

### Task 8: `list_vault_issues` returns the envelope (both kinds)

**Files:**
- Modify: `src/tools/vault-issues.ts`
- Test: `tests/vault-issues.test.ts`

**Interfaces:**
- Consumes: `toListResponse` (Task 1).
- Produces: `listVaultIssues(vaultPath, params): Promise<ListResponse<NoteHeader> | ListResponse<UnresolvedLinkGroup>>`. For `orphans`, rows are note headers; for `unresolved_links`, rows are `{ source, targets }` groups (truncation counts groups, not individual targets).

- [ ] **Step 1: Read `tests/vault-issues.test.ts` fixture style**

Run: `sed -n '1,50p' tests/vault-issues.test.ts`

- [ ] **Step 2: Add failing truncation tests for both kinds**

Append tests:
- Create ≥3 orphan notes; call `listVaultIssues(vault, { kind: "orphans", limit: 2 })`; assert `truncated`, `returned === 2`, `omitted === 1`.
- Create ≥3 notes each with an unresolved wikilink (e.g. `[[nope-a]]`, `[[nope-b]]`, `[[nope-c]]` across 3 source notes); call `listVaultIssues(vault, { kind: "unresolved_links", limit: 2 })`; assert `truncated`, `returned === 2` (two source groups), `omitted === 1`.
- One unlimited call of each kind asserting `truncated === false`.

- [ ] **Step 3: Migrate existing assertions**

Change every `result.length`/`result[0]`/`result.map`/`result.find` for `listVaultIssues` results to `.results` form, for both kinds.

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx tsx --test tests/vault-issues.test.ts`
Expected: FAIL.

- [ ] **Step 5: Change `listVaultIssues` to return the envelope**

In `src/tools/vault-issues.ts`:
- Add `import { toListResponse } from "./list-response.js";`
- Add `ListResponse` to the `../types.js` import (currently `ListVaultIssuesParams, UnresolvedLinkGroup, NoteHeader`).
- Change the return type to `Promise<ListResponse<NoteHeader> | ListResponse<UnresolvedLinkGroup>>`.
- In the `orphans` branch, replace:

```ts
    const limited = limit !== undefined ? orphans.slice(0, limit) : orphans;
    return limited.map(entryToHeader);
```

with:

```ts
    return toListResponse(orphans.map(entryToHeader), limit);
```

- In the `unresolved_links` branch, replace:

```ts
  return limit !== undefined ? groups.slice(0, limit) : groups;
```

with:

```ts
  return toListResponse(groups, limit);
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx tsx --test tests/vault-issues.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/tools/vault-issues.ts tests/vault-issues.test.ts
git commit -m "feat: list_vault_issues returns ListResponse envelope"
```

---

### Task 9: `get_property_values` returns the envelope (nested alongside `key`)

**Files:**
- Modify: `src/tools/properties.ts` (the `getPropertyValues` function only)
- Test: `tests/properties-read.test.ts`

**Interfaces:**
- Consumes: `toListResponse` (Task 1).
- Produces: `getPropertyValues(vaultPath, params): Promise<{ key: string } & ListResponse<PropertyValueCount>>`. The result keeps its `key` field and gains the four envelope fields; the value rows live under `results` (renamed from `values`).

Rationale: this tool already returned an object `{ key, values }`, not a bare array. To keep one uniform envelope vocabulary vault-wide, `values` becomes `results` and the envelope fields sit alongside `key`. Output shape: `{ key, results, returned, omitted, truncated }`.

- [ ] **Step 1: Read `tests/properties-read.test.ts` fixture + existing `getPropertyValues` assertions**

Run: `sed -n '1,60p' tests/properties-read.test.ts`

- [ ] **Step 2: Add a failing truncation test**

Append a test creating notes so one property key has ≥3 distinct values, calling `getPropertyValues(vault, { key: "<key>", limit: 2 })`, asserting `res.key === "<key>"`, `res.truncated === true`, `res.returned === 2`, `res.omitted === 1`, `res.results.length === 2`; plus an unlimited call asserting `res.truncated === false`, `res.omitted === 0`.

- [ ] **Step 3: Migrate existing `getPropertyValues` assertions**

Every existing assertion using `result.values` becomes `result.results`. `result.key` stays. Update all sites in the file.

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx tsx --test tests/properties-read.test.ts`
Expected: FAIL.

- [ ] **Step 5: Change `getPropertyValues` to return the envelope**

In `src/tools/properties.ts`, in `getPropertyValues`:
- Ensure `toListResponse` is imported (added in Task 4; if this task runs first, add `import { toListResponse } from "./list-response.js";`).
- Add `ListResponse` to the `../types.js` import if not already present.
- Change the return type from `Promise<{ key: string; values: PropertyValueCount[] }>` to `Promise<{ key: string } & ListResponse<PropertyValueCount>>`.
- Replace:

```ts
  let values = [...counts.values()].sort(
    (a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value))
  );
  if (limit !== undefined) values = values.slice(0, limit);
  return { key, values };
```

with:

```ts
  const values = [...counts.values()].sort(
    (a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value))
  );
  return { key, ...toListResponse(values, limit) };
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx tsx --test tests/properties-read.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/tools/properties.ts tests/properties-read.test.ts
git commit -m "feat: get_property_values returns ListResponse envelope"
```

---

### Task 10: BM25 `search` exposes total-before-slice

**Files:**
- Modify: `src/tools/text/bm25.ts`
- Modify: `src/tools/vault-index.ts` (the one caller at line 174)
- Test: `tests/bm25.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `BM25Index.search(queryTokens: string[], limit: number): { hits: BM25Hit[]; total: number }` — `total` is the number of documents with a non-zero score (before the `limit` slice). Consumed by `VaultIndex.searchRanked` (Task 11).

- [ ] **Step 1: Read the current `bm25.test.ts` assertions**

Run: `cat tests/bm25.test.ts`
Every `idx.search(...)` currently treats the return as an array. All call sites move to `.hits`, and one new test asserts `.total`.

- [ ] **Step 2: Update `tests/bm25.test.ts`**

For each existing call, change the shape:
- `const hits = idx.search(["cat"], 10);` → `const { hits } = idx.search(["cat"], 10);`
- `idx.search(["rare"], 10)[0]` → `idx.search(["rare"], 10).hits[0]`
- `assert.deepEqual(idx.search([], 10), [])` → `assert.deepEqual(idx.search([], 10), { hits: [], total: 0 })`
- `assert.deepEqual(idx.search(["zebra"], 10), [])` → `assert.deepEqual(idx.search(["zebra"], 10), { hits: [], total: 0 })`
- `assert.equal(idx.search(["x"], 2).length, 2)` → `assert.equal(idx.search(["x"], 2).hits.length, 2)`
- `const hits = idx.search(["x"], 10);` → `const { hits } = idx.search(["x"], 10);`
- `const hits = idx.search(["cat", "dog"], 10);` → `const { hits } = idx.search(["cat", "dog"], 10);`

Then add a new test asserting `total` reflects all matches, not just the returned page:

```ts
test("search reports total matches beyond the limit", () => {
  const idx = new BM25Index();
  idx.add("d1", ["x"]);
  idx.add("d2", ["x"]);
  idx.add("d3", ["x"]);
  idx.finalize?.(); // if the test helper finalizes elsewhere, drop this line to match the file
  const res = idx.search(["x"], 2);
  assert.equal(res.hits.length, 2);
  assert.equal(res.total, 3);
});
```

Read the existing tests first (Step 1) to see exactly how documents are added/finalized in this suite, and mirror that setup — do not introduce a different construction pattern.

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx tsx --test tests/bm25.test.ts`
Expected: FAIL — `search` still returns an array.

- [ ] **Step 4: Change `BM25Index.search` return shape**

In `src/tools/text/bm25.ts`, change the `search` method signature and its two early returns and final return:

- Signature: `search(queryTokens: string[], limit: number): { hits: BM25Hit[]; total: number } {`
- Early return at line 57: `if (queryTokens.length === 0 || this.docs.size === 0) return { hits: [], total: 0 };`
- Replace the final block:

```ts
    return [...scores.entries()]
      .map(([docId, score]) => ({ docId, score }))
      .sort((a, b) => b.score - a.score || a.docId.localeCompare(b.docId))
      .slice(0, limit);
```

with:

```ts
    const ranked = [...scores.entries()]
      .map(([docId, score]) => ({ docId, score }))
      .sort((a, b) => b.score - a.score || a.docId.localeCompare(b.docId));
    return { hits: ranked.slice(0, limit), total: ranked.length };
```

- [ ] **Step 5: Update the one caller in `vault-index.ts`**

In `src/tools/vault-index.ts` line 174, change:

```ts
    const hits = this.bm25.search(queryTokens, limit);
```

to:

```ts
    const { hits } = this.bm25.search(queryTokens, limit);
```

(This keeps `searchRanked`'s current behavior; Task 11 threads `total` through.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx tsx --test tests/bm25.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/tools/text/bm25.ts src/tools/vault-index.ts tests/bm25.test.ts
git commit -m "refactor: BM25 search returns hits + total-before-slice"
```

---

### Task 11: `search_notes_ranked` returns the envelope

**Files:**
- Modify: `src/tools/vault-index.ts` (`searchRanked` method)
- Modify: `src/tools/search-ranked.ts`
- Test: `tests/search-ranked.test.ts`

**Interfaces:**
- Consumes: `BM25Index.search(...).total` (Task 10); `toListResponse` (Task 1).
- Produces:
  - `VaultIndex.searchRanked(query, limit): Promise<ListResponse<RankedSearchResult>>`
  - `searchNotesRanked(vaultPath, params): Promise<ListResponse<RankedSearchResult>>`

Note: the index method must build the envelope, because only it sees BM25's `total`. It slices to `limit` at the BM25 level already (that's the returned page), so `total` comes from BM25 and `returned/omitted` are derived from it — do NOT re-slice with `toListResponse` (that would slice an already-sliced page). Build the envelope explicitly from `total`.

- [ ] **Step 1: Read `tests/search-ranked.test.ts` fixture style**

Run: `sed -n '1,50p' tests/search-ranked.test.ts`

- [ ] **Step 2: Add a failing truncation test**

Append a test creating ≥3 notes that all match a query term, calling `searchNotesRanked(vault, { query: "<term>", limit: 2 })`, asserting `res.truncated === true`, `res.returned === 2`, `res.omitted === 1`, `res.results.length === 2`; plus a call with `limit: 50` asserting `res.truncated === false`, `res.omitted === 0`.

- [ ] **Step 3: Migrate existing assertions**

Change every `result.length`/`result[0]`/`result.map`/`result.find` for `searchNotesRanked` (and any direct `index.searchRanked`) results to `.results` form.

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx tsx --test tests/search-ranked.test.ts`
Expected: FAIL.

- [ ] **Step 5: Change `VaultIndex.searchRanked` to build the envelope**

In `src/tools/vault-index.ts`:
- Add `ListResponse` to the type import from `../types.js`.
- Change the method signature to `async searchRanked(query: string, limit: number): Promise<ListResponse<RankedSearchResult>>`.
- Replace the early return `if (queryTokens.length === 0) return [];` with `if (queryTokens.length === 0) return { results: [], returned: 0, omitted: 0, truncated: false };`.
- Change `const { hits } = this.bm25.search(queryTokens, limit);` to `const { hits, total } = this.bm25.search(queryTokens, limit);`.
- Change the final `return results;` to:

```ts
    return {
      results,
      returned: results.length,
      omitted: total - results.length,
      truncated: total > results.length,
    };
```

- [ ] **Step 6: Change `searchNotesRanked` return type**

In `src/tools/search-ranked.ts`:
- Add `ListResponse` to the `../types.js` import (currently `RankedSearchParams, RankedSearchResult`).
- Change the function return type to `Promise<ListResponse<RankedSearchResult>>`.
- The body already `return index.searchRanked(query, effectiveLimit);` — no body change needed since the index now returns the envelope.

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx tsx --test tests/search-ranked.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/tools/vault-index.ts src/tools/search-ranked.ts tests/search-ranked.test.ts
git commit -m "feat: search_notes_ranked returns ListResponse envelope"
```

---

### Task 12: No-limit tools `list_tags` and `list_properties` return the envelope

**Files:**
- Modify: `src/tools/tags.ts` (the `listTags` function)
- Modify: `src/tools/properties.ts` (the `listProperties` function)
- Test: `tests/tags.test.ts`, `tests/properties-read.test.ts`

**Interfaces:**
- Consumes: `toListResponse` (Task 1).
- Produces:
  - `listTags(vaultPath): Promise<ListResponse<TagCount>>`
  - `listProperties(vaultPath, params): Promise<ListResponse<PropertySchemaEntry>>`
- Both always report `truncated: false, omitted: 0` (no limit exists).

- [ ] **Step 1: Add failing "always not truncated" tests**

In `tests/tags.test.ts`, append a test: create 2 tagged notes, call `listTags(vault)`, assert `res.truncated === false`, `res.omitted === 0`, `res.returned === res.results.length`, and that a known tag is in `res.results`.

In `tests/properties-read.test.ts`, append a test: create notes with 2 distinct frontmatter keys, call `listProperties(vault)`, assert `res.truncated === false`, `res.omitted === 0`, and that a known key is in `res.results`.

- [ ] **Step 2: Migrate existing `listTags` / `listProperties` assertions**

In `tests/tags.test.ts`, change every `listTags` result access (`result.length`, `result.find`, `result[0]`, `result.map`) to `.results` form.
In `tests/properties-read.test.ts`, do the same for `listProperties`.

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx tsx --test tests/tags.test.ts tests/properties-read.test.ts`
Expected: FAIL.

- [ ] **Step 4: Change `listTags` to return the envelope**

In `src/tools/tags.ts`:
- Ensure `toListResponse` is imported (added in Task 3).
- Add `ListResponse` to the `../types.js` import.
- Change `listTags`'s return type to `Promise<ListResponse<TagCount>>`.
- Change the final `return [...counts.entries()].map(...).sort(...);` so the sorted array is passed to `toListResponse`:

```ts
  const tags = [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  return toListResponse(tags);
```

- [ ] **Step 5: Change `listProperties` to return the envelope**

In `src/tools/properties.ts`:
- Ensure `toListResponse` is imported.
- Change `listProperties`'s return type to `Promise<ListResponse<PropertySchemaEntry>>`.
- Change the final `return [...counts.entries()].map(...).sort(...);` to:

```ts
  const props = [...counts.entries()]
    .map(([key, count]) => ({
      key,
      count,
      types: [...(types.get(key) ?? [])].sort(),
    }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  return toListResponse(props);
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx tsx --test tests/tags.test.ts tests/properties-read.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/tools/tags.ts src/tools/properties.ts tests/tags.test.ts tests/properties-read.test.ts
git commit -m "feat: list_tags and list_properties return ListResponse envelope"
```

---

### Task 13: Sweep for other consumers + full suite green

**Files:**
- Possibly modify: `tests/cache.test.ts` and any other test that calls a wrapped tool.
- Do NOT modify: `src/index.ts`, `src/query-cli.ts` (they forward verbatim — confirm, don't change).

**Interfaces:**
- Consumes: everything from Tasks 2–12.
- Produces: a fully green `npm test`.

- [ ] **Step 1: Find every remaining consumer of a wrapped tool in tests**

Run:

```bash
grep -rn "listNotes\|findByTag\|queryNotes\|listRecentNotes\|getRelatedNotes\|listFiles\|listVaultIssues\|getPropertyValues\|searchNotesRanked\|listTags\|listProperties" tests/ | grep -v "list-response.test\|list.test\|tags.test\|query-read.test\|recent.test\|related.test\|files.test\|vault-issues.test\|properties-read.test\|search-ranked.test"
```

Expected: this surfaces any test file (e.g. `tests/cache.test.ts`) that calls a wrapped tool but wasn't migrated in Tasks 2–12.

- [ ] **Step 2: Migrate each surfaced assertion**

For every hit from Step 1, change bare-array access (`.length`, `[0]`, `.map`, `.find`) to the `.results` form. For `getPropertyValues`, `.values` → `.results`.

- [ ] **Step 3: Confirm the MCP layer and CLI need no change**

Run:

```bash
grep -n "JSON.stringify" src/index.ts | head
grep -n "JSON.stringify(result" src/query-cli.ts
```

Confirm each wrapped tool's handler stringifies the tool's return value directly (no `.length`/indexing on the result before stringify). If any handler indexes into the result, fix it to stringify the envelope. (Expected: none do.)

- [ ] **Step 4: Run the FULL suite**

Run: `npm test`
Expected: PASS — all files, zero failures.

- [ ] **Step 5: Build to catch type errors the tests missed**

Run: `npm run build`
Expected: `tsc` exits 0 (no type errors from the changed return types).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "test: migrate remaining consumers to ListResponse envelope"
```

---

### Task 14: Update documentation (`CLAUDE.md` + `README.md`)

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: the final shapes from all prior tasks.
- Produces: docs that describe the envelope for every wrapped tool.

Per the repo rule in `CLAUDE.md` ("always update both documentation files"), both change together.

- [ ] **Step 1: Update each wrapped tool's "Output" line in `CLAUDE.md`**

For each of these tools, change the Output description from "Array of note headers"/"Array of ..." to the envelope. Wrapped tools: `list_notes`, `find_by_tag`, `list_recent_notes`, `get_related_notes`, `list_files`, `list_vault_issues`, `get_property_values`, `query_notes`, `search_notes_ranked`, `list_tags`, `list_properties`.

Use this wording pattern (adapt the row description per tool):

> **Output**: `{ results, returned, omitted, truncated }` — `results` is the array of `<row type>` (at most `limit`); `returned`/`omitted` report how many rows were dropped by `limit`, and `truncated` is `omitted > 0`, so a capped result is never mistaken for a complete one.

For `get_property_values` specifically, note the shape is `{ key, results, returned, omitted, truncated }` (the `values` field is now `results`).

For `list_tags` / `list_properties`, note they always report `truncated: false` (no limit).

Add a short shared note near the top of the Tools section (or under `search_notes`) that the envelope is the vault-wide convention, distinct from `search_notes`' richer file/match shape.

- [ ] **Step 2: Mirror every one of those edits in `README.md`**

Apply the identical Output-line changes in `README.md` wherever the same tools are documented.

- [ ] **Step 3: Verify no stale "Array of" descriptions remain for wrapped tools**

Run:

```bash
grep -n "Array of note headers\|Array of \`{ source" CLAUDE.md README.md
```

Review each remaining hit: it must belong to a NON-wrapped context (e.g. `read_notes`' `notes` array, or `get_links` sub-arrays). Any wrapped tool still described as a bare array is a miss — fix it.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: describe ListResponse envelope for all list-style tools"
```

---

## Self-Review

**Spec coverage:**
- Generic envelope + field names (`results/returned/omitted/truncated`) → Task 1. ✓
- `total` captured before slice, index-cheap → helper in Task 1; each tool passes its full set. ✓
- All nine limit-accepting tools → Tasks 2–11. ✓
- Two no-limit tools (`list_tags`, `list_properties`) → Task 12. ✓
- `list_vault_issues` two row shapes, truncation-by-group → Task 8. ✓
- `get_related_notes` total = notes-with-signal → Task 6. ✓
- `search_notes` untouched → asserted in Global Constraints; no task modifies `src/tools/search.ts`. ✓
- MCP layer + CLI forward verbatim, no edits → confirmed in Task 13 Step 3. ✓
- Breaking change acknowledged → Global Constraints + test migrations throughout. ✓
- Docs (both files together) → Task 14. ✓

**Placeholder scan:** No TBD/TODO. Every code step shows the exact edit. Test steps that reuse an existing fixture instruct the implementer to read the file first (Step 1 of each task) rather than inventing a helper, because fixture helpers vary per test file and cannot be quoted blind — this is a deliberate instruction, not a placeholder.

**Type consistency:**
- `toListResponse<T>(fullRows: T[], limit?: number): ListResponse<T>` — defined Task 1, called by name in Tasks 2–9, 11, 12. ✓
- `BM25Index.search(...): { hits, total }` — defined Task 10, consumed Task 11. ✓
- `getPropertyValues` returns `{ key } & ListResponse<PropertyValueCount>` — Task 9; `values`→`results` migration flagged in Task 9 and re-swept in Task 13 Step 2. ✓
- `searchRanked` (index) returns the envelope, and `searchNotesRanked` forwards it — Task 11; the note warns NOT to double-slice via `toListResponse`. ✓
