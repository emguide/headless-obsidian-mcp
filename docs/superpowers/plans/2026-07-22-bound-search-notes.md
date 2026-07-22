# Bound `search_notes` Output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add soft, overridable caps to `search_notes` so one broad pattern can't flood the agent's context window.

**Architecture:** ripgrep still runs with full `--json` output; the JSON parse loop enforces two caps (`limit` files, `max_matches_per_file` matches per file) as it accumulates and records what it dropped. The tool now returns a wrapper object `{ results, truncated, files_returned, files_omitted, matches_capped_in }` instead of a bare array, so a truncated result is never mistaken for a complete one. Each cap defaults to 20 and accepts `0` to mean unlimited; there is no hard maximum.

**Tech Stack:** TypeScript (ESM, NodeNext), Node's built-in `node:test` runner via `tsx`, ripgrep (`rg`), commander (query CLI).

## Global Constraints

- Runtime: Node.js 18+, TypeScript compiled to `dist/` (imports use `.js` extensions).
- Test runner: `npm test` → `tsx --test tests/*.test.ts`. Run a single file with `npx tsx --test tests/search.test.ts`.
- Cap validation: each new cap must be an integer `>= 0`; `0` means unlimited; **no upper clamp**. Negative or non-integer throws.
- Defaults: `limit` = 20, `max_matches_per_file` = 20. `context_lines` default stays 5 (unchanged).
- Do **not** modify `search_notes_ranked` — it is already bounded (explicit non-goal in the spec).
- When updating functionality, update **both** `CLAUDE.md` and `README.md` (project rule).
- Spec: `docs/superpowers/specs/2026-07-22-bound-search-notes-design.md`.

---

### Task 1: Types for caps and wrapper response

**Files:**
- Modify: `src/types.ts:3-9` (extend `SearchNotesParams`), add new `SearchNotesResponse` interface after `SearchResult` (currently `src/types.ts:22-30`).

**Interfaces:**
- Consumes: existing `SearchResult` interface.
- Produces:
  - `SearchNotesParams` gains `limit?: number` and `max_matches_per_file?: number`.
  - `SearchNotesResponse { results: SearchResult[]; truncated: boolean; files_returned: number; files_omitted: number; matches_capped_in: string[] }`.

- [ ] **Step 1: Extend `SearchNotesParams`**

Replace the existing interface (`src/types.ts:3-9`) with:

```typescript
export interface SearchNotesParams {
  pattern: string;
  case_sensitive?: boolean;
  whole_word?: boolean;
  multiline?: boolean;
  context_lines?: number;
  /** Max number of files (result entries). Default 20; 0 = unlimited. */
  limit?: number;
  /** Max matches returned per file. Default 20; 0 = unlimited. */
  max_matches_per_file?: number;
}
```

- [ ] **Step 2: Add the `SearchNotesResponse` interface**

Immediately after the `SearchResult` interface (after `src/types.ts:30`), add:

```typescript
/** The bounded result of `searchNotes`, with truncation metadata. */
export interface SearchNotesResponse {
  /** Matching notes, at most `limit` entries (unless limit is 0). */
  results: SearchResult[];
  /** True if any cap (file or per-file) dropped results. */
  truncated: boolean;
  /** Number of files in `results` (== results.length). */
  files_returned: number;
  /** Distinct matching files seen beyond `limit` and not returned. */
  files_omitted: number;
  /** Paths of files whose matches were capped by max_matches_per_file. */
  matches_capped_in: string[];
}
```

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: PASS (no errors). Note: `src/tools/search.ts` still returns the old shape at this point but its return type is inferred, so this compiles.

- [ ] **Step 4: Commit**

```bash
git add src/types.ts
git commit -m "feat: add search_notes cap params and response type"
```

---

### Task 2: Enforce caps in `searchNotes`

**Files:**
- Modify: `src/tools/search.ts` (validation block near top; the parse loop; the return).
- Test: `tests/search.test.ts` (new).

**Interfaces:**
- Consumes: `SearchNotesParams`, `SearchNotesResponse`, `SearchResult` from Task 1.
- Produces: `searchNotes(vaultPath: string, params: SearchNotesParams): Promise<SearchNotesResponse>` — same name/module, new return type.

- [ ] **Step 1: Write the failing tests**

Create `tests/search.test.ts`:

```typescript
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { searchNotes } from "../src/tools/search.js";
import { makeVault, Fixture } from "./fixtures.js";

// 30 files each containing the word "needle" once.
function manyFiles(): { path: string; content: string }[] {
  return Array.from({ length: 30 }, (_, i) => ({
    path: `notes/n${i}.md`,
    content: `# Note ${i}\nThis note has a needle in it.\n`,
  }));
}

let fx: Fixture;
before(async () => {
  fx = await makeVault([
    ...manyFiles(),
    {
      path: "busy.md",
      content: ["# Busy"].concat(Array.from({ length: 50 }, () => "needle line")).join("\n"),
    },
    { path: "empty-topic.md", content: "# Nothing here\nplain text only\n" },
  ]);
});
after(async () => {
  await fx.cleanup();
});

test("defaults cap files at 20 and report truncation", async () => {
  const res = await searchNotes(fx.vaultPath, { pattern: "needle" });
  assert.equal(res.results.length, 20);
  assert.equal(res.files_returned, 20);
  assert.equal(res.truncated, true);
  // 31 files match (30 n* + busy.md); 20 returned, 11 omitted.
  assert.equal(res.files_omitted, 11);
});

test("limit above default is honored with no upper clamp", async () => {
  const res = await searchNotes(fx.vaultPath, { pattern: "needle", limit: 100 });
  assert.equal(res.results.length, 31);
  assert.equal(res.files_omitted, 0);
  assert.equal(res.truncated, false);
});

test("limit 0 disables the file cap", async () => {
  const res = await searchNotes(fx.vaultPath, { pattern: "needle", limit: 0 });
  assert.equal(res.results.length, 31);
  assert.equal(res.files_omitted, 0);
});

test("max_matches_per_file caps matches within a file", async () => {
  const res = await searchNotes(fx.vaultPath, {
    pattern: "needle",
    limit: 0,
    max_matches_per_file: 10,
  });
  const busy = res.results.find((r) => r.path === "busy");
  assert.ok(busy);
  assert.equal(busy.matches.length, 10);
  assert.ok(res.matches_capped_in.includes("busy"));
  assert.equal(res.truncated, true);
});

test("max_matches_per_file 0 returns all matches for a file", async () => {
  const res = await searchNotes(fx.vaultPath, {
    pattern: "needle",
    limit: 0,
    max_matches_per_file: 0,
  });
  const busy = res.results.find((r) => r.path === "busy");
  assert.ok(busy);
  assert.equal(busy.matches.length, 50);
  assert.deepEqual(res.matches_capped_in, []);
});

test("no matches returns empty results with empty flags", async () => {
  const res = await searchNotes(fx.vaultPath, { pattern: "zzz-no-such-token" });
  assert.deepEqual(res.results, []);
  assert.equal(res.truncated, false);
  assert.equal(res.files_returned, 0);
  assert.equal(res.files_omitted, 0);
  assert.deepEqual(res.matches_capped_in, []);
});

test("negative limit throws", async () => {
  await assert.rejects(
    () => searchNotes(fx.vaultPath, { pattern: "needle", limit: -1 }),
    /limit must be a non-negative integer/
  );
});

test("non-integer max_matches_per_file throws", async () => {
  await assert.rejects(
    () => searchNotes(fx.vaultPath, { pattern: "needle", max_matches_per_file: 2.5 }),
    /max_matches_per_file must be a non-negative integer/
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test tests/search.test.ts`
Expected: FAIL — the current `searchNotes` returns an array, so `res.results` is `undefined` and the assertions throw (e.g. `res.results.length` on undefined).

- [ ] **Step 3: Add cap validation**

In `src/tools/search.ts`, destructure the new params. Change the destructuring block (currently `src/tools/search.ts:37-43`) to:

```typescript
  const {
    pattern,
    case_sensitive = false,
    whole_word = false,
    multiline = false,
    context_lines = 5,
    limit = 20,
    max_matches_per_file = 20
  } = params;
```

Then, immediately after the existing `context_lines` validation block (the `if (!Number.isInteger(context_lines) ...)` check, currently `src/tools/search.ts:67-69`), add:

```typescript
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error('limit must be a non-negative integer (0 = unlimited)');
  }

  if (!Number.isInteger(max_matches_per_file) || max_matches_per_file < 0) {
    throw new Error('max_matches_per_file must be a non-negative integer (0 = unlimited)');
  }
```

- [ ] **Step 4: Enforce caps in the parse loop and return the wrapper**

Replace the accumulation section — from `const results: SearchResult[] = [];` through the final `return results;` (currently `src/tools/search.ts:106` to end of function) — with:

```typescript
  const results: SearchResult[] = [];
  const lines = stdout.trim().split('\n');

  const fileLimit = limit;                       // 0 = unlimited
  const matchLimit = max_matches_per_file;       // 0 = unlimited
  const cappedFiles = new Set<string>();

  let currentFile = '';
  let currentMatches: SearchResult['matches'] = [];
  let filesOmitted = 0;
  let skippingCurrentFile = false; // true once fileLimit reached; count distinct extra files

  const flushCurrent = () => {
    if (currentFile && currentMatches.length > 0) {
      results.push({ path: currentFile, matches: currentMatches });
    }
  };

  for (const line of lines) {
    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (parsed.type === 'match') {
      const relativePath = relative(vaultPath, parsed.data.path.text).replace(/\.md$/, '');

      if (currentFile !== relativePath) {
        // New file boundary: flush the previous file's matches.
        flushCurrent();
        currentFile = relativePath;
        currentMatches = [];

        // Decide whether this new file fits under the file cap.
        skippingCurrentFile = fileLimit > 0 && results.length >= fileLimit;
        if (skippingCurrentFile) {
          filesOmitted += 1;
        }
      }

      if (skippingCurrentFile) {
        continue;
      }

      if (parsed.data.submatches && parsed.data.submatches.length > 0) {
        if (matchLimit > 0 && currentMatches.length >= matchLimit) {
          cappedFiles.add(relativePath);
          continue;
        }
        currentMatches.push({
          line_number: parsed.data.line_number,
          content: parsed.data.lines.text,
          context_before: [],
          context_after: []
        });
      }
    } else if (parsed.type === 'context') {
      if (skippingCurrentFile) {
        continue;
      }
      if (currentMatches.length > 0) {
        const lastMatch = currentMatches[currentMatches.length - 1];
        if (parsed.data.line_number < lastMatch.line_number) {
          lastMatch.context_before.push(parsed.data.lines.text);
        } else {
          lastMatch.context_after.push(parsed.data.lines.text);
        }
      }
    }
  }

  flushCurrent();

  return {
    results,
    truncated: filesOmitted > 0 || cappedFiles.size > 0,
    files_returned: results.length,
    files_omitted: filesOmitted,
    matches_capped_in: [...cappedFiles]
  };
```

Also update the function signature's return type (currently `src/tools/search.ts:34`, `Promise<SearchResult[]>`) to `Promise<SearchNotesResponse>`, and add `SearchNotesResponse` to the type import at the top of the file (currently `import { SearchNotesParams, SearchResult } from "../types.js";` at `src/tools/search.ts:3`):

```typescript
import { SearchNotesParams, SearchResult, SearchNotesResponse } from "../types.js";
```

Note: the early `if (!stdout.trim()) { return []; }` (currently `src/tools/search.ts:101-103`) must also return the wrapper. Replace it with:

```typescript
  if (!stdout.trim()) {
    return { results: [], truncated: false, files_returned: 0, files_omitted: 0, matches_capped_in: [] };
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx tsx --test tests/search.test.ts`
Expected: PASS (all 8 tests).

- [ ] **Step 6: Verify full type-check and suite**

Run: `npx tsc --noEmit && npm test`
Expected: PASS. (Confirms no other in-repo consumer broke on the shape change.)

- [ ] **Step 7: Commit**

```bash
git add src/tools/search.ts tests/search.test.ts
git commit -m "feat: bound search_notes with file and per-file caps"
```

---

### Task 3: Expose caps in the MCP input schema

**Files:**
- Modify: `src/index.ts:95-121` (the `search_notes` tool `inputSchema.properties` and `description`).

**Interfaces:**
- Consumes: the `search_notes` case at `src/index.ts:562` already forwards `args` as `SearchNotesParams` and JSON-stringifies the result — the wrapper object stringifies unchanged, so the dispatch case needs no edit.

- [ ] **Step 1: Update description and add the two properties**

In `src/index.ts`, change the `search_notes` tool `description` (currently `src/index.ts:94`) to:

```typescript
          description: "Search through Obsidian notes using ripgrep. Returns matching notes with context lines, bounded by file and per-file match caps to avoid flooding context. Returns { results, truncated, files_returned, files_omitted, matches_capped_in }.",
```

Then, inside `inputSchema.properties`, after the `context_lines` property (currently ends at `src/index.ts:117`), add:

```typescript
              limit: {
                type: "number",
                description: "Max number of files (result entries) to return (default: 20, 0 = unlimited)"
              },
              max_matches_per_file: {
                type: "number",
                description: "Max matches to return per file (default: 20, 0 = unlimited)"
              },
```

- [ ] **Step 2: Verify it compiles and the server lists the tool**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: expose search_notes caps in MCP input schema"
```

---

### Task 4: Add CLI options and update docs

**Files:**
- Modify: `src/query-cli.ts:143-161` (the `search` command).
- Modify: `README.md:198-212` (parameters + returns) and `README.md:530-534` (example).
- Modify: `CLAUDE.md` (the `search_notes` tool section: Input + Output).

**Interfaces:**
- Consumes: `search_notes` tool via the generic `queryTool` (JSON-prints the wrapper — no special handling).

- [ ] **Step 1: Add `--limit` and `--max-matches` CLI options**

In `src/query-cli.ts`, in the `.command("search")` block, add two options after the `-c, --context` option (currently `src/query-cli.ts:149`):

```typescript
  .option("-l, --limit <n>", "Max files to return (default: 20, 0 = unlimited)")
  .option("--max-matches <n>", "Max matches per file (default: 20, 0 = unlimited)")
```

Then, in that command's `.action`, extend the `args` object (currently `src/query-cli.ts:153-159`) to forward them when present:

```typescript
    const args = {
      pattern,
      ...(options.caseSensitive && { case_sensitive: true }),
      ...(options.wholeWord && { whole_word: true }),
      ...(options.multiline && { multiline: true }),
      ...(context !== 5 && { context_lines: context }),
      ...(options.limit !== undefined && { limit: parseInt(options.limit, 10) }),
      ...(options.maxMatches !== undefined && { max_matches_per_file: parseInt(options.maxMatches, 10) })
    };
```

- [ ] **Step 2: Manually verify the CLI works against the repo**

Run: `npm run query -- search "search_notes" --limit 3`
Expected: JSON printed as `{ "results": [...], "truncated": ..., "files_returned": ..., "files_omitted": ..., "matches_capped_in": [...] }` with at most 3 entries in `results`.

Run: `npm run query -- search "search_notes" --limit -1`
Expected: an error mentioning `limit must be a non-negative integer`.

- [ ] **Step 3: Update `README.md` parameters and returns**

Replace the `search_notes` **Parameters** list (currently `README.md:203-207`) — keep the existing four lines and add after the `context_lines` line:

```markdown
- `limit` (number, optional): Maximum number of files to return (default: 20, 0 = unlimited — no hard maximum)
- `max_matches_per_file` (number, optional): Maximum matches to return per file (default: 20, 0 = unlimited)
```

Replace the **Returns** block (currently `README.md:209-212`) with:

```markdown
**Returns:** An object bounding the result set:
- `results`: Array of search results, each with `path` (relative, without .md) and `matches` (line numbers + context)
- `truncated`: `true` if any cap dropped results
- `files_returned`: number of files in `results`
- `files_omitted`: matching files seen beyond `limit` and not returned
- `matches_capped_in`: paths of files whose matches were capped
```

- [ ] **Step 4: Update the `README.md` example**

Replace the search example (currently `README.md:531-534`) with:

```javascript
// Search for notes containing "productivity" (bounded: 20 files, 20 matches/file by default)
await search_notes({
  pattern: "productivity",
  case_sensitive: false,
  limit: 20,             // 0 for unlimited
  max_matches_per_file: 20
});
```

- [ ] **Step 5: Update `CLAUDE.md`**

In the `### search_notes` section, replace the `**Input**` and `**Output**` bullets so the Input list gains:

```markdown
  - `limit` (optional): Max number of files to return (default: 20, `0` = unlimited — no hard maximum)
  - `max_matches_per_file` (optional): Max matches per file (default: 20, `0` = unlimited)
```

and the `**Output**` line becomes:

```markdown
- **Output**: `{ results, truncated, files_returned, files_omitted, matches_capped_in }` — `results` is the array of matches (file paths without .md, plus context lines), bounded by the caps above; the other fields report what was dropped so a truncated result isn't mistaken for a complete one.
```

Also, in the **Testing** section of `CLAUDE.md`, add a CLI example line under the search examples (after the `search-ranked` line):

```bash
npm run query -- search "productivity" --limit 20 --max-matches 20   # Bounded literal search
```

- [ ] **Step 6: Verify docs and full suite**

Run: `npx tsc --noEmit && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/query-cli.ts README.md CLAUDE.md
git commit -m "feat: add search CLI caps and document bounded search_notes"
```

---

## Self-Review

**Spec coverage:**
- New params `limit` + `max_matches_per_file` with defaults 20, `0` = unlimited, no upper clamp → Task 1 (types), Task 2 (validation + enforcement).
- Parse-time cap approach → Task 2 Step 4.
- Wrapper output shape `{ results, truncated, files_returned, files_omitted, matches_capped_in }` → Task 1 (type), Task 2 (return).
- `context_lines` unchanged → confirmed (default still 5, untouched).
- No change to `search_notes_ranked` → not touched by any task (explicit).
- MCP schema exposure → Task 3.
- CLI options → Task 4 Steps 1–2.
- Docs in both `CLAUDE.md` and `README.md` → Task 4 Steps 3–5.
- All test cases from the spec's Testing section → Task 2 Step 1 (defaults/truncation, limit honored + no clamp, limit 0, per-file cap + matches_capped_in, per-file 0, empty, invalid throws).

**Placeholder scan:** No TBD/TODO; every code step shows full code.

**Type consistency:** `SearchNotesResponse` fields (`results`, `truncated`, `files_returned`, `files_omitted`, `matches_capped_in`) are identical across Task 1 definition, Task 2 return, Task 2 tests, Task 3 description, and Task 4 docs. `searchNotes` signature returns `Promise<SearchNotesResponse>` consistently. Error strings (`limit must be a non-negative integer`, `max_matches_per_file must be a non-negative integer`) match between Task 2 validation and Task 2 tests.
