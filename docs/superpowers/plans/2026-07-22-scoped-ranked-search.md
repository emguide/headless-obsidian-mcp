# Scoped Ranked Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `search_notes_ranked` the same `folder`/`tags`/`where`/`match` filters as `search_notes`, filtering *inside* BM25 so scoped top-N is correct, and extract the duplicated candidate-resolution logic into one shared resolver.

**Architecture:** A new `candidate-filter.ts` module owns "scope index entries to a candidate set" (folder → tags → where). `BM25.search` gains an optional `allowedIds` set so ranking happens over candidates only. `search_notes`, `search_notes_ranked`, and `bulk_edit` all consume the shared resolver. Per-field `tagMatch`/`whereMatch` parameters preserve each caller's exact current semantics.

**Tech Stack:** TypeScript (ES modules, `.js` import specifiers), Node's built-in `node:test` runner via tsx, gray-matter, ripgrep.

## Global Constraints

- Node 18+; ES modules — every relative import uses a `.js` specifier (e.g. `import { resolveCandidates } from "./candidate-filter.js"`).
- Tests use `node:test` + `node:assert/strict` and the `makeVault`/`Fixture` helpers from `tests/fixtures.js`.
- Run the full suite with `npm test`. Run a single file with `npx tsx --test tests/<file>.ts`.
- BM25 `docId` is the note's `entry.path` (relative, no `.md`). ripgrep needs `entry.fullPath` (absolute). Keep these straight.
- `search_notes` semantics that MUST be preserved: `match` governs only `tags`; `where` is always evaluated as `"all"`. `bulk_edit` semantics: `match` governs both `tags` and `where`.
- When updating functionality, update BOTH `CLAUDE.md` and `README.md` (project rule).
- No new runtime dependencies.

---

### Task 1: Shared candidate-filter module

**Files:**
- Create: `src/tools/candidate-filter.ts`
- Test: `tests/candidate-filter.test.ts`

**Interfaces:**
- Consumes: `getIndex`, `VaultIndex.getEntries()`, `IndexEntry` from `./vault-index.js`; `matchesWhere`, `Condition` from `./property-match.js`.
- Produces:
  - `interface CandidateFilter { folder?: string; tags?: string[]; where?: Record<string, Condition>; tagMatch?: "any" | "all"; whereMatch?: "any" | "all"; }`
  - `function validateCandidateFilter(f: { tags?: unknown; where?: unknown; match?: unknown }): void`
  - `function resolveCandidates(index: VaultIndex, f: CandidateFilter): IndexEntry[]`

- [ ] **Step 1: Write the failing test**

Create `tests/candidate-filter.test.ts`:

```typescript
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { getIndex } from "../src/tools/vault-index.js";
import { resolveCandidates, validateCandidateFilter } from "../src/tools/candidate-filter.js";
import { makeVault, Fixture } from "./fixtures.js";

let fx: Fixture;
before(async () => {
  fx = await makeVault([
    { path: "work/a.md", content: ["---", "status: active", "tags: [proj, urgent]", "---", "# A", "alpha"].join("\n") },
    { path: "work/b.md", content: ["---", "status: done", "tags: [proj]", "---", "# B", "beta"].join("\n") },
    { path: "home/c.md", content: ["---", "tags: [urgent]", "---", "# C", "gamma"].join("\n") },
  ]);
});
after(() => fx.cleanup());

test("folder scopes to notes under the prefix", async () => {
  const idx = await getIndex(fx.vaultPath);
  const paths = resolveCandidates(idx, { folder: "work" }).map((e) => e.path).sort();
  assert.deepEqual(paths, ["work/a", "work/b"]);
});

test("tags with tagMatch=all requires every tag", async () => {
  const idx = await getIndex(fx.vaultPath);
  const paths = resolveCandidates(idx, { tags: ["proj", "urgent"], tagMatch: "all" }).map((e) => e.path);
  assert.deepEqual(paths, ["work/a"]);
});

test("tags with tagMatch=any (default) matches any tag", async () => {
  const idx = await getIndex(fx.vaultPath);
  const paths = resolveCandidates(idx, { tags: ["urgent"] }).map((e) => e.path).sort();
  assert.deepEqual(paths, ["home/c", "work/a"]);
});

test("where filters by frontmatter", async () => {
  const idx = await getIndex(fx.vaultPath);
  const paths = resolveCandidates(idx, { where: { status: "active" } }).map((e) => e.path);
  assert.deepEqual(paths, ["work/a"]);
});

test("filters compose (folder + tags + where)", async () => {
  const idx = await getIndex(fx.vaultPath);
  const paths = resolveCandidates(idx, { folder: "work", tags: ["proj"], where: { status: "active" } }).map((e) => e.path);
  assert.deepEqual(paths, ["work/a"]);
});

test("validateCandidateFilter rejects empty tags array", () => {
  assert.throws(() => validateCandidateFilter({ tags: [] }), /tags must be a non-empty array/);
});

test("validateCandidateFilter rejects non-object where", () => {
  assert.throws(() => validateCandidateFilter({ where: [] }), /where must be an object/);
});

test("validateCandidateFilter rejects bad match", () => {
  assert.throws(() => validateCandidateFilter({ match: "some" }), /match must be/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/candidate-filter.test.ts`
Expected: FAIL — cannot find module `../src/tools/candidate-filter.js`.

- [ ] **Step 3: Write the implementation**

Create `src/tools/candidate-filter.ts`:

```typescript
import type { VaultIndex, IndexEntry } from "./vault-index.js";
import { matchesWhere } from "./property-match.js";
import type { Condition } from "./property-match.js";

export interface CandidateFilter {
  folder?: string;
  tags?: string[];
  where?: Record<string, Condition>;
  /** How to combine multiple tags. Default "any". */
  tagMatch?: "any" | "all";
  /** How to combine multiple where conditions. Default "all". */
  whereMatch?: "any" | "all";
}

/**
 * Validate the raw filter inputs shared by search_notes / search_notes_ranked.
 * Messages match search_notes verbatim so the two tools reject identically.
 */
export function validateCandidateFilter(f: { tags?: unknown; where?: unknown; match?: unknown }): void {
  if (f.tags !== undefined && (!Array.isArray(f.tags) || f.tags.length === 0)) {
    throw new Error("tags must be a non-empty array when provided");
  }
  if (f.match !== undefined && f.match !== "any" && f.match !== "all") {
    throw new Error('match must be "any" or "all"');
  }
  if (f.where !== undefined && (typeof f.where !== "object" || f.where === null || Array.isArray(f.where))) {
    throw new Error("where must be an object of property conditions");
  }
}

/**
 * Scope the vault to a candidate set: apply folder-prefix, then tags, then
 * where filters over the index entries. Each field is optional; an absent
 * field imposes no constraint. Returns the surviving entries in index order.
 */
export function resolveCandidates(index: VaultIndex, f: CandidateFilter): IndexEntry[] {
  const tagMatch = f.tagMatch ?? "any";
  const whereMatch = f.whereMatch ?? "all";
  const folderPrefix = f.folder && f.folder.trim()
    ? f.folder.replace(/[\\/]+$/, "").replace(/\\/g, "/") + "/"
    : undefined;
  const wantedTags = f.tags?.map((t) => String(t).replace(/^#/, "").toLowerCase());

  return index.getEntries().filter((entry) => {
    if (folderPrefix && !(entry.path + "/").startsWith(folderPrefix)) {
      return false;
    }
    if (wantedTags) {
      const noteSet = new Set(entry.tags.map((t) => t.toLowerCase()));
      const ok = tagMatch === "all"
        ? wantedTags.every((w) => noteSet.has(w))
        : wantedTags.some((w) => noteSet.has(w));
      if (!ok) return false;
    }
    if (f.where) {
      if (!matchesWhere(entry.frontmatter, f.where, whereMatch)) return false;
    }
    return true;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/candidate-filter.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tools/candidate-filter.ts tests/candidate-filter.test.ts
git commit -m "feat: shared resolveCandidates + validateCandidateFilter"
```

---

### Task 2: BM25 scoped scoring via allowedIds

**Files:**
- Modify: `src/tools/text/bm25.ts:55-81` (the `search` method)
- Test: `tests/bm25-scoped.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `BM25.search(queryTokens: string[], limit: number, allowedIds?: Set<string>): BM25Hit[]` — when `allowedIds` is supplied, only docs whose `docId` is in the set are scored; the top-N is taken from those. Omitted → unchanged behavior.

- [ ] **Step 1: Write the failing test**

Create `tests/bm25-scoped.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { BM25 } from "../src/tools/text/bm25.js";

function build(): BM25 {
  const b = new BM25();
  b.add("a", ["alpha", "shared"]);
  b.add("b", ["beta", "shared"]);
  b.add("c", ["gamma", "shared"]);
  b.finalize();
  return b;
}

test("allowedIds restricts scoring to the candidate set", () => {
  const b = build();
  const hits = b.search(["shared"], 10, new Set(["a", "c"]));
  const ids = hits.map((h) => h.docId).sort();
  assert.deepEqual(ids, ["a", "c"]);
});

test("empty allowedIds yields no hits", () => {
  const b = build();
  assert.deepEqual(b.search(["shared"], 10, new Set()), []);
});

test("omitting allowedIds scores the whole corpus (unchanged)", () => {
  const b = build();
  const ids = b.search(["shared"], 10).map((h) => h.docId).sort();
  assert.deepEqual(ids, ["a", "b", "c"]);
});

test("top-N is taken from candidates, not the global set", () => {
  // 'b' has the strongest 'target' signal but is out of scope; scoping to
  // {a} must still return a, not silently drop to zero results.
  const b = new BM25();
  b.add("a", ["target", "filler", "filler"]);
  b.add("b", ["target", "target", "target"]);
  b.finalize();
  const hits = b.search(["target"], 1, new Set(["a"]));
  assert.deepEqual(hits.map((h) => h.docId), ["a"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/bm25-scoped.test.ts`
Expected: FAIL — the "allowedIds restricts scoring" test fails because the extra argument is ignored (all three docs returned).

- [ ] **Step 3: Modify the search method**

In `src/tools/text/bm25.ts`, change the signature and skip non-candidate docs while walking postings. Replace the method body (lines 55–81):

```typescript
  search(queryTokens: string[], limit: number, allowedIds?: Set<string>): BM25Hit[] {
    if (!this.finalized) this.finalize();
    if (queryTokens.length === 0 || this.docs.size === 0) return [];
    if (allowedIds && allowedIds.size === 0) return [];

    const N = this.docs.size;
    const scores = new Map<string, number>();
    // Score only documents that appear in some query term's postings list.
    const queryTerms = new Set(queryTokens);

    for (const term of queryTerms) {
      const df = this.df.get(term);
      if (!df) continue; // term not in corpus
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      for (const docId of this.postings.get(term)!) {
        if (allowedIds && !allowedIds.has(docId)) continue;
        const doc = this.docs.get(docId)!;
        const tf = doc.tf.get(term)!;
        const denom = tf + K1 * (1 - B + (B * doc.length) / (this.avgdl || 1));
        const contribution = idf * ((tf * (K1 + 1)) / denom);
        scores.set(docId, (scores.get(docId) ?? 0) + contribution);
      }
    }

    return [...scores.entries()]
      .map(([docId, score]) => ({ docId, score }))
      .sort((a, b) => b.score - a.score || a.docId.localeCompare(b.docId))
      .slice(0, limit);
  }
```

Note: `N` (corpus size) and `idf` intentionally stay whole-corpus — the candidate set restricts *which* docs are scored, not the global term statistics, so a candidate's score is identical to its unscoped score. This keeps scoped and unscoped rankings consistent.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test tests/bm25-scoped.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tools/text/bm25.ts tests/bm25-scoped.test.ts
git commit -m "feat: BM25.search accepts optional allowedIds candidate set"
```

---

### Task 3: Thread allowedIds through VaultIndex.searchRanked

**Files:**
- Modify: `src/tools/vault-index.ts:171-190` (the `searchRanked` method)
- Test: `tests/search-ranked.test.ts` (add cases)

**Interfaces:**
- Consumes: `BM25.search(tokens, limit, allowedIds?)` from Task 2.
- Produces: `VaultIndex.searchRanked(query: string, limit: number, allowedIds?: Set<string>): Promise<RankedSearchResult[]>` — passes `allowedIds` to BM25; an empty set short-circuits to `[]`.

- [ ] **Step 1: Write the failing test**

Append to `tests/search-ranked.test.ts`:

```typescript
test("searchRanked restricts results to allowedIds", async () => {
  const idx = await getIndex(fx.vaultPath);
  const res = await idx.searchRanked("networking", 10, new Set(["aside"]));
  assert.deepEqual(res.map((r) => r.path), ["aside"]);
});

test("searchRanked with empty allowedIds returns nothing", async () => {
  const idx = await getIndex(fx.vaultPath);
  assert.deepEqual(await idx.searchRanked("networking", 10, new Set()), []);
});
```

(The `before` block in this file already creates `k8s.md`, `aside.md`, `unrelated.md`; both mention "networking", so scoping to `aside` proves the filter cut.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/search-ranked.test.ts`
Expected: FAIL — "restricts results to allowedIds" returns `k8s` too (the third arg is ignored).

- [ ] **Step 3: Modify searchRanked**

In `src/tools/vault-index.ts`, update the method (lines 171–190). Change the signature and pass `allowedIds` to `bm25.search`, short-circuiting on an empty set:

```typescript
  async searchRanked(query: string, limit: number, allowedIds?: Set<string>): Promise<RankedSearchResult[]> {
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];
    if (allowedIds && allowedIds.size === 0) return [];
    const hits = this.bm25.search(queryTokens, limit, allowedIds);

    // Raw (unstemmed) query words used only to locate a snippet line.
    const rawWords = query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 0);

    const results: RankedSearchResult[] = [];
    for (const hit of hits) {
      const entry = this.entries.get(hit.docId);
      if (!entry) continue;
      const snippet = await this.buildSnippet(entry.fullPath, rawWords);
      results.push({ ...entryToHeader(entry), score: hit.score, snippet });
    }
    return results;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test tests/search-ranked.test.ts`
Expected: PASS (all existing cases plus the 2 new ones).

- [ ] **Step 5: Commit**

```bash
git add src/tools/vault-index.ts tests/search-ranked.test.ts
git commit -m "feat: searchRanked threads allowedIds to BM25"
```

---

### Task 4: Add filter inputs to search_notes_ranked (types + tool)

**Files:**
- Modify: `src/types.ts:201-207` (`RankedSearchParams`)
- Modify: `src/tools/search-ranked.ts`
- Test: `tests/search-ranked-scoped.test.ts`

**Interfaces:**
- Consumes: `resolveCandidates`, `validateCandidateFilter`, `CandidateFilter` from `./candidate-filter.js`; `VaultIndex.searchRanked(query, limit, allowedIds?)` from Task 3.
- Produces: `RankedSearchParams` extended with `folder?: string; tags?: string[]; match?: "any" | "all"; where?: Record<string, Condition>`. `searchNotesRanked(vaultPath, params)` resolves candidates when any filter is present and passes the allowed-id set to `searchRanked`.

- [ ] **Step 1: Write the failing test**

Create `tests/search-ranked-scoped.test.ts`:

```typescript
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { searchNotesRanked } from "../src/tools/search-ranked.js";
import { makeVault, Fixture } from "./fixtures.js";

let fx: Fixture;
before(async () => {
  fx = await makeVault([
    { path: "work/net.md", content: ["---", "tags: [work]", "status: active", "---", "# Networking", "kubernetes networking cluster"].join("\n") },
    { path: "home/net.md", content: ["---", "tags: [home]", "---", "# Home net", "kubernetes networking at home"].join("\n") },
    { path: "work/old.md", content: ["---", "tags: [work]", "status: archived", "---", "# Old", "kubernetes networking legacy"].join("\n") },
  ]);
});
after(() => fx.cleanup());

test("folder scopes ranked search", async () => {
  const res = await searchNotesRanked(fx.vaultPath, { query: "kubernetes networking", folder: "work" });
  assert.deepEqual(res.map((r) => r.path).sort(), ["work/net", "work/old"]);
});

test("tags scope ranked search", async () => {
  const res = await searchNotesRanked(fx.vaultPath, { query: "kubernetes networking", tags: ["home"] });
  assert.deepEqual(res.map((r) => r.path), ["home/net"]);
});

test("where scopes ranked search", async () => {
  const res = await searchNotesRanked(fx.vaultPath, { query: "kubernetes networking", where: { status: "active" } });
  assert.deepEqual(res.map((r) => r.path), ["work/net"]);
});

test("filters compose and are still relevance-ordered", async () => {
  const res = await searchNotesRanked(fx.vaultPath, { query: "kubernetes networking", folder: "work" });
  // both work notes match; results carry scores and are sorted desc
  assert.equal(res.length, 2);
  assert.ok(res[0].score >= res[1].score);
});

test("a filter matching zero notes returns []", async () => {
  const res = await searchNotesRanked(fx.vaultPath, { query: "kubernetes", folder: "nonexistent" });
  assert.deepEqual(res, []);
});

test("no filter is unchanged (all matches ranked)", async () => {
  const res = await searchNotesRanked(fx.vaultPath, { query: "kubernetes networking" });
  assert.equal(res.length, 3);
});

test("empty tags array is rejected", async () => {
  await assert.rejects(
    () => searchNotesRanked(fx.vaultPath, { query: "x", tags: [] }),
    /tags must be a non-empty array/,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/search-ranked-scoped.test.ts`
Expected: FAIL — `folder`/`tags`/`where` are not accepted (TypeScript may error, or the filters are ignored so `folder` returns all 3 notes).

- [ ] **Step 3: Extend the types**

In `src/types.ts`, replace the `RankedSearchParams` interface (lines 201–207) with:

```typescript
export interface RankedSearchParams {
  /** Free-text query; ranked by BM25 relevance. */
  query: string;
  /** Maximum number of results to return. Default: 10. */
  limit?: number;
  /** Restrict to notes under this folder (relative to the vault root). */
  folder?: string;
  /** Restrict to notes carrying these tags (leading '#' optional). */
  tags?: string[];
  /** Semantics of `tags`: "any" (default) or "all". */
  match?: "any" | "all";
  /** Restrict to notes whose frontmatter satisfies these conditions (query_notes syntax). */
  where?: Record<string, Condition>;
}
```

`Condition` is already imported at the top of `src/types.ts` (`import type { Condition } from "./tools/property-match.js";`).

- [ ] **Step 4: Rewrite searchNotesRanked to resolve candidates**

Replace `src/tools/search-ranked.ts` with:

```typescript
import { getIndex } from "./vault-index.js";
import { assertVaultPath } from "./vault.js";
import { RankedSearchParams, RankedSearchResult } from "../types.js";
import { resolveCandidates, validateCandidateFilter } from "./candidate-filter.js";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

/**
 * Rank vault notes by BM25 relevance to a free-text query, optionally scoped
 * to a candidate set by folder / tags / where (same filters as search_notes).
 * Complements the regex/substring `searchNotes` (ripgrep) tool.
 */
export async function searchNotesRanked(
  vaultPath: string,
  params: RankedSearchParams
): Promise<RankedSearchResult[]> {
  assertVaultPath(vaultPath);
  const { query, limit, folder, tags, where, match } = params;

  if (!query || typeof query !== "string" || !query.trim()) {
    throw new Error("query must be a non-empty string");
  }
  if (query.length > 1000) {
    throw new Error("query too long (max 1000 characters)");
  }

  let effectiveLimit = DEFAULT_LIMIT;
  if (limit !== undefined) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error("limit must be a positive integer");
    }
    effectiveLimit = Math.min(limit, MAX_LIMIT);
  }

  const index = await getIndex(vaultPath);

  const hasFilter = folder !== undefined || tags !== undefined || where !== undefined;
  if (!hasFilter) {
    return index.searchRanked(query, effectiveLimit);
  }

  validateCandidateFilter({ tags, where, match });
  const entries = resolveCandidates(index, {
    folder,
    tags,
    where,
    tagMatch: match ?? "any",
    whereMatch: "all", // mirror search_notes: match governs only tags
  });
  if (entries.length === 0) return [];

  const allowedIds = new Set(entries.map((e) => e.path));
  return index.searchRanked(query, effectiveLimit, allowedIds);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx tsx --test tests/search-ranked-scoped.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/tools/search-ranked.ts tests/search-ranked-scoped.test.ts
git commit -m "feat: search_notes_ranked accepts folder/tags/where/match filters"
```

---

### Task 5: Expose the filters on the MCP tool schema

**Files:**
- Modify: `src/index.ts:143-160` (the `search_notes_ranked` tool registration)

**Interfaces:**
- Consumes: nothing new. The handler at `src/index.ts:707` already passes `args as RankedSearchParams` straight through, so extra fields flow to `searchNotesRanked` without handler changes.
- Produces: agent-visible `folder`/`tags`/`match`/`where` inputs on `search_notes_ranked`.

- [ ] **Step 1: Update the tool schema**

In `src/index.ts`, replace the `search_notes_ranked` `inputSchema.properties` block (currently just `query` and `limit`, lines ~146–159) so it reads:

```typescript
        description:
          "Full-text search ranked by BM25 relevance, optionally scoped by folder, tags, or a frontmatter where filter. Returns the most relevant notes first (title/heading/tag matches boosted), each with a relevance score and a matched snippet. Complements search_notes (which is literal/regex, unranked).",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Free-text query (max 1000 chars). Multi-word queries are ranked by relevance.",
            },
            limit: {
              type: "number",
              description: "Maximum number of results (default: 10, max: 100).",
            },
            folder: { type: "string", description: "Restrict to notes under this folder (relative to the vault root)." },
            tags: { type: "array", items: { type: "string" }, description: "Restrict to notes carrying these tags (leading '#' optional)." },
            match: { type: "string", enum: ["any", "all"], description: "Semantics of tags: 'any' (default) or 'all'." },
            where: { type: "object", description: "Restrict to notes whose frontmatter satisfies these conditions (query_notes syntax)." },
          },
          required: ["query"],
        },
```

- [ ] **Step 2: Build to verify the schema compiles**

Run: `npm run build`
Expected: `tsc` completes with no errors.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: expose ranked-search filters on the MCP tool schema"
```

---

### Task 6: Wire filter flags into the query CLI

**Files:**
- Modify: `src/query-cli.ts:191-199` (the `search-ranked` command)

**Interfaces:**
- Consumes: `searchNotesRanked` via `queryTool("search_notes_ranked", args)`.
- Produces: `search-ranked` CLI flags `--folder`, `--tag` (repeatable), `--match`, `--where <json>`, mirroring the existing `search` command.

- [ ] **Step 1: Update the search-ranked command**

In `src/query-cli.ts`, replace the `search-ranked` command block (lines 191–199) with:

```typescript
  .command("search-ranked <query>")
  .description("BM25 relevance-ranked full-text search, optionally scoped by folder/tags/where")
  .option("-l, --limit <n>", "Maximum number of results (default: 10, max: 100)")
  .option("--folder <folder>", "Restrict to notes under this folder")
  .option("--tag <tag...>", "Restrict to notes with these tags (repeatable)")
  .option("--match <mode>", "tags match mode: any (default) or all")
  .option("--where <json>", "Frontmatter filter as JSON")
  .action(async (query: string, options: any, command: Command) => {
    const verbose = command.parent?.opts().verbose ?? false;
    const args: any = { query };
    if (options.limit !== undefined) args.limit = parseInt(options.limit, 10);
    if (options.folder !== undefined) args.folder = options.folder;
    if (options.tag) args.tags = options.tag; // commander collects repeated --tag into an array
    if (options.match !== undefined) args.match = options.match;
    if (options.where !== undefined) {
      try {
        args.where = JSON.parse(options.where);
      } catch (e) {
        console.error("Error:", "Invalid --where JSON: " + (e instanceof Error ? e.message : String(e)));
        process.exit(1);
      }
    }
    await queryTool("search_notes_ranked", args, verbose);
  });
```

- [ ] **Step 2: Verify the CLI runs against the test vault**

Build first, then run the scoped command against a folder and confirm it returns only in-scope notes:

Run:
```bash
npm run build && OBSIDIAN_VAULT_PATH=$(mktemp -d) sh -c '
  mkdir -p "$OBSIDIAN_VAULT_PATH/work" "$OBSIDIAN_VAULT_PATH/home"
  printf -- "---\ntags: [work]\n---\n# Net\nkubernetes networking\n" > "$OBSIDIAN_VAULT_PATH/work/a.md"
  printf -- "# Home\nkubernetes networking\n" > "$OBSIDIAN_VAULT_PATH/home/b.md"
  npm run query -- search-ranked "kubernetes networking" --folder work
'
```
Expected: JSON output containing `work/a` and NOT `home/b`.

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: all tests pass (previous count + the new files).

- [ ] **Step 4: Commit**

```bash
git add src/query-cli.ts
git commit -m "feat: search-ranked CLI accepts --folder/--tag/--match/--where"
```

---

### Task 7: Migrate search_notes to the shared resolver

**Files:**
- Modify: `src/tools/search.ts:92-136` (the inline filter block)
- Test: existing `tests/search-filter.test.ts` must stay green (regression guard).

**Interfaces:**
- Consumes: `resolveCandidates`, `validateCandidateFilter` from `./candidate-filter.js`.
- Produces: no interface change; `searchNotes` behavior is identical.

- [ ] **Step 1: Confirm the existing filter suite is green (baseline)**

Run: `npx tsx --test tests/search-filter.test.ts`
Expected: PASS. Note the test count — it must be unchanged after this task.

- [ ] **Step 2: Replace the inline filter block**

In `src/tools/search.ts`, add the import near the top (after the existing `matchesWhere` import):

```typescript
import { resolveCandidates, validateCandidateFilter } from "./candidate-filter.js";
```

Then replace the candidate-resolution block (lines 92–136, from `const hasFilter = ...` through the zero-candidate `return`) with:

```typescript
  const hasFilter = folder !== undefined || tags !== undefined || where !== undefined;
  let candidatePaths: string[] | null = null; // null = whole-vault (no filter)

  if (hasFilter) {
    validateCandidateFilter({ tags, where, match });

    const index = await getIndex(vaultPath);
    const matched = resolveCandidates(index, {
      folder,
      tags,
      where: where as Record<string, Condition> | undefined,
      tagMatch: match,
      whereMatch: "all", // search_notes: match governs only tags
    });

    candidatePaths = matched.map((e) => e.fullPath);

    // Zero-candidate guard: never fall through to a whole-vault rg (which would
    // search the cwd given no path args). Return the empty result directly.
    if (candidatePaths.length === 0) {
      return { results: [], truncated: false, files_returned: 0, files_omitted: 0, matches_capped_in: [] };
    }
  }
```

The now-unused `matchesWhere` / `Condition` imports: keep `Condition` (still referenced in the cast above); remove the `matchesWhere` import line if nothing else in the file uses it. Verify with `grep -n matchesWhere src/tools/search.ts` — if the only hit is the import, delete that import.

- [ ] **Step 3: Run the filter suite + build**

Run: `npx tsx --test tests/search-filter.test.ts && npm run build`
Expected: PASS with the SAME test count as Step 1; build clean.

- [ ] **Step 4: Commit**

```bash
git add src/tools/search.ts
git commit -m "refactor: search_notes uses shared resolveCandidates"
```

---

### Task 8: Migrate bulk_edit's filter step to the shared resolver

**Files:**
- Modify: `src/tools/bulk.ts:141-159` (the filter-application portion of `resolveSelection`)
- Test: existing `tests/bulk.test.ts` must stay green (regression guard).

**Interfaces:**
- Consumes: `resolveCandidates` from `./candidate-filter.js`.
- Produces: no interface change. Note: bulk keeps its own `paths`-vs-filter branching, its own error messages (`select.where must be...`, `select requires...`), and its own `limit` handling. Only the folder/tags/where *application* is delegated. bulk passes `tagMatch = match, whereMatch = match` (bulk's `match` governs both).

- [ ] **Step 1: Confirm the bulk suite is green (baseline)**

Run: `npx tsx --test tests/bulk.test.ts`
Expected: PASS. Note the test count.

- [ ] **Step 2: Delegate the filter application**

In `src/tools/bulk.ts`, add the import (near the existing `matchesWhere` import):

```typescript
import { resolveCandidates } from "./candidate-filter.js";
```

Then, inside `resolveSelection`, replace the folder/tags/where filter application (lines ~145–159, the three `entries = entries.filter(...)` blocks for folder, where, and tags) with a single call. The surrounding code — `const match = select.match ?? "all"`, `const index = await getIndex(...)`, and the subsequent `limit` slice and `return entries.map((e) => e.path)` — stays. Replace from `let entries = index.getEntries();` through the tags filter block with:

```typescript
  let entries = resolveCandidates(index, {
    folder: select.folder,
    where: select.where,
    tags: Array.isArray(select.tags) && select.tags.length > 0 ? select.tags : undefined,
    tagMatch: match,   // bulk: match governs both tags...
    whereMatch: match, // ...and where
  });
```

Leave the `const match = select.match ?? "all";` and `const index = await getIndex(vaultPath);` lines above it, and the `if (select.limit !== undefined) { ... }` slice and `return entries.map((e) => e.path);` below it, unchanged.

After the edit, `matchesWhere` may be unused in bulk.ts — run `grep -n matchesWhere src/tools/bulk.ts`; if the only hit is the import, remove it (keep the `Condition` import if still referenced elsewhere in the file).

- [ ] **Step 3: Run the bulk suite + build**

Run: `npx tsx --test tests/bulk.test.ts && npm run build`
Expected: PASS with the SAME test count as Step 1; build clean.

- [ ] **Step 4: Commit**

```bash
git add src/tools/bulk.ts
git commit -m "refactor: bulk_edit filter uses shared resolveCandidates"
```

---

### Task 9: Documentation

**Files:**
- Modify: `CLAUDE.md` (the `search_notes_ranked` section + a CLI example)
- Modify: `README.md` (matching ranked-search section)

**Interfaces:** none (docs only).

- [ ] **Step 1: Update CLAUDE.md**

In the `### search_notes_ranked` section of `CLAUDE.md`, extend the **Input** list to include the filters. Add these bullets after the `limit` bullet:

```markdown
  - `folder` (optional): Restrict to notes under this folder (relative to the vault root)
  - `tags` (optional): Restrict to notes carrying these tags (leading `#` optional)
  - `match` (optional): Semantics of `tags` — `"any"` (default) or `"all"`
  - `where` (optional): Restrict to notes whose frontmatter satisfies these conditions (same syntax as `query_notes`)
```

Add a sentence to the **Ranking**/description noting composability, e.g. append to the purpose line:

```markdown
Scopes to a candidate set via the same `folder`/`tags`/`where`/`match` filters as `search_notes` (resolved from the shared index first, then ranked over just those notes), so "the most relevant note about X among my work notes" is expressible.
```

In the Testing section, update the ranked CLI example to show a scoped call:

```bash
npm run query -- search-ranked "kubernetes networking" --limit 5   # BM25 ranked
npm run query -- search-ranked "kubernetes" --folder work --tag active --match all   # scoped ranked
npm run query -- search-ranked "kubernetes" --where '{"status":"active"}'            # scoped by frontmatter
```

- [ ] **Step 2: Update README.md**

Find the ranked-search section in `README.md` (search for `search_notes_ranked`) and apply the same input additions and composability note so the two files stay in sync. Add the same two scoped CLI examples if the README lists CLI usage for ranked search.

- [ ] **Step 3: Verify docs mention every new input**

Run: `grep -n "folder\|tags\|where\|match" CLAUDE.md | grep -i rank` is not reliable; instead eyeball the `search_notes_ranked` section in both files and confirm all four filters + the composability note are present.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: document scoped ranked search in CLAUDE.md and README.md"
```

---

### Task 10: Full-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Run the entire suite**

Run: `npm test`
Expected: all tests pass, zero failures. Baseline before this work was 244 passing; expect 244 + the new tests (candidate-filter: 8, bm25-scoped: 4, search-ranked additions: 2, search-ranked-scoped: 7 → ~265+).

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: clean `tsc` compile.

- [ ] **Step 3: Confirm no behavior regression in migrated tools**

Run: `npx tsx --test tests/search-filter.test.ts tests/bulk.test.ts tests/search.test.ts`
Expected: PASS — proves the extraction changed no observable behavior.

---

## Self-Review

**Spec coverage:**
- Filter inside BM25 (`allowedIds`) → Task 2. ✓
- Mirror `search_notes` filter surface → Task 4 (types), Task 5 (MCP schema), Task 6 (CLI). ✓
- Shared `resolveCandidates` + `validateCandidateFilter` → Task 1; consumed by search-ranked (4), search_notes (7), bulk_edit (8). ✓
- Per-field `tagMatch`/`whereMatch` → Task 1 signature; search passes `whereMatch:"all"` (7), bulk passes `whereMatch:match` (8). ✓
- Correct top-N over candidates → Task 2 Step 1 test "top-N is taken from candidates". ✓
- Zero-candidate → `[]` → Task 3 (index), Task 4 (tool) tests. ✓
- No-filter unchanged → Task 4 "no filter is unchanged" + Task 10 Step 3 regression. ✓
- Docs in both files → Task 9. ✓
- CLI flags wired → Task 6. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every command has expected output.

**Type consistency:** `resolveCandidates(index, CandidateFilter)` and `validateCandidateFilter({tags, where, match})` used identically in Tasks 1/4/7/8. `BM25.search(tokens, limit, allowedIds?)` defined in Task 2, consumed in Task 3. `searchRanked(query, limit, allowedIds?)` defined in Task 3, consumed in Task 4. `docId === entry.path` and allowed-id sets built from `.path`; ripgrep candidates built from `.fullPath` — consistent throughout.
