# get_outline + read_section Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two additive read tools — `get_outline` (a note's heading structure, index-backed) and `read_section` (one section's text, read on demand) — so an agent can inspect structure and pull a section without reading the whole note.

**Architecture:** Lift the write side's fence-aware heading parser into `src/tools/vault.ts` as the single shared parser. The index stores structured `{ text, level }` headings computed with it; `get_outline` is then a pure index lookup that adds a `>`-joined heading-path and an `ambiguous` flag per heading. `read_section` reads the note file at call time, resolves a bare-heading-or-path address (fail-loud on ambiguity), and slices the section body using the same same-or-higher-level boundary rule the write tools use.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), `@modelcontextprotocol/sdk`, `gray-matter`, `commander` (CLI), Node's built-in `node:test` runner via `tsx`.

## Global Constraints

- ESM throughout; import specifiers end in `.js` even for `.ts` sources (e.g. `import { getIndex } from "./vault-index.js"`).
- These are **read** tools: always exposed, never gated by `OBSIDIAN_ALLOW_WRITES`.
- Path traversal is guarded via `resolveNotePath(vaultPath, notePath)` from `src/tools/vault.ts` (throws `"Invalid note path: path traversal not allowed"`).
- `read_section` reads files directly; enforce the 10MB size limit like `readNotes` does (`stat` then reject `> 10 * 1024 * 1024`).
- Frontmatter is never included in `read_section` output (parse with `gray-matter`, operate on `.content`).
- Heading-path separator is exactly `" > "` (space, greater-than, space).
- Tests: `node:test` + `node:assert/strict`; each suite builds a throwaway vault via `makeVault(...)` from `tests/fixtures.js` (which calls `clearIndexCache()`), and calls `fx.cleanup()` in `after`.
- Run the full suite with `npm test`. Run a single file with `npx tsx --test tests/<file>.test.ts`.
- The shared-parser lift must be behavior-preserving for existing write tools: existing write/section tests must still pass unchanged.
- Update **both** `CLAUDE.md` and `README.md` when functionality changes (project rule).
- Commit after each task with a `feat:`/`refactor:`/`docs:` prefixed message; end commit messages with the `Co-Authored-By` trailer used in this repo.

---

## File Structure

- `src/tools/vault.ts` — **modify.** Add the shared `parseHeadings(content: string): ParsedHeading[]` (fence-aware, level-carrying), plus `headingPaths(...)` helper for `>`-path derivation. Re-express `firstHeading` in terms of it; remove `allHeadings` (migrate its callers).
- `src/tools/vault-index.ts` — **modify.** `IndexEntry` gains `headings: ParsedHeading[]`; `buildEntry` populates it via `parseHeadings`; `headline` and BM25 boost derive from it. Add `VaultIndex.getEntry` is already present; no new index method needed beyond reading `entry.headings`.
- `src/tools/note-document.ts` — **modify.** Internal `findHeadings` re-expressed to call the shared parser (write behavior unchanged).
- `src/tools/outline.ts` — **create.** `getOutline(vaultPath, notePath)` → index lookup + path/ambiguity computation.
- `src/tools/section.ts` — **create.** `readSection(vaultPath, params)` → on-demand file read, address resolution, section slice.
- `src/types.ts` — **modify.** Add `ParsedHeading`, `OutlineEntry`, `OutlineResult`, `ReadSectionParams`, `SectionResult`.
- `src/index.ts` — **modify.** Register both tools in `list_tools` and add dispatch `case`s.
- `src/query-cli.ts` — **modify.** Add `outline` and `read-section` subcommands + `queryTool` dispatch branches.
- `CLAUDE.md`, `README.md` — **modify.** Document both tools + CLI.
- `tests/parse-headings.test.ts`, `tests/outline.test.ts`, `tests/section.test.ts` — **create.**

---

## Task 1: Shared fence-aware heading parser in `vault.ts`

Lift the parser so index, write tools, and read tools agree on headings. This task is refactor-only plus new exports; no tool behavior changes yet.

**Files:**
- Modify: `src/tools/vault.ts` (add `parseHeadings`, `headingPaths`; rewrite `firstHeading`; remove `allHeadings`)
- Modify: `src/tools/vault-index.ts` (replace `allHeadings` import/usage — see Task 2; here only fix the compile break by importing the new API)
- Modify: `src/types.ts` (add `ParsedHeading`)
- Test: `tests/parse-headings.test.ts`

**Interfaces:**
- Produces:
  - `interface ParsedHeading { text: string; level: number; line: number }` in `src/types.ts` (`line` is 0-based index into the content's line array).
  - `parseHeadings(content: string): ParsedHeading[]` in `src/tools/vault.ts` — fence-aware (skips ```` ``` ````/`~~~` blocks), matches `^(#{1,6})\s+(.+?)\s*#*\s*$`.
  - `headingPaths(headings: ParsedHeading[]): string[]` in `src/tools/vault.ts` — parallel array of `" > "`-joined ancestor paths (level-stack derivation).
  - `firstHeading(content: string): string | undefined` — now returns `parseHeadings(content)[0]?.text`.

- [ ] **Step 1: Add `ParsedHeading` to types**

In `src/types.ts`, add near the other note-structure types:

```ts
/** A markdown heading with its level and 0-based source line index. */
export interface ParsedHeading {
  text: string;
  level: number;
  /** 0-based index of the heading line within the content's line array. */
  line: number;
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/parse-headings.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHeadings, headingPaths, firstHeading } from "../src/tools/vault.js";

test("parses headings with level and 0-based line", () => {
  const md = ["# Top", "body", "## Sub", "more"].join("\n");
  assert.deepEqual(parseHeadings(md), [
    { text: "Top", level: 1, line: 0 },
    { text: "Sub", level: 2, line: 2 },
  ]);
});

test("skips ATX headings inside fenced code blocks", () => {
  const md = ["# Real", "```", "# Not a heading", "```", "~~~", "## Also not", "~~~", "## Real2"].join("\n");
  assert.deepEqual(
    parseHeadings(md).map((h) => h.text),
    ["Real", "Real2"]
  );
});

test("derives > -joined ancestor paths via the level stack", () => {
  const md = ["# A", "## B", "### C", "## D", "# E"].join("\n");
  assert.deepEqual(headingPaths(parseHeadings(md)), [
    "A",
    "A > B",
    "A > B > C",
    "A > D",
    "E",
  ]);
});

test("a level skip attaches to the nearest shallower ancestor", () => {
  const md = ["# A", "#### Deep"].join("\n");
  assert.deepEqual(headingPaths(parseHeadings(md)), ["A", "A > Deep"]);
});

test("firstHeading returns the first heading text", () => {
  assert.equal(firstHeading("intro\n## Second\n# First-ish"), "Second");
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx tsx --test tests/parse-headings.test.ts`
Expected: FAIL — `parseHeadings`/`headingPaths` are not exported yet.

- [ ] **Step 4: Implement the parser in `vault.ts`**

In `src/tools/vault.ts`, add the import at the top (near the other type imports):

```ts
import { ParsedHeading } from "../types.js";
```

Replace the existing `firstHeading` and `allHeadings` functions (currently around lines 219–231) with:

```ts
/**
 * All ATX headings (`#`..`######`) in document order, skipping fenced code
 * blocks. This is the single shared heading parser used by the index, the
 * write tools, and the read-side structure tools, so they never disagree.
 */
export function parseHeadings(content: string): ParsedHeading[] {
  const lines = content.split("\n");
  const headings: ParsedHeading[] = [];
  let inFence = false;
  let fence = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = line.match(/^\s*(```+|~~~+)/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!inFence) {
        inFence = true;
        fence = marker;
      } else if (marker === fence) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;
    const h = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (h) headings.push({ text: h[2].trim(), level: h[1].length, line: i });
  }
  return headings;
}

/**
 * Parallel array of `" > "`-joined ancestor paths for the given headings.
 * A heading at level L attaches to the nearest heading of level < L before it;
 * level skips attach to whatever shallower ancestor is present.
 */
export function headingPaths(headings: ParsedHeading[]): string[] {
  const stack: ParsedHeading[] = [];
  return headings.map((h) => {
    while (stack.length > 0 && stack[stack.length - 1].level >= h.level) {
      stack.pop();
    }
    const path = [...stack.map((a) => a.text), h.text].join(" > ");
    stack.push(h);
    return path;
  });
}

export function firstHeading(content: string): string | undefined {
  return parseHeadings(content)[0]?.text;
}
```

- [ ] **Step 5: Fix `vault-index.ts` compile break from removing `allHeadings`**

`src/tools/vault-index.ts` imports `allHeadings` and uses it for BM25 boost tokens (around line 235). Replace the import `allHeadings` with `parseHeadings` in the import list from `./vault.js`, and change the boost line:

From:
```ts
const boosted = [title, ...allHeadings(parsed.content), ...tags].join(" ");
```
To:
```ts
const boosted = [title, ...parseHeadings(parsed.content).map((h) => h.text), ...tags].join(" ");
```

(Task 2 will further use `parseHeadings` for the stored `headings` field; this step only keeps the build green.)

- [ ] **Step 6: Run the new test and the existing note-document tests**

Run: `npx tsx --test tests/parse-headings.test.ts tests/note-document.test.ts`
Expected: PASS for parse-headings; note-document unaffected (it has its own `findHeadings` still — refactored in Task 3).

- [ ] **Step 7: Full build + suite**

Run: `npm run build && npm test`
Expected: build succeeds; all tests pass (BM25/index tests still green — boost tokens are equivalent).

- [ ] **Step 8: Commit**

```bash
git add src/tools/vault.ts src/tools/vault-index.ts src/types.ts tests/parse-headings.test.ts
git commit -m "$(cat <<'EOF'
refactor: add shared fence-aware heading parser in vault.ts

Lift a single parseHeadings/headingPaths API used by the index and, next,
the read-side structure tools. Replaces allHeadings; firstHeading now
derives from it.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Store structured headings in the index

Give `IndexEntry` a `headings` field so `get_outline` is a pure lookup.

**Files:**
- Modify: `src/tools/vault-index.ts` (`IndexEntry.headings`; populate in `buildEntry`)
- Test: `tests/index-headings.test.ts` (create)

**Interfaces:**
- Consumes: `parseHeadings` (Task 1), `ParsedHeading` (Task 1).
- Produces: `IndexEntry.headings: ParsedHeading[]` — every note's headings, fence-aware, in document order.

- [ ] **Step 1: Write the failing test**

Create `tests/index-headings.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { getIndex } from "../src/tools/vault-index.js";
import { makeVault } from "./fixtures.js";

test("index stores fence-aware structured headings per note", async () => {
  const fx = await makeVault([
    {
      path: "n.md",
      content: ["# Top", "```", "# fake", "```", "## Sub"].join("\n"),
    },
  ]);
  try {
    const index = await getIndex(fx.vaultPath);
    const entry = index.getEntry("n");
    assert.ok(entry);
    assert.deepEqual(
      entry!.headings.map((h) => [h.text, h.level]),
      [["Top", 1], ["Sub", 2]]
    );
  } finally {
    await fx.cleanup();
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test tests/index-headings.test.ts`
Expected: FAIL — `headings` is not a property of `IndexEntry`.

- [ ] **Step 3: Add the field and populate it**

In `src/tools/vault-index.ts`:

Add to the `IndexEntry` interface (after `title: string;`):
```ts
  /** Fence-aware headings in document order (shared parser). */
  headings: ParsedHeading[];
```

Add `ParsedHeading` to the type import from `../types.js` (the file already imports `NoteHeader, RankedSearchResult`):
```ts
import { NoteHeader, RankedSearchResult, ParsedHeading } from "../types.js";
```

In `buildEntry`, compute headings once and reuse for headline + boost. Replace the block that sets `headline` and `boosted`:

From:
```ts
    headline = firstHeading(parsed.content);
    ...
    const boosted = [title, ...parseHeadings(parsed.content).map((h) => h.text), ...tags].join(" ");
```
To:
```ts
    headings = parseHeadings(parsed.content);
    headline = headings[0]?.text;
    ...
    const boosted = [title, ...headings.map((h) => h.text), ...tags].join(" ");
```

Add a local declaration near the other `let` locals at the top of `buildEntry`:
```ts
  let headings: ParsedHeading[] = [];
```

Update the imports from `./vault.js` to drop `firstHeading` if now unused there (keep `parseHeadings`). Add `headings` to the returned object literal:
```ts
    headings,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test tests/index-headings.test.ts`
Expected: PASS.

- [ ] **Step 5: Full build + suite**

Run: `npm run build && npm test`
Expected: build + all tests pass (headline still correct; list.test.ts "extracts the first heading as headline" still green).

- [ ] **Step 6: Commit**

```bash
git add src/tools/vault-index.ts tests/index-headings.test.ts
git commit -m "$(cat <<'EOF'
feat: store fence-aware structured headings in the vault index

IndexEntry.headings carries {text,level,line} per note via the shared
parser, so get_outline is a pure lookup. headline derives from it.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Re-express `note-document.findHeadings` on the shared parser

Remove the duplicate parser so write and read never diverge. Behavior-preserving.

**Files:**
- Modify: `src/tools/note-document.ts`
- Test: existing `tests/note-document.test.ts` (no new test; must stay green)

**Interfaces:**
- Consumes: `parseHeadings` (Task 1).
- Produces: (internal only) `findHeadings(lines: string[])` returns the same `{ line, level, text }[]` shape it does today, now delegating to the shared parser.

- [ ] **Step 1: Delegate `findHeadings` to the shared parser**

In `src/tools/note-document.ts`, add to the existing import from `./vault.js` (or add one if absent): `parseHeadings`.

Replace the body of the internal `findHeadings` (around lines 314–338) with a delegation. The shared parser takes a string and returns `{ text, level, line }` where `line` is the index into `content.split("\n")`. `findHeadings` here receives `lines: string[]`; join and delegate:

```ts
/** Find all ATX headings in the body, skipping fenced code blocks. */
function findHeadings(lines: string[]): Heading[] {
  return parseHeadings(lines.join("\n")).map((h) => ({
    line: h.line,
    level: h.level,
    text: h.text,
  }));
}
```

Keep the local `interface Heading` as-is (its field order is `{ line, level, text }`; the mapped object matches). `locateSection` and all callers are unchanged.

- [ ] **Step 2: Run the write/section tests**

Run: `npx tsx --test tests/note-document.test.ts tests/write.test.ts tests/edit-extras.test.ts`
Expected: PASS — section location, add/append/replace-section behavior identical.

- [ ] **Step 3: Full build + suite**

Run: `npm run build && npm test`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add src/tools/note-document.ts
git commit -m "$(cat <<'EOF'
refactor: delegate note-document findHeadings to the shared parser

Removes the duplicate heading parser; write and read now share one
fence-aware implementation. Behavior-preserving.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `getOutline` tool

**Files:**
- Create: `src/tools/outline.ts`
- Modify: `src/types.ts` (`OutlineEntry`, `OutlineResult`)
- Test: `tests/outline.test.ts`

**Interfaces:**
- Consumes: `getIndex`, `IndexEntry.headings` (Task 2); `headingPaths`, `resolveNotePath` (`vault.ts`).
- Produces:
  - In `src/types.ts`:
    ```ts
    export interface OutlineEntry {
      heading: string;
      level: number;
      /** Full " > "-joined heading-path (disambiguating address). */
      path: string;
      /** 1-based line number of the heading in the note body. */
      line: number;
      /** True when the bare heading text is non-unique in this note. */
      ambiguous: boolean;
    }
    export interface OutlineResult {
      path: string;
      outline: OutlineEntry[];
    }
    ```
  - `getOutline(vaultPath: string, notePath: string): Promise<OutlineResult>` in `src/tools/outline.ts`.

- [ ] **Step 1: Add the result types**

Add `OutlineEntry` and `OutlineResult` (above) to `src/types.ts`.

- [ ] **Step 2: Write the failing test**

Create `tests/outline.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { getOutline } from "../src/tools/outline.js";
import { makeVault } from "./fixtures.js";

const NOTE = [
  "---",
  "title: T",
  "---",
  "# Alpha",
  "intro",
  "## Log",
  "a",
  "# Projects",
  "## Log",
  "b",
  "```",
  "## In code",
  "```",
].join("\n");

test("returns level, 1-based line, full path, and ambiguity", async () => {
  const fx = await makeVault([{ path: "n.md", content: NOTE }]);
  try {
    const { path, outline } = await getOutline(fx.vaultPath, "n");
    assert.equal(path, "n");
    assert.deepEqual(outline, [
      { heading: "Alpha", level: 1, path: "Alpha", line: 4, ambiguous: false },
      { heading: "Log", level: 2, path: "Alpha > Log", line: 6, ambiguous: true },
      { heading: "Projects", level: 1, path: "Projects", line: 8, ambiguous: false },
      { heading: "Log", level: 2, path: "Projects > Log", line: 9, ambiguous: true },
    ]);
  } finally {
    await fx.cleanup();
  }
});

test("empty for a note with no headings", async () => {
  const fx = await makeVault([{ path: "e.md", content: "just body text" }]);
  try {
    const { outline } = await getOutline(fx.vaultPath, "e");
    assert.deepEqual(outline, []);
  } finally {
    await fx.cleanup();
  }
});

test("rejects path traversal", async () => {
  const fx = await makeVault([{ path: "n.md", content: "# H" }]);
  try {
    await assert.rejects(() => getOutline(fx.vaultPath, "../escape"), /path traversal/);
  } finally {
    await fx.cleanup();
  }
});

test("throws for a missing note", async () => {
  const fx = await makeVault([{ path: "n.md", content: "# H" }]);
  try {
    await assert.rejects(() => getOutline(fx.vaultPath, "nope"), /not found/i);
  } finally {
    await fx.cleanup();
  }
});
```

Note the `line` values are **1-based** in the output (the fixture's `# Alpha` is on content line index 3 → output `line: 4`). The frontmatter block is stripped by the index before parsing, so line numbers are relative to the body (index parses `matter(raw).content`).

- [ ] **Step 3: Run to verify it fails**

Run: `npx tsx --test tests/outline.test.ts`
Expected: FAIL — `getOutline` not defined.

- [ ] **Step 4: Implement `getOutline`**

Create `src/tools/outline.ts`:

```ts
import { resolveNotePath, headingPaths } from "./vault.js";
import { getIndex } from "./vault-index.js";
import { OutlineResult } from "../types.js";

/**
 * Return a note's heading structure from the shared index (no file read).
 * Each entry carries its level, a 1-based body line number, the full
 * " > "-joined heading-path (the disambiguating address for read_section and
 * the section write tools), and an `ambiguous` flag set when the bare heading
 * text repeats within the note.
 */
export async function getOutline(
  vaultPath: string,
  notePath: string
): Promise<OutlineResult> {
  if (!notePath || typeof notePath !== "string") {
    throw new Error("A note path is required for get_outline");
  }
  resolveNotePath(vaultPath, notePath); // guards against path traversal

  const index = await getIndex(vaultPath);
  const noteName = notePath.replace(/\.md$/, "");
  const self = index.resolve(noteName) ?? noteName;
  const entry = index.getEntry(self);
  if (!entry) {
    throw new Error(`Note not found or not readable: ${notePath}`);
  }

  const paths = headingPaths(entry.headings);
  const counts = new Map<string, number>();
  for (const h of entry.headings) {
    counts.set(h.text, (counts.get(h.text) ?? 0) + 1);
  }

  return {
    path: self,
    outline: entry.headings.map((h, i) => ({
      heading: h.text,
      level: h.level,
      path: paths[i],
      line: h.line + 1, // index headings are 0-based; expose 1-based
      ambiguous: (counts.get(h.text) ?? 0) > 1,
    })),
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx tsx --test tests/outline.test.ts`
Expected: PASS.

- [ ] **Step 6: Full build + suite**

Run: `npm run build && npm test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/tools/outline.ts src/types.ts tests/outline.test.ts
git commit -m "$(cat <<'EOF'
feat: add get_outline read tool

Index-backed note outline: heading, level, 1-based line, full
> -joined heading-path, and an ambiguity flag per heading.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `readSection` tool

**Files:**
- Create: `src/tools/section.ts`
- Modify: `src/types.ts` (`ReadSectionParams`, `SectionResult`)
- Test: `tests/section.test.ts`

**Interfaces:**
- Consumes: `resolveNotePath`, `parseHeadings`, `headingPaths` (`vault.ts`); `matter` (gray-matter); `stat`, `readFile` (node).
- Produces:
  - In `src/types.ts`:
    ```ts
    export interface ReadSectionParams {
      path: string;
      section: string;
      include_subsections?: boolean;
    }
    export interface SectionResult {
      path: string;
      /** The resolved full heading-path. */
      section: string;
      level: number;
      /** Heading line + body slice, verbatim. Frontmatter excluded. */
      content: string;
    }
    ```
  - `readSection(vaultPath: string, params: ReadSectionParams): Promise<SectionResult>` in `src/tools/section.ts`.

**Resolution rules (implement exactly):**
1. Parse the note body's headings (`parseHeadings`) and compute `headingPaths`.
2. If `section` contains `>` (a path form), match where the heading's full path equals the trimmed input (normalize each `>`-segment by trimming surrounding whitespace before compare). Otherwise (bare), match by heading text.
3. Zero matches → `Error("Section \"<section>\" not found in <path>")`.
4. More than one match → `Error` listing the candidate full paths, e.g. `Ambiguous section "Log"; candidates: Alpha > Log, Projects > Log`. This covers both a repeated bare heading and a genuinely non-unique full path (no positional fallback).
5. One match → slice: `bodyStart` = heading line + 1; `bodyEnd` = the next heading with `level <= matched.level` (default) — this **excludes** subsections. With `include_subsections: true`, `bodyEnd` is still the next heading of `level <= matched.level` **but** intervening deeper headings are kept (i.e. the slice runs to the next same-or-higher heading, including all descendants). Content = the matched heading line plus `lines[bodyStart..bodyEnd)`, joined with `\n`.

The two modes differ only in where the slice ends:
- **exclude (default):** `bodyEnd` = line of the **first** heading after the match, of **any** level (else EOF). This cuts off at the first subsection, returning only the matched heading's own body.
- **include (`include_subsections: true`):** `bodyEnd` = line of the first heading after the match with `level <= matched.level` (else EOF). Intervening deeper headings are kept, so the whole subtree is returned.

- [ ] **Step 1: Add the types**

Add `ReadSectionParams` and `SectionResult` (above) to `src/types.ts`.

- [ ] **Step 2: Write the failing test**

Create `tests/section.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readSection } from "../src/tools/section.js";
import { makeVault } from "./fixtures.js";

const NOTE = [
  "---",
  "title: T",
  "---",
  "# Alpha",
  "alpha body",
  "## Log",
  "alpha log line",
  "### Detail",
  "detail line",
  "# Projects",
  "## Log",
  "projects log line",
].join("\n");

test("bare unique heading returns heading + own body, excluding subsections", async () => {
  const fx = await makeVault([{ path: "n.md", content: NOTE }]);
  try {
    const r = await readSection(fx.vaultPath, { path: "n", section: "Alpha" });
    assert.equal(r.section, "Alpha");
    assert.equal(r.level, 1);
    // Excludes ## Log and everything after it.
    assert.equal(r.content, "# Alpha\nalpha body");
  } finally {
    await fx.cleanup();
  }
});

test("include_subsections keeps descendants up to the next same-or-higher heading", async () => {
  const fx = await makeVault([{ path: "n.md", content: NOTE }]);
  try {
    const r = await readSection(fx.vaultPath, {
      path: "n",
      section: "Alpha",
      include_subsections: true,
    });
    assert.equal(
      r.content,
      ["# Alpha", "alpha body", "## Log", "alpha log line", "### Detail", "detail line"].join("\n")
    );
  } finally {
    await fx.cleanup();
  }
});

test("ambiguous bare heading errors with candidate full paths", async () => {
  const fx = await makeVault([{ path: "n.md", content: NOTE }]);
  try {
    await assert.rejects(
      () => readSection(fx.vaultPath, { path: "n", section: "Log" }),
      /Ambiguous section "Log".*Alpha > Log.*Projects > Log/s
    );
  } finally {
    await fx.cleanup();
  }
});

test("full path resolves the exact section", async () => {
  const fx = await makeVault([{ path: "n.md", content: NOTE }]);
  try {
    const r = await readSection(fx.vaultPath, { path: "n", section: "Projects > Log" });
    assert.equal(r.section, "Projects > Log");
    assert.equal(r.content, "## Log\nprojects log line");
  } finally {
    await fx.cleanup();
  }
});

test("missing section errors", async () => {
  const fx = await makeVault([{ path: "n.md", content: NOTE }]);
  try {
    await assert.rejects(
      () => readSection(fx.vaultPath, { path: "n", section: "Nope" }),
      /not found/i
    );
  } finally {
    await fx.cleanup();
  }
});

test("content never includes frontmatter", async () => {
  const fx = await makeVault([{ path: "n.md", content: NOTE }]);
  try {
    const r = await readSection(fx.vaultPath, { path: "n", section: "Alpha" });
    assert.ok(!r.content.includes("title: T"));
  } finally {
    await fx.cleanup();
  }
});

test("rejects path traversal", async () => {
  const fx = await makeVault([{ path: "n.md", content: NOTE }]);
  try {
    await assert.rejects(
      () => readSection(fx.vaultPath, { path: "../escape", section: "Alpha" }),
      /path traversal/
    );
  } finally {
    await fx.cleanup();
  }
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx tsx --test tests/section.test.ts`
Expected: FAIL — `readSection` not defined.

- [ ] **Step 4: Implement `readSection`**

Create `src/tools/section.ts`:

```ts
import { readFile, stat } from "node:fs/promises";
import matter from "gray-matter";
import { resolveNotePath, parseHeadings, headingPaths } from "./vault.js";
import { ReadSectionParams, SectionResult } from "../types.js";

const MAX_BYTES = 10 * 1024 * 1024;

/**
 * Read a single section from a note without loading the whole note into the
 * caller's context. Reads the file at call time (the index does not retain body
 * text), then addresses the section by bare heading or by a " > "-joined path,
 * failing loudly when a bare heading is ambiguous. The returned slice is the
 * heading line plus its own body; nested subsections are excluded unless
 * `include_subsections` is set.
 */
export async function readSection(
  vaultPath: string,
  params: ReadSectionParams
): Promise<SectionResult> {
  const { path: notePath, section, include_subsections = false } = params;
  if (!notePath || typeof notePath !== "string") {
    throw new Error("A note path is required for read_section");
  }
  if (!section || typeof section !== "string") {
    throw new Error("A section is required for read_section");
  }

  const fullPath = resolveNotePath(vaultPath, notePath); // guards traversal
  const info = await stat(fullPath).catch(() => {
    throw new Error(`Note not found or not readable: ${notePath}`);
  });
  if (info.size > MAX_BYTES) {
    throw new Error("Note file too large (max 10MB)");
  }

  const raw = await readFile(fullPath, "utf-8");
  const body = matter(raw).content;
  const lines = body.split("\n");
  const headings = parseHeadings(body);
  const paths = headingPaths(headings);

  const wanted = section.trim();
  const isPath = wanted.includes(">");
  const norm = (p: string): string =>
    p
      .split(">")
      .map((s) => s.trim())
      .join(" > ");
  const target = isPath ? norm(wanted) : wanted;

  const matches = headings
    .map((h, i) => ({ h, i, path: paths[i] }))
    .filter((m) => (isPath ? m.path === target : m.h.text === wanted));

  if (matches.length === 0) {
    throw new Error(`Section "${section}" not found in ${notePath}`);
  }
  if (matches.length > 1) {
    const candidates = matches.map((m) => m.path).join(", ");
    throw new Error(`Ambiguous section "${section}"; candidates: ${candidates}`);
  }

  const { h, i } = matches[0];
  const bodyStart = h.line + 1;
  let bodyEnd = lines.length;
  for (let j = i + 1; j < headings.length; j++) {
    if (include_subsections) {
      if (headings[j].level <= h.level) {
        bodyEnd = headings[j].line;
        break;
      }
    } else {
      // Exclude subsections: stop at the very next heading of any level.
      bodyEnd = headings[j].line;
      break;
    }
  }

  const content = [lines[h.line], ...lines.slice(bodyStart, bodyEnd)].join("\n");
  return { path: notePath.replace(/\.md$/, ""), section: paths[i], level: h.level, content };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx tsx --test tests/section.test.ts`
Expected: PASS (all 7 cases).

- [ ] **Step 6: Full build + suite**

Run: `npm run build && npm test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/tools/section.ts src/types.ts tests/section.test.ts
git commit -m "$(cat <<'EOF'
feat: add read_section read tool

Read one section by bare heading or > -path (fail-loud on ambiguity),
excluding subsections by default, include_subsections to opt into the
subtree. Reads on demand; frontmatter never included.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Register both tools in the MCP server

**Files:**
- Modify: `src/index.ts` (imports, `list_tools` entries, dispatch cases)

**Interfaces:**
- Consumes: `getOutline` (Task 4), `readSection` (Task 5), `ReadSectionParams`.

- [ ] **Step 1: Add imports**

In `src/index.ts`, near the other tool imports (e.g. after `import { getLinks } from "./tools/links.js";`):

```ts
import { getOutline } from "./tools/outline.js";
import { readSection } from "./tools/section.js";
```

And add `ReadSectionParams` to the type import from `./types.js`.

- [ ] **Step 2: Add `list_tools` entries**

In the array returned by the `ListToolsRequestSchema` handler, add two entries next to `get_links`:

```ts
{
  name: "get_outline",
  description: "Return a note's heading structure (outline) without reading its body: each heading with its level, 1-based line number, full \" > \"-joined heading-path, and an ambiguity flag. Use it to see what sections exist before reading or editing one.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Relative note path (with or without .md extension)"
      }
    },
    required: ["path"]
  }
},
{
  name: "read_section",
  description: "Read a single section of a note without loading the whole note. Address the section by bare heading (when unique) or by a \" > \"-joined heading-path (e.g. \"Projects > Log\") when the heading repeats. Returns the heading plus its own body; set include_subsections to include nested subsections.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Relative note path (with or without .md extension)"
      },
      section: {
        type: "string",
        description: "Heading text, or a \" > \"-joined heading-path when the heading is ambiguous"
      },
      include_subsections: {
        type: "boolean",
        description: "Include nested subsections in the returned content (default false)"
      }
    },
    required: ["path", "section"]
  }
},
```

- [ ] **Step 3: Add dispatch cases**

In the `switch (name)` block, after `case "get_links": { ... }`:

```ts
case "get_outline": {
  const { path } = args as unknown as { path: string };
  if (!path || typeof path !== "string") {
    throw new Error("A note path is required for get_outline");
  }
  const results = await getOutline(VAULT_PATH, path);
  return {
    content: [{ type: "text", text: JSON.stringify(results, null, 2) }]
  };
}

case "read_section": {
  const params = args as unknown as ReadSectionParams;
  if (!params.path || typeof params.path !== "string") {
    throw new Error("A note path is required for read_section");
  }
  if (!params.section || typeof params.section !== "string") {
    throw new Error("A section is required for read_section");
  }
  const results = await readSection(VAULT_PATH, params);
  return {
    content: [{ type: "text", text: JSON.stringify(results, null, 2) }]
  };
}
```

- [ ] **Step 4: Build and smoke-test tool listing**

Run: `npm run build`
Expected: compiles.

Run:
```bash
OBSIDIAN_VAULT_PATH="$(mktemp -d)" node -e "process.exit(0)" # noop sanity
grep -c '"get_outline"\|"read_section"' dist/index.js
```
Expected: `grep -c` prints `2` (both tool names present in the built output).

- [ ] **Step 5: Full suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts
git commit -m "$(cat <<'EOF'
feat: register get_outline and read_section MCP tools

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Query CLI subcommands

**Files:**
- Modify: `src/query-cli.ts`

**Interfaces:**
- Consumes: `getOutline` (Task 4), `readSection` (Task 5).

- [ ] **Step 1: Add imports and `queryTool` branches**

In `src/query-cli.ts`, add imports near the others:

```ts
import { getOutline } from "./tools/outline.js";
import { readSection } from "./tools/section.js";
```

In the `queryTool` if/else dispatch chain, add branches (next to the `get_links` branch):

```ts
} else if (toolName === "get_outline") {
  result = await getOutline(VAULT_PATH!, args.path);
} else if (toolName === "read_section") {
  result = await readSection(VAULT_PATH!, args);
```

- [ ] **Step 2: Add the subcommands**

Near the `links` command definition, add:

```ts
program
  .command("outline <path>")
  .description("Show a note's heading outline (levels, paths, ambiguity)")
  .action(async (path: string, _options: any, command: Command) => {
    const verbose = command.parent?.opts().verbose ?? false;
    await queryTool("get_outline", { path }, verbose);
  });

program
  .command("read-section <path> <section>")
  .description("Read one section by heading or \"A > B\" path")
  .option("--include-subsections", "Include nested subsections")
  .action(async (path: string, section: string, options: any, command: Command) => {
    const verbose = command.parent?.opts().verbose ?? false;
    await queryTool(
      "read_section",
      { path, section, include_subsections: !!options.includeSubsections },
      verbose
    );
  });
```

(Match the exact `program`/chaining style already used in the file — if commands are chained off a single `program` with `.command(...).command(...)`, append these in the same style instead of re-referencing `program`.)

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: compiles.

- [ ] **Step 4: Exercise the CLI against a temp vault**

Run:
```bash
V="$(mktemp -d)"
printf -- '# Alpha\nbody\n## Log\nx\n# Projects\n## Log\ny\n' > "$V/n.md"
OBSIDIAN_VAULT_PATH="$V" npm run query -- outline "n"
OBSIDIAN_VAULT_PATH="$V" npm run query -- read-section "n" "Projects > Log"
OBSIDIAN_VAULT_PATH="$V" npm run query -- read-section "n" "Alpha" --include-subsections
```
Expected: outline lists 4 headings with two `ambiguous: true` `Log` entries; the path read prints `## Log\ny`; the `--include-subsections` read of `Alpha` includes `## Log\nx`.

- [ ] **Step 5: Commit**

```bash
git add src/query-cli.ts
git commit -m "$(cat <<'EOF'
feat: add outline and read-section query CLI subcommands

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Documentation

**Files:**
- Modify: `CLAUDE.md`, `README.md`

**Interfaces:** none (docs).

- [ ] **Step 1: Document the tools in `CLAUDE.md`**

Add a `### get_outline` and `### read_section` block to the read-tools section (after `### get_links`), matching the existing tool-doc style:

```markdown
### get_outline
- **Purpose**: A note's heading structure without its body — the outline. Closes the "check what sections exist, then edit the right one" loop without reading the whole note.
- **Input**: `path` (required) - Relative note path (with or without `.md`)
- **Output**: `{ path, outline }` where each outline entry is `{ heading, level, path, line, ambiguous }`. `path` is the full `>`-joined heading-path (e.g. `Projects > Log`) — the disambiguating address; `line` is 1-based; `ambiguous` is `true` when the bare heading text repeats in the note. Index-backed (no file read); headings inside fenced code blocks are excluded.
- **Security**: Path traversal protected via the same guard as read_notes.

### read_section
- **Purpose**: Read a single section of a note without loading the whole note — the read-side complement of `append_to_section`/`replace_section`.
- **Input**: `path` (required), `section` (required — a bare heading, or a `>`-joined heading-path like `Projects > Log`), `include_subsections` (optional, default `false`)
- **Output**: `{ path, section, level, content }`. `section` is the resolved full heading-path; `content` is the heading line plus its own body (nested subsections excluded unless `include_subsections` is set). Frontmatter is never included.
- **Addressing**: A bare heading resolves when unique; an ambiguous bare heading errors loudly, listing the candidate full paths so you can retry with the exact one (mirrors `patch_note`'s fail-loud behavior). Reads the file at call time.
- **Security**: Path traversal protected via the same guard as read_notes.
```

Also add `get_outline` to the index-backed tool list in the "Vault index" section (the parenthesized list starting `list_notes, get_links, ...`), and note that the index now stores structured headings.

- [ ] **Step 2: Document the CLI in `CLAUDE.md`**

In the Testing section's knowledge-base examples, add:

```bash
npm run query -- outline "projects/alpha"                # Heading outline
npm run query -- read-section "projects/alpha" "Log"     # One section
npm run query -- read-section "projects/alpha" "Projects > Log" --include-subsections
```

- [ ] **Step 3: Mirror the same additions in `README.md`**

Apply the equivalent tool descriptions and CLI examples to `README.md`, matching its existing structure and wording style (check how `get_links` is presented there and follow suit).

- [ ] **Step 4: Verify docs mention both tools**

Run:
```bash
grep -c "get_outline\|read_section\|read-section" CLAUDE.md README.md
```
Expected: nonzero counts in both files.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "$(cat <<'EOF'
docs: document get_outline and read_section tools + CLI

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Final verification

- [ ] **Step 1: Full build + suite**

Run: `npm run build && npm test`
Expected: build succeeds; every test passes, including the new `parse-headings`, `index-headings`, `outline`, and `section` suites and all pre-existing suites.

- [ ] **Step 2: Confirm the read tools are ungated**

Confirm `get_outline`/`read_section` appear in `list_tools` output regardless of `OBSIDIAN_ALLOW_WRITES` (they're registered unconditionally in Task 6, alongside the other read tools — no gating code touched).
