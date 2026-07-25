# BM25 Ranked Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `search_notes_ranked` MCP tool that returns vault notes ranked by BM25 relevance, built on the existing in-memory `VaultIndex`, without replacing the ripgrep `search_notes` tool.

**Architecture:** A pure tokenizer (lowercase + stopwords + Porter stemming) and a pure BM25 ranker live in `src/tools/text/`. `VaultIndex` tokenizes each note once during its incremental refresh (storing only the token stream, not raw body) and rebuilds a BM25 instance from those tokens. A new `searchRanked` method queries it; snippets are read from the top-N winning files at query time. The tool is wired into the MCP server and the query CLI.

**Tech Stack:** TypeScript (ESM, NodeNext), `gray-matter`, Node's built-in `node:test` runner via `tsx`. No new dependencies.

## Global Constraints

- Node.js **>= 18**; ESM modules; relative imports use the `.js` extension (e.g. `import { tokenize } from "./text/tokenize.js"`).
- **No new npm dependencies** — the Porter stemmer is hand-written pure JS.
- Tests use `node:test` + `node:assert/strict`, run with `npm test` (`tsx --test tests/*.test.ts`). Integration tests build throwaway vaults via `makeVault` / `Fixture` from `tests/fixtures.ts`.
- `search_notes_ranked` is a **read** tool: always exposed in `list_tools`, never gated by `OBSIDIAN_ALLOW_WRITES`, and NOT added to `isWriteTool`.
- The existing `search_notes` (ripgrep) tool is **unchanged**.
- BM25 constants: `k1 = 1.2`, `b = 0.75`.
- Result shape ordered by `score` descending, ties broken by `path` ascending.
- When you change tool behavior, update **both** `CLAUDE.md` and `README.md`.

---

### Task 1: Tokenizer with Porter stemming

**Files:**
- Create: `src/tools/text/tokenize.ts`
- Test: `tests/tokenize.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export function stem(word: string): string` — Porter-stemmed form of a single lowercase word.
  - `export function tokenize(text: string): string[]` — lowercase → split on non-`[a-z0-9]` → drop stopwords → stem. May contain duplicates. Order preserved.

- [ ] **Step 1: Write the failing tests**

Create `tests/tokenize.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenize, stem } from "../src/tools/text/tokenize.js";

test("lowercases and splits on punctuation and whitespace", () => {
  assert.deepEqual(tokenize("Hello, World!"), ["hello", "world"]);
});

test("drops common stopwords", () => {
  // "the", "of", "a" are stopwords; "kubernetes"/"networking" survive (stemmed).
  assert.deepEqual(tokenize("the state of a kubernetes networking"), [
    "kubernet",
    "network",
  ]);
});

test("stems inflected forms to a shared root", () => {
  assert.equal(stem("running"), stem("run"));
  assert.equal(stem("tested"), stem("test"));
  assert.equal(stem("tests"), stem("test"));
});

test("query and document tokenization agree", () => {
  assert.deepEqual(tokenize("Running Tests"), tokenize("run a test"));
});

test("returns an empty array for empty or symbol-only input", () => {
  assert.deepEqual(tokenize(""), []);
  assert.deepEqual(tokenize("--- ###"), []);
});

test("keeps digits and alphanumerics", () => {
  assert.deepEqual(tokenize("k8s cluster1"), ["k8s", "cluster1"]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test tests/tokenize.test.ts`
Expected: FAIL — cannot find module `../src/tools/text/tokenize.js`.

- [ ] **Step 3: Implement the tokenizer and stemmer**

Create `src/tools/text/tokenize.ts`. Use a compact, correct Porter stemmer (the classic algorithm). A small, well-known pure-JS implementation:

```typescript
/**
 * Text normalization shared by BM25 indexing and querying. The SAME function
 * must process documents and queries so their token streams line up.
 * Pipeline: lowercase -> split on non-alphanumeric -> drop stopwords -> stem.
 */

// A small, deliberately conservative English stopword set. Kept short so we
// remove only high-frequency function words, never content terms.
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "if", "in",
  "into", "is", "it", "no", "not", "of", "on", "or", "such", "that", "the",
  "their", "then", "there", "these", "they", "this", "to", "was", "will",
  "with", "from", "we", "you", "your",
]);

/**
 * Porter stemmer (Martin Porter's 1980 algorithm). Pure, dependency-free.
 * Reduces English inflections to a common root so "running"/"ran"/"runs"
 * (approximately) share a stem. Operates on a single lowercase word.
 */
export function stem(word: string): string {
  if (word.length < 3) return word;

  const isConsonant = (w: string, i: number): boolean => {
    const c = w[i];
    if (c === "a" || c === "e" || c === "i" || c === "o" || c === "u") return false;
    if (c === "y") return i === 0 ? true : !isConsonant(w, i - 1);
    return true;
  };
  const measure = (w: string): number => {
    let n = 0;
    let prevVowel = false;
    for (let i = 0; i < w.length; i++) {
      const cons = isConsonant(w, i);
      if (!cons) prevVowel = true;
      else if (prevVowel) {
        n++;
        prevVowel = false;
      }
    }
    return n;
  };
  const hasVowel = (w: string): boolean => {
    for (let i = 0; i < w.length; i++) if (!isConsonant(w, i)) return true;
    return false;
  };
  const endsDoubleConsonant = (w: string): boolean =>
    w.length >= 2 &&
    w[w.length - 1] === w[w.length - 2] &&
    isConsonant(w, w.length - 1);
  const cvc = (w: string): boolean => {
    if (w.length < 3) return false;
    const i = w.length - 1;
    if (!isConsonant(w, i) || isConsonant(w, i - 1) || !isConsonant(w, i - 2))
      return false;
    const c = w[i];
    return c !== "w" && c !== "x" && c !== "y";
  };

  let w = word;

  // Step 1a
  if (w.endsWith("sses")) w = w.slice(0, -2);
  else if (w.endsWith("ies")) w = w.slice(0, -2);
  else if (w.endsWith("ss")) { /* keep */ }
  else if (w.endsWith("s")) w = w.slice(0, -1);

  // Step 1b
  let step1bFixup = false;
  if (w.endsWith("eed")) {
    if (measure(w.slice(0, -3)) > 0) w = w.slice(0, -1);
  } else if (w.endsWith("ed") && hasVowel(w.slice(0, -2))) {
    w = w.slice(0, -2);
    step1bFixup = true;
  } else if (w.endsWith("ing") && hasVowel(w.slice(0, -3))) {
    w = w.slice(0, -3);
    step1bFixup = true;
  }
  if (step1bFixup) {
    if (w.endsWith("at") || w.endsWith("bl") || w.endsWith("iz")) w += "e";
    else if (endsDoubleConsonant(w) && !/[lsz]$/.test(w)) w = w.slice(0, -1);
    else if (measure(w) === 1 && cvc(w)) w += "e";
  }

  // Step 1c
  if (w.endsWith("y") && hasVowel(w.slice(0, -1))) w = w.slice(0, -1) + "i";

  const replaceSuffix = (
    pairs: [string, string][],
    minMeasure: number
  ): void => {
    for (const [suf, rep] of pairs) {
      if (w.endsWith(suf)) {
        const stemPart = w.slice(0, w.length - suf.length);
        if (measure(stemPart) > minMeasure) w = stemPart + rep;
        return;
      }
    }
  };

  // Step 2
  replaceSuffix(
    [
      ["ational", "ate"], ["tional", "tion"], ["enci", "ence"], ["anci", "ance"],
      ["izer", "ize"], ["abli", "able"], ["alli", "al"], ["entli", "ent"],
      ["eli", "e"], ["ousli", "ous"], ["ization", "ize"], ["ation", "ate"],
      ["ator", "ate"], ["alism", "al"], ["iveness", "ive"], ["fulness", "ful"],
      ["ousness", "ous"], ["aliti", "al"], ["iviti", "ive"], ["biliti", "ble"],
    ],
    0
  );

  // Step 3
  replaceSuffix(
    [
      ["icate", "ic"], ["ative", ""], ["alize", "al"], ["iciti", "ic"],
      ["ical", "ic"], ["ful", ""], ["ness", ""],
    ],
    0
  );

  // Step 4
  const step4 = [
    "al", "ance", "ence", "er", "ic", "able", "ible", "ant", "ement",
    "ment", "ent", "ou", "ism", "ate", "iti", "ous", "ive", "ize",
  ];
  for (const suf of step4) {
    if (w.endsWith(suf)) {
      const stemPart = w.slice(0, w.length - suf.length);
      if (measure(stemPart) > 1) {
        if (suf === "ion") {
          if (/[st]$/.test(stemPart)) w = stemPart;
        } else {
          w = stemPart;
        }
      }
      break;
    }
  }
  // "ion" handled separately (needs preceding s/t).
  if (w.endsWith("ion")) {
    const stemPart = w.slice(0, -3);
    if (measure(stemPart) > 1 && /[st]$/.test(stemPart)) w = stemPart;
  }

  // Step 5a
  if (w.endsWith("e")) {
    const stemPart = w.slice(0, -1);
    const m = measure(stemPart);
    if (m > 1 || (m === 1 && !cvc(stemPart))) w = stemPart;
  }
  // Step 5b
  if (measure(w) > 1 && endsDoubleConsonant(w) && w.endsWith("l"))
    w = w.slice(0, -1);

  return w;
}

/** Tokenize text into normalized, stemmed terms (duplicates preserved). */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!raw) continue;
    if (STOPWORDS.has(raw)) continue;
    out.push(stem(raw));
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test tests/tokenize.test.ts`
Expected: PASS (6 tests). If a specific stem assertion in `tests/tokenize.test.ts` disagrees with the stemmer's actual output for an *inflected pair* (the tests only assert that inflections of the same word share a stem, never a specific stem string), the stemmer is correct — do not weaken the stemmer to match a guessed string.

- [ ] **Step 5: Commit**

```bash
git add src/tools/text/tokenize.ts tests/tokenize.test.ts
git commit -m "feat: add stemming tokenizer for full-text search"
```

---

### Task 2: Pure BM25 ranker

**Files:**
- Create: `src/tools/text/bm25.ts`
- Test: `tests/bm25.test.ts`

**Interfaces:**
- Consumes: nothing (operates on already-tokenized input).
- Produces:
  - `export interface BM25Hit { docId: string; score: number }`
  - `export class BM25` with:
    - `add(docId: string, tokens: string[]): void` — register a document's token stream. Call once per doc before `finalize`.
    - `finalize(): void` — compute average document length; freezes corpus stats. Idempotent.
    - `search(queryTokens: string[], limit: number): BM25Hit[]` — score docs containing ≥1 query term, sorted by score desc, ties by `docId` asc, truncated to `limit`.
    - `get size(): number` — number of documents added.

- [ ] **Step 1: Write the failing tests**

Create `tests/bm25.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { BM25 } from "../src/tools/text/bm25.js";

function build(docs: Record<string, string[]>): BM25 {
  const idx = new BM25();
  for (const [id, toks] of Object.entries(docs)) idx.add(id, toks);
  idx.finalize();
  return idx;
}

test("ranks the document with more query-term hits higher", () => {
  const idx = build({
    a: ["cat", "cat", "cat", "dog"],
    b: ["cat", "dog", "dog"],
    c: ["fish"],
  });
  const hits = idx.search(["cat"], 10);
  assert.equal(hits[0].docId, "a");
  assert.ok(hits.find((h) => h.docId === "b"));
  assert.ok(!hits.find((h) => h.docId === "c")); // no query term -> excluded
});

test("a rarer term contributes more via IDF", () => {
  const idx = build({
    a: ["common", "rare"],
    b: ["common"],
    c: ["common"],
    d: ["common"],
  });
  // 'rare' appears in 1 of 4 docs; 'common' in all 4. A doc matching 'rare'
  // should score higher than one matching only 'common'.
  const rareHit = idx.search(["rare"], 10)[0];
  const commonHit = idx.search(["common"], 10)[0];
  assert.ok(rareHit.score > commonHit.score);
});

test("empty query or no match returns an empty array", () => {
  const idx = build({ a: ["cat"] });
  assert.deepEqual(idx.search([], 10), []);
  assert.deepEqual(idx.search(["zebra"], 10), []);
});

test("respects the limit", () => {
  const idx = build({
    a: ["x"],
    b: ["x"],
    c: ["x"],
  });
  assert.equal(idx.search(["x"], 2).length, 2);
});

test("breaks score ties by docId ascending for determinism", () => {
  const idx = build({
    zeta: ["x"],
    alpha: ["x"],
    mid: ["x"],
  });
  // Identical single-token docs => identical scores => docId order.
  const hits = idx.search(["x"], 10);
  assert.deepEqual(
    hits.map((h) => h.docId),
    ["alpha", "mid", "zeta"]
  );
});

test("multi-term query sums per-term contributions", () => {
  const idx = build({
    a: ["cat", "dog"],
    b: ["cat"],
  });
  const hits = idx.search(["cat", "dog"], 10);
  assert.equal(hits[0].docId, "a"); // matches both terms
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test tests/bm25.test.ts`
Expected: FAIL — cannot find module `../src/tools/text/bm25.js`.

- [ ] **Step 3: Implement BM25**

Create `src/tools/text/bm25.ts`:

```typescript
/**
 * A pure, filesystem-agnostic BM25 ranker. Documents are added as already-
 * tokenized term streams; scoring is standard Okapi BM25. Holds only derived
 * counts (term frequencies, document frequencies, lengths) — never raw text.
 */

const K1 = 1.2;
const B = 0.75;

export interface BM25Hit {
  docId: string;
  score: number;
}

interface DocStats {
  /** term -> occurrences in this document */
  tf: Map<string, number>;
  /** total token count of this document */
  length: number;
}

export class BM25 {
  private docs = new Map<string, DocStats>();
  /** term -> number of documents containing it */
  private df = new Map<string, number>();
  /** term -> list of docIds containing it (postings) */
  private postings = new Map<string, string[]>();
  private avgdl = 0;
  private finalized = false;

  add(docId: string, tokens: string[]): void {
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    this.docs.set(docId, { tf, length: tokens.length });
    for (const term of tf.keys()) {
      this.df.set(term, (this.df.get(term) ?? 0) + 1);
      const list = this.postings.get(term) ?? [];
      list.push(docId);
      this.postings.set(term, list);
    }
    this.finalized = false;
  }

  finalize(): void {
    let total = 0;
    for (const d of this.docs.values()) total += d.length;
    this.avgdl = this.docs.size > 0 ? total / this.docs.size : 0;
    this.finalized = true;
  }

  get size(): number {
    return this.docs.size;
  }

  search(queryTokens: string[], limit: number): BM25Hit[] {
    if (!this.finalized) this.finalize();
    if (queryTokens.length === 0 || this.docs.size === 0) return [];

    const N = this.docs.size;
    const scores = new Map<string, number>();
    // Score only documents that appear in some query term's postings list.
    const queryTerms = new Set(queryTokens);

    for (const term of queryTerms) {
      const df = this.df.get(term);
      if (!df) continue; // term not in corpus
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      for (const docId of this.postings.get(term)!) {
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
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test tests/bm25.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tools/text/bm25.ts tests/bm25.test.ts
git commit -m "feat: add pure BM25 ranker"
```

---

### Task 3: All-headings helper + boosted tokens on IndexEntry

**Files:**
- Modify: `src/tools/vault.ts` (add `allHeadings` helper after `firstHeading`, near line 222)
- Modify: `src/tools/vault-index.ts` (add `tokens` to `IndexEntry`, populate in `buildEntry`)
- Test: `tests/index-tokens.test.ts` (create)

**Interfaces:**
- Consumes: `tokenize` (Task 1); `collectTags`, `firstHeading` (existing in `vault.ts`).
- Produces:
  - `export function allHeadings(content: string): string[]` in `vault.ts` — every markdown heading's text, in document order (may be empty).
  - `IndexEntry.tokens: string[]` — the BM25 token stream: body tokens plus title, every heading, and every tag tokenized and appended **one extra time** (×2 weight) for field boost.

- [ ] **Step 1: Write the failing test**

Create `tests/index-tokens.test.ts`:

```typescript
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { getIndex } from "../src/tools/vault-index.js";
import { allHeadings } from "../src/tools/vault.js";
import { makeVault, Fixture } from "./fixtures.js";

test("allHeadings returns every heading in order", () => {
  const md = "# One\n\nbody\n\n## Two\n\n### Three\n";
  assert.deepEqual(allHeadings(md), ["One", "Two", "Three"]);
});

test("allHeadings is empty when there are no headings", () => {
  assert.deepEqual(allHeadings("just a paragraph"), []);
});

let fx: Fixture;
before(async () => {
  fx = await makeVault([
    {
      path: "note.md",
      content: [
        "---",
        "title: Kubernetes Networking",
        "tags: [infra]",
        "---",
        "# Overview",
        "The pod talks to the service.",
      ].join("\n"),
    },
  ]);
});
after(() => fx.cleanup());

test("index entry carries a boosted token stream", async () => {
  const idx = await getIndex(fx.vaultPath);
  const entry = idx.getEntry("note")!;
  assert.ok(Array.isArray(entry.tokens));
  // Body word present.
  assert.ok(entry.tokens.includes("pod"));
  // Title token 'network' (stemmed) appears at least twice: once from the
  // title's ×2 boost injection (title is not in the body here).
  const netCount = entry.tokens.filter((t) => t === "network").length;
  assert.ok(netCount >= 2, `expected boosted title token, got ${netCount}`);
  // Tag token present.
  assert.ok(entry.tokens.includes("infra"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/index-tokens.test.ts`
Expected: FAIL — `allHeadings` is not exported / `entry.tokens` is undefined.

- [ ] **Step 3a: Add `allHeadings` to `vault.ts`**

In `src/tools/vault.ts`, immediately after the `firstHeading` function (ends near line 222), add:

```typescript
/** Extract every markdown heading (`# ...` through `###### ...`) in order. */
export function allHeadings(content: string): string[] {
  const out: string[] = [];
  const re = /^#{1,6}\s+(.+?)\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) out.push(m[1].trim());
  return out;
}
```

- [ ] **Step 3b: Add `tokens` to `IndexEntry` and populate it**

In `src/tools/vault-index.ts`:

Add the import (top of file, alongside the existing `./vault.js` import — add `allHeadings`):

```typescript
import {
  walkVault,
  collectTags,
  extractLinkTargets,
  firstHeading,
  allHeadings,
  assertVaultPath,
  VaultFile,
} from "./vault.js";
import { tokenize } from "./text/tokenize.js";
```

Add the field to the `IndexEntry` interface (after `title: string;`):

```typescript
  /** BM25 token stream: body plus title/headings/tags injected at ×2 weight. */
  tokens: string[];
```

In `buildEntry`, after `title` is finalized and before the `return`, build the tokens. Replace the current `buildEntry` body's tail so headings are captured and tokens computed:

```typescript
  let frontmatter: Record<string, unknown> = {};
  let tags: string[] = [];
  let linkTargets: string[] = [];
  let headline: string | undefined;
  let title = basename(f.path);
  let tokens: string[] = [];

  try {
    const raw = await readFile(f.fullPath, "utf-8");
    const parsed = matter(raw);
    frontmatter = parsed.data as Record<string, unknown>;
    tags = collectTags(frontmatter, parsed.content);
    linkTargets = extractLinkTargets(parsed.content);
    headline = firstHeading(parsed.content);
    if (typeof frontmatter.title === "string" && frontmatter.title.trim()) {
      title = frontmatter.title.trim();
    }
    // BM25 tokens: body once, then boosted fields (title, headings, tags) an
    // extra time so a title/heading/tag hit outranks a passing body mention.
    const boosted = [title, ...allHeadings(parsed.content), ...tags].join(" ");
    tokens = [...tokenize(parsed.content), ...tokenize(boosted)];
  } catch {
    // Unreadable/unparseable note: still indexed by path with fs metadata.
  }

  return {
    path: f.path,
    fullPath: f.fullPath,
    size: f.size,
    mtimeMs: f.mtime.getTime(),
    frontmatter,
    tags,
    linkTargets,
    headline,
    title,
    tokens,
  };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/index-tokens.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the full suite to check nothing regressed**

Run: `npm test`
Expected: PASS (all prior tests + the new ones). The `tokens` field is additive; existing tests ignore it.

- [ ] **Step 6: Commit**

```bash
git add src/tools/vault.ts src/tools/vault-index.ts tests/index-tokens.test.ts
git commit -m "feat: index a boosted token stream per note for BM25"
```

---

### Task 4: BM25 index + `searchRanked` on VaultIndex

**Files:**
- Modify: `src/tools/vault-index.ts` (build BM25 in `rebuildDerived`, add `searchRanked`)
- Modify: `src/types.ts` (add `RankedSearchParams`, `RankedSearchResult`)
- Test: `tests/search-ranked.test.ts` (create)

**Interfaces:**
- Consumes: `BM25` (Task 2), `tokenize` (Task 1), `IndexEntry.tokens` (Task 3), `entryToHeader` (existing), `readFile` + `matter` (existing imports).
- Produces:
  - In `src/types.ts`:
    ```typescript
    export interface RankedSearchParams { query: string; limit?: number; }
    export interface RankedSearchResult extends NoteHeader { score: number; snippet: string; }
    ```
  - `VaultIndex.searchRanked(query: string, limit: number): Promise<RankedSearchResult[]>` — tokenize query, BM25 search, map to headers, attach a snippet read from each winning file. Returns `[]` for an empty/whitespace query.

- [ ] **Step 1: Write the failing test**

Create `tests/search-ranked.test.ts`:

```typescript
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { getIndex } from "../src/tools/vault-index.js";
import { makeVault, Fixture } from "./fixtures.js";
import { writeFile, utimes } from "node:fs/promises";
import { join } from "node:path";

let fx: Fixture;
before(async () => {
  fx = await makeVault([
    {
      path: "k8s.md",
      content: [
        "---",
        "title: Kubernetes Networking",
        "---",
        "# Networking",
        "Pods reach services through the cluster network. Networking is core.",
      ].join("\n"),
    },
    {
      path: "aside.md",
      content: [
        "# Random",
        "This note mentions networking once, in passing.",
      ].join("\n"),
    },
    {
      path: "unrelated.md",
      content: ["# Cooking", "A recipe for soup."].join("\n"),
    },
  ]);
});
after(() => fx.cleanup());

test("ranks the most relevant note first and excludes non-matches", async () => {
  const idx = await getIndex(fx.vaultPath);
  const res = await idx.searchRanked("kubernetes networking", 10);
  assert.equal(res[0].path, "k8s.md".replace(/\.md$/, ""));
  assert.ok(!res.some((r) => r.path === "unrelated"));
  // Scores are descending.
  for (let i = 1; i < res.length; i++) {
    assert.ok(res[i - 1].score >= res[i].score);
  }
});

test("returns note headers with score and snippet", async () => {
  const idx = await getIndex(fx.vaultPath);
  const res = await idx.searchRanked("networking", 10);
  const top = res[0];
  assert.equal(typeof top.score, "number");
  assert.equal(typeof top.snippet, "string");
  assert.ok(top.snippet.length > 0);
  assert.equal(typeof top.title, "string");
  assert.ok(Array.isArray(top.tags));
});

test("respects the limit", async () => {
  const idx = await getIndex(fx.vaultPath);
  const res = await idx.searchRanked("networking", 1);
  assert.equal(res.length, 1);
});

test("empty query returns an empty array", async () => {
  const idx = await getIndex(fx.vaultPath);
  assert.deepEqual(await idx.searchRanked("   ", 10), []);
});

test("reflects edits after refresh", async () => {
  // Add a strong 'networking' signal to the previously-unrelated note.
  const full = join(fx.vaultPath, "unrelated.md");
  await writeFile(
    full,
    "# Networking Networking\nnetworking networking networking cluster",
    "utf-8"
  );
  await utimes(full, new Date(), new Date());
  const idx = await getIndex(fx.vaultPath); // getIndex refreshes
  const res = await idx.searchRanked("networking", 10);
  assert.ok(res.some((r) => r.path === "unrelated"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/search-ranked.test.ts`
Expected: FAIL — `idx.searchRanked` is not a function.

- [ ] **Step 3a: Add the types**

In `src/types.ts`, append:

```typescript
export interface RankedSearchParams {
  /** Free-text query; ranked by BM25 relevance. */
  query: string;
  /** Maximum number of results to return. Default: 10. */
  limit?: number;
}

/** A ranked search hit: a note header plus its relevance score and a snippet. */
export interface RankedSearchResult extends NoteHeader {
  /** BM25 relevance score (higher = more relevant). */
  score: number;
  /** Short excerpt around a matched term (best-effort). */
  snippet: string;
}
```

- [ ] **Step 3b: Build the BM25 index and add `searchRanked`**

In `src/tools/vault-index.ts`:

Add imports at the top:

```typescript
import { BM25 } from "./text/bm25.js";
import { RankedSearchResult } from "../types.js";
```

(Keep the existing `entryToHeader` export and `NoteHeader` import as-is.)

Add a private field to the class alongside the other maps:

```typescript
  private bm25 = new BM25();
```

At the **end** of `rebuildDerived()` (after the backlink sort loop), build the BM25 index from the cached per-note tokens:

```typescript
    // Rebuild the BM25 index from cached per-note tokens. Unchanged notes were
    // not re-tokenized (their tokens come straight from the cached entry), so
    // this only re-aggregates corpus statistics — cheap relative to file I/O.
    this.bm25 = new BM25();
    for (const e of this.entries.values()) {
      this.bm25.add(e.path, e.tokens);
    }
    this.bm25.finalize();
```

Add the `searchRanked` method (after `outbound`, before the closing brace of the class). It needs `readFile` and `matter`, which are already imported at the top of the file:

```typescript
  /**
   * Rank notes by BM25 relevance to a free-text query. Snippets are read from
   * the ≤ limit winning files at query time (never stored in the index).
   */
  async searchRanked(query: string, limit: number): Promise<RankedSearchResult[]> {
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];
    const hits = this.bm25.search(queryTokens, limit);

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

  /** Best-effort snippet: first body line containing a query word, else first body line. */
  private async buildSnippet(fullPath: string, rawWords: string[]): Promise<string> {
    let body: string;
    try {
      const raw = await readFile(fullPath, "utf-8");
      body = matter(raw).content;
    } catch {
      return "";
    }
    const lines = body
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const clip = (s: string): string => (s.length > 200 ? s.slice(0, 200) + "…" : s);
    for (const line of lines) {
      const lower = line.toLowerCase();
      if (rawWords.some((w) => lower.includes(w))) return clip(line);
    }
    return lines.length > 0 ? clip(lines[0]) : "";
  }
```

Note: `tokenize` must be imported in this file (added in Task 3, Step 3b). If it is not yet imported, add `import { tokenize } from "./text/tokenize.js";`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/search-ranked.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tools/vault-index.ts src/types.ts tests/search-ranked.test.ts
git commit -m "feat: add BM25 searchRanked to the vault index"
```

---

### Task 5: `searchNotesRanked` tool wrapper

**Files:**
- Create: `src/tools/search-ranked.ts`
- Test: covered by extending `tests/search-ranked.test.ts` (add a wrapper test)

**Interfaces:**
- Consumes: `getIndex` (existing), `RankedSearchParams`, `RankedSearchResult` (Task 4).
- Produces:
  - `export async function searchNotesRanked(vaultPath: string, params: RankedSearchParams): Promise<RankedSearchResult[]>` — validates input, refreshes the shared index, delegates to `searchRanked`. Default `limit` 10, max 100.

- [ ] **Step 1: Write the failing test**

Append to `tests/search-ranked.test.ts`:

```typescript
import { searchNotesRanked } from "../src/tools/search-ranked.js";

test("searchNotesRanked wrapper validates and returns ranked results", async () => {
  const res = await searchNotesRanked(fx.vaultPath, { query: "networking" });
  assert.ok(res.length > 0);
  assert.equal(typeof res[0].score, "number");
});

test("searchNotesRanked rejects an empty query", async () => {
  await assert.rejects(
    () => searchNotesRanked(fx.vaultPath, { query: "" }),
    /query must be a non-empty string/i
  );
});

test("searchNotesRanked defaults limit to 10 and caps at 100", async () => {
  const res = await searchNotesRanked(fx.vaultPath, { query: "networking", limit: 1000 });
  assert.ok(res.length <= 100);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/search-ranked.test.ts`
Expected: FAIL — cannot find module `../src/tools/search-ranked.js`.

- [ ] **Step 3: Implement the wrapper**

Create `src/tools/search-ranked.ts`:

```typescript
import { getIndex } from "./vault-index.js";
import { RankedSearchParams, RankedSearchResult } from "../types.js";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

/**
 * Rank vault notes by BM25 relevance to a free-text query. Complements the
 * regex/substring `searchNotes` (ripgrep) tool with relevance ordering.
 */
export async function searchNotesRanked(
  vaultPath: string,
  params: RankedSearchParams
): Promise<RankedSearchResult[]> {
  const { query, limit } = params;

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
  return index.searchRanked(query, effectiveLimit);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/search-ranked.test.ts`
Expected: PASS (8 tests total in this file).

- [ ] **Step 5: Commit**

```bash
git add src/tools/search-ranked.ts tests/search-ranked.test.ts
git commit -m "feat: add searchNotesRanked tool wrapper"
```

---

### Task 6: Wire the tool into the MCP server

**Files:**
- Modify: `src/index.ts` (import, `list_tools` entry, `CallTool` dispatch case)

**Interfaces:**
- Consumes: `searchNotesRanked` (Task 5), `RankedSearchParams` (Task 4).
- Produces: MCP tool `search_notes_ranked` (read tool, always exposed).

- [ ] **Step 1: Add the import**

In `src/index.ts`, after `import { searchNotes } from "./tools/search.js";` (line 11), add:

```typescript
import { searchNotesRanked } from "./tools/search-ranked.js";
```

And extend the types import block (`import { SearchNotesParams, ... } from "./types.js";`) to include `RankedSearchParams`:

```typescript
import {
  SearchNotesParams,
  ListNotesParams,
  FindByTagParams,
  RecentNotesParams,
  RelatedNotesParams,
  RankedSearchParams,
} from "./types.js";
```

- [ ] **Step 2: Add the `list_tools` entry**

In the `ListToolsRequestSchema` handler's `tools` array, immediately after the `search_notes` tool object (closes near line 105), add:

```typescript
      {
        name: "search_notes_ranked",
        description:
          "Full-text search ranked by BM25 relevance. Returns the most relevant notes first (title/heading/tag matches boosted), each with a relevance score and a matched snippet. Complements search_notes (which is literal/regex, unranked).",
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
          },
          required: ["query"],
        },
      },
```

- [ ] **Step 3: Add the dispatch case**

In the `CallToolRequestSchema` handler's `switch (name)`, immediately after the `search_notes` case (closes near line 454), add:

```typescript
      case "search_notes_ranked": {
        const params = args as unknown as RankedSearchParams;
        if (!params.query) {
          throw new Error("query is required for search_notes_ranked");
        }
        const results = await searchNotesRanked(VAULT_PATH, params);
        return {
          content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
        };
      }
```

- [ ] **Step 4: Build to verify the server compiles**

Run: `npm run build`
Expected: `tsc` completes with no errors.

- [ ] **Step 5: Smoke-test the tool listing**

Run:
```bash
OBSIDIAN_VAULT_PATH="$(pwd)" node -e "process.env.OBSIDIAN_VAULT_PATH=process.cwd(); import('./dist/index.js');" >/dev/null 2>&1; echo "server module loads: exit $?"
```
Expected: `server module loads: exit 0` (the module imports without throwing).

- [ ] **Step 6: Commit**

```bash
git add src/index.ts
git commit -m "feat: expose search_notes_ranked MCP tool"
```

---

### Task 7: Query CLI subcommand

**Files:**
- Modify: `src/query-cli.ts` (import, dispatch branch, `search-ranked` command)

**Interfaces:**
- Consumes: `searchNotesRanked` (Task 5).
- Produces: `npm run query -- search-ranked "<query>" [--limit N]`.

- [ ] **Step 1: Add the import and dispatch branch**

In `src/query-cli.ts`, after `import { searchNotes } from "./tools/search.js";` (line 6), add:

```typescript
import { searchNotesRanked } from "./tools/search-ranked.js";
```

In the `queryTool` function's `if/else` chain, after the `search_notes` branch (line 49-50), add:

```typescript
    } else if (toolName === "search_notes_ranked") {
      result = await searchNotesRanked(VAULT_PATH!, args);
```

- [ ] **Step 2: Add the commander subcommand**

The commander program is near the bottom of `src/query-cli.ts`. Each command reads `verbose` via `command.parent?.opts().verbose ?? false` and types the action's `command` param as `Command`. Follow that exact style. Immediately after the existing `.command("search")` block (ends near line 134, after `await queryTool("search_notes", args, verbose);`), add:

```typescript
program
  .command("search-ranked <query>")
  .description("BM25 relevance-ranked full-text search")
  .option("-l, --limit <n>", "Maximum number of results (default: 10, max: 100)")
  .action(async (query: string, options: any, command: Command) => {
    const verbose = command.parent?.opts().verbose ?? false;
    const args: any = { query };
    if (options.limit !== undefined) args.limit = parseInt(options.limit, 10);
    await queryTool("search_notes_ranked", args, verbose);
  });
```

`Command` is already imported at the top of `src/query-cli.ts` (`import { Command } from "commander";`). The `parseInt` guard converts commander's string option to the integer `searchNotesRanked` validates.

- [ ] **Step 3: Run the CLI against this repo as a vault**

Run:
```bash
OBSIDIAN_VAULT_PATH="$(pwd)/docs" npm run query -- search-ranked "bm25 ranked search" --limit 3
```
Expected: JSON array of up to 3 results, the design/plan docs ranked first, each with a numeric `score` and a `snippet` string. (Uses the `docs/` folder as a throwaway vault since it contains markdown.)

- [ ] **Step 4: Commit**

```bash
git add src/query-cli.ts
git commit -m "feat: add search-ranked query CLI subcommand"
```

---

### Task 8: Documentation

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`

**Interfaces:** none (docs only).

- [ ] **Step 1: Update `CLAUDE.md`**

In `CLAUDE.md`, add a new tool section immediately after the `### search_notes` block:

```markdown
### search_notes_ranked
- **Purpose**: Full-text search ranked by BM25 relevance — the most relevant notes first, rather than every literal match. Complements `search_notes` (which is literal/regex and unranked).
- **Input**:
  - `query` (required): Free-text query (max 1000 chars). Multi-word queries are ranked by relevance.
  - `limit` (optional): Maximum number of results (default: 10, max: 100)
- **Output**: Array of note headers (same shape as `list_notes`) extended with `score` (BM25 relevance, higher = more relevant) and `snippet` (a short matched excerpt).
- **Ranking**: Standard Okapi BM25 (`k1=1.2`, `b=0.75`) over a stemmed, stopword-filtered token stream. Title, heading, and tag terms are boosted (indexed at ×2 weight) so a title hit outranks a passing body mention. Built on the shared in-memory vault index — no per-query vault scan.
```

Then, in the **Vault index** subsection under Development, add `search_notes_ranked` to the list of index-backed tools, and note the index now also holds a BM25 index. Change the opening sentence's tool list to include it, and append:

```markdown
The index also builds a BM25 full-text index (`src/tools/text/bm25.ts`) from a
stemmed token stream per note (`src/tools/text/tokenize.ts`), rebuilt from cached
per-note tokens on each refresh so only changed files are re-tokenized. This
backs `search_notes_ranked`.
```

Finally, add a CLI example under Testing, after the `search "pattern" --context 10` line:

```markdown
npm run query -- search-ranked "kubernetes networking" --limit 5   # BM25 ranked
```

- [ ] **Step 2: Update `README.md`**

Read `README.md` first to match its structure and tone. Add a `search_notes_ranked` entry wherever the read tools are documented, mirroring the `search_notes` entry's format, describing: BM25 relevance ranking, `query` + `limit` inputs, header + `score` + `snippet` output, and that it complements (does not replace) `search_notes`. If the README lists query-CLI examples, add the `search-ranked` example there too.

Run first: `sed -n '1,80p' README.md` (and more as needed) to find the right insertion points.

- [ ] **Step 3: Verify docs mention the tool consistently**

Run:
```bash
grep -c "search_notes_ranked" CLAUDE.md README.md
```
Expected: both files report ≥ 1.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: document search_notes_ranked tool"
```

---

### Task 9: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Run the entire test suite**

Run: `npm test`
Expected: All tests pass, including `tokenize`, `bm25`, `index-tokens`, `search-ranked`, and every pre-existing test. No failures, no unhandled rejections.

- [ ] **Step 2: Type-check / build**

Run: `npm run build`
Expected: `tsc` exits 0 with no type errors.

- [ ] **Step 3: End-to-end CLI check**

Run:
```bash
OBSIDIAN_VAULT_PATH="$(pwd)/docs" npm run query -- search-ranked "bm25 relevance ranking" --limit 3
```
Expected: JSON results ranked by score, most-relevant doc first, each with `score` and `snippet`.

- [ ] **Step 4: Final commit (if any uncommitted changes remain)**

```bash
git status
# If clean, nothing to do. Otherwise:
git add -A && git commit -m "chore: finalize BM25 ranked search"
```

---

## Self-Review

**Spec coverage:**
- New separate tool `search_notes_ranked` → Tasks 5–6. ✓
- In-memory index on `VaultIndex`, incremental → Tasks 3–4. ✓
- Lowercase + stopwords + Porter stemming → Task 1. ✓
- Index scope body + title + headings + tags → Task 3 (boosted token stream). ✓
- Title/heading/tag boost via token duplication → Task 3. ✓
- Read top-N snippets at query time → Task 4 (`buildSnippet`). ✓
- Tool contract (query, limit≤100, header+score+snippet, sorted) → Tasks 4–6. ✓
- Types → Task 4. ✓
- Query CLI → Task 7. ✓
- CLAUDE.md + README.md → Task 8. ✓
- Tests (tokenize, bm25, searchNotesRanked, incremental refresh) → Tasks 1,2,4,5. ✓
- Non-goals respected: no SQLite, no BM25F, `search_notes` untouched. ✓

**Placeholder scan:** No TBD/TODO. README step (Task 8 Step 2) intentionally defers exact insertion points to the file's live structure but specifies required content and a command to locate the spot — acceptable because README structure isn't known here; content is fully specified.

**Type consistency:** `RankedSearchParams { query; limit? }` and `RankedSearchResult extends NoteHeader { score; snippet }` used identically in Tasks 4, 5, 6, 7. `BM25.add/finalize/search`, `BM25Hit { docId; score }`, `tokenize`, `stem`, `allHeadings` names consistent across tasks. `searchRanked` (index method) vs `searchNotesRanked` (tool wrapper) — distinct names used consistently.
