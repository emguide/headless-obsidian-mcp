# rename_section + broken-anchor detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `rename_section` write tool that rewrites inbound `[[note#heading]]` anchors when a heading is renamed, plus a `broken_anchors` kind for `list_vault_issues` that detects heading anchors pointing at no heading.

**Architecture:** Extend the vault index to retain per-link anchors (`linkRefs`) alongside the existing anchor-stripped `linkTargets`. `rename_section` reuses `move_note`'s backlink-rewrite loop, matching anchors case-insensitively via a shared `headingMatchesAnchor` helper. `broken_anchors` walks `linkRefs` and validates each heading anchor against the resolved note's headings.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node `node:test` via tsx, MCP SDK, commander CLI.

## Global Constraints

- ESM imports use `.js` specifiers even for `.ts` source (e.g. `from "./vault.js"`).
- Tests are `node:test` + `node:assert/strict`, run via `tsx --test tests/*.test.ts`; use `makeVault` from `tests/fixtures.ts`, `clearIndexCache` is called inside `makeVault`.
- All writes funnel through `commitWrite`/`writeResolved`; path-traversal is guarded by `resolveNotePath`.
- Anchor match is literal case-insensitive trimmed text — NOT Obsidian slug normalization.
- Block-ref anchors (`#^id`) are never treated as heading anchors.
- Update BOTH `CLAUDE.md` and `README.md` when functionality changes (project rule).

---

### Task 1: Index foundation — `LinkRef`, `extractLinkRefs`, `headingMatchesAnchor`

**Files:**
- Modify: `src/tools/vault.ts` (add `LinkRef`, `extractLinkRefs`, `headingMatchesAnchor` near the existing `extractLinkTargets`/`rewriteWikilinks`, ~line 160-211)
- Modify: `src/tools/vault-index.ts` (`IndexEntry` gains `linkRefs`; `buildEntry` populates it, ~line 28-45, ~285-331)
- Test: `tests/link-refs.test.ts` (create)

**Interfaces:**
- Produces:
  - `interface LinkRef { target: string; anchor: string | null; isBlockRef: boolean }`
  - `function extractLinkRefs(content: string): LinkRef[]`
  - `function headingMatchesAnchor(headingText: string, anchor: string): boolean`
  - `IndexEntry.linkRefs: LinkRef[]`

- [ ] **Step 1: Write the failing test**

Create `tests/link-refs.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractLinkRefs, headingMatchesAnchor } from "../src/tools/vault.js";

test("extractLinkRefs keeps anchor, alias-stripped, block-ref flagged", () => {
  const refs = extractLinkRefs(
    "See [[note#Heading]], [[other|alias]], [[a#Sec|b]], [[c#^blk]], [[#Self]]."
  );
  assert.deepEqual(refs, [
    { target: "note", anchor: "Heading", isBlockRef: false },
    { target: "other", anchor: null, isBlockRef: false },
    { target: "a", anchor: "Sec", isBlockRef: false },
    { target: "c", anchor: "blk", isBlockRef: true },
    { target: "", anchor: "Self", isBlockRef: false },
  ]);
});

test("extractLinkRefs handles embeds and trims anchor", () => {
  const refs = extractLinkRefs("![[img#  Spaced  ]]");
  assert.deepEqual(refs, [{ target: "img", anchor: "Spaced", isBlockRef: false }]);
});

test("headingMatchesAnchor is case-insensitive and trimmed", () => {
  assert.equal(headingMatchesAnchor("My Heading", "my heading"), true);
  assert.equal(headingMatchesAnchor("  My Heading  ", "My Heading"), true);
  assert.equal(headingMatchesAnchor("My Heading", "my-heading"), false);
  assert.equal(headingMatchesAnchor("Other", "My Heading"), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/link-refs.test.ts`
Expected: FAIL — `extractLinkRefs`/`headingMatchesAnchor` not exported.

- [ ] **Step 3: Add the helpers to `src/tools/vault.ts`**

After `rewriteWikilinks` (after ~line 211), add:

```ts
/** A wikilink's note target plus its heading/block anchor, if any. */
export interface LinkRef {
  /** Note target (alias + anchor stripped, trimmed). Empty for a `[[#anchor]]` self-link. */
  target: string;
  /** Raw anchor text after `#` (trimmed), or null when the link has no anchor. */
  anchor: string | null;
  /** True when the anchor was a block ref (`#^id`) rather than a heading. */
  isBlockRef: boolean;
}

/**
 * Extract every wikilink/embed as a {@link LinkRef}, preserving the heading or
 * block anchor that {@link extractLinkTargets} discards. Order matches document
 * order. A `[[#heading]]` self-link yields an empty `target`.
 */
export function extractLinkRefs(content: string): LinkRef[] {
  const refs: LinkRef[] = [];
  let match: RegExpExecArray | null;
  WIKILINK_RE.lastIndex = 0;
  while ((match = WIKILINK_RE.exec(content)) !== null) {
    const inner = match[1];
    const left = inner.split("|")[0];
    const hash = left.indexOf("#");
    const target = (hash === -1 ? left : left.slice(0, hash)).trim();
    let anchor: string | null = null;
    let isBlockRef = false;
    if (hash !== -1) {
      let raw = left.slice(hash + 1).trim();
      if (raw.startsWith("^")) {
        isBlockRef = true;
        raw = raw.slice(1).trim();
      }
      anchor = raw;
    }
    refs.push({ target, anchor, isBlockRef });
  }
  return refs;
}

/**
 * Whether a heading's text matches a link anchor. Literal case-insensitive,
 * trimmed equality — deliberately NOT Obsidian's slug normalization.
 */
export function headingMatchesAnchor(headingText: string, anchor: string): boolean {
  return headingText.trim().toLowerCase() === anchor.trim().toLowerCase();
}
```

- [ ] **Step 4: Populate `linkRefs` in the index**

In `src/tools/vault-index.ts`, add to `IndexEntry` (after `linkTargets`, ~line 36):

```ts
  /** Wikilink refs retaining heading/block anchors, in document order. */
  linkRefs: LinkRef[];
```

Add `LinkRef` and `extractLinkRefs` to the existing import from `./vault.js` (the same import that already brings in `extractLinkTargets`). In `buildEntry`, where `linkTargets = extractLinkTargets(parsed.content)` is set (~line 297), add alongside it:

```ts
    linkRefs = extractLinkRefs(parsed.content);
```

Declare `let linkRefs: LinkRef[] = [];` next to the existing `let linkTargets` declaration (~line 285), and add `linkRefs,` to the returned entry object (next to `linkTargets,`, ~line 327).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx tsx --test tests/link-refs.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Run the full suite to confirm no regression**

Run: `npm test`
Expected: PASS (all existing tests still green; `linkRefs` is additive).

- [ ] **Step 7: Commit**

```bash
git add src/tools/vault.ts src/tools/vault-index.ts tests/link-refs.test.ts
git commit -m "feat: index retains per-link anchors (linkRefs) + anchor-match helper

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `renameSection` core in `note-document.ts`

**Files:**
- Modify: `src/tools/note-document.ts` (add `renameSection` near `replaceSection`, ~line 498+)
- Test: `tests/rename-section-core.test.ts` (create)

**Interfaces:**
- Consumes: `resolveSection`, `Heading`, `LocatedSection` (internal to `note-document.ts`), `NoteDocument`.
- Produces: `function renameSection(doc: NoteDocument, from: string, to: string): string` — rewrites the resolved heading's text to `to` (level + trailing `#` preserved), returns the OLD bare heading text. Throws on missing/ambiguous `from` (same messages as `resolveSection`).

- [ ] **Step 1: Write the failing test**

Create `tests/rename-section-core.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { NoteDocument, renameSection } from "../src/tools/note-document.js";

const body = (s: string) => NoteDocument.parse("# Doc\n\n## Old Title\n\nbody\n\n## Keep\n\nx\n" + s);

test("renameSection rewrites only the heading line and returns old text", () => {
  const doc = NoteDocument.parse("# Doc\n\n## Old Title\n\nbody\n\n## Keep\n\nx\n");
  const old = renameSection(doc, "Old Title", "New Title");
  assert.equal(old, "Old Title");
  assert.match(doc.body, /## New Title/);
  assert.doesNotMatch(doc.body, /Old Title/);
  assert.match(doc.body, /## Keep/); // untouched
  assert.match(doc.body, /\nbody\n/); // body untouched
});

test("renameSection preserves heading level", () => {
  const doc = NoteDocument.parse("#### Deep\n\ntext\n");
  renameSection(doc, "Deep", "Deeper");
  assert.match(doc.body, /^#### Deeper$/m);
});

test("renameSection resolves a heading-path", () => {
  const doc = NoteDocument.parse("# A\n\n## Log\n\n### Log\n\ninner\n");
  const old = renameSection(doc, "A > Log", "Journal");
  assert.equal(old, "Log");
  assert.match(doc.body, /^## Journal$/m);
  assert.match(doc.body, /^### Log$/m); // the nested one is untouched
});

test("renameSection throws on ambiguous bare heading", () => {
  const doc = NoteDocument.parse("# A\n\n## Log\n\n## Log\n\n");
  assert.throws(() => renameSection(doc, "Log", "X"), /Ambiguous section/);
});

test("renameSection throws on missing heading", () => {
  const doc = NoteDocument.parse("# A\n\nno headings here beyond A\n");
  assert.throws(() => renameSection(doc, "Nope", "X"), /not found/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/rename-section-core.test.ts`
Expected: FAIL — `renameSection` not exported.

- [ ] **Step 3: Implement `renameSection`**

In `src/tools/note-document.ts`, after `replaceSection` (~line 498+), add:

```ts
/**
 * Rename an existing heading, keeping its `#`-level and body intact. `from` is a
 * bare heading or a `" > "`-joined heading-path, resolved with the same fail-loud
 * ambiguity behavior as {@link replaceSection}. Returns the old bare heading text
 * (the leaf of the resolved path) so callers can rewrite inbound `#anchor` links.
 */
export function renameSection(doc: NoteDocument, from: string, to: string): string {
  const { lines, trailingNewline } = splitBody(doc.body);
  const target = resolveSection(lines, from);
  const headingLine = target.heading.line;
  const oldText = target.heading.text;
  const hashes = "#".repeat(target.heading.level);
  lines[headingLine] = `${hashes} ${to.trim()}`;
  doc.body = joinBody(lines, trailingNewline);
  return oldText;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test tests/rename-section-core.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tools/note-document.ts tests/rename-section-core.test.ts
git commit -m "feat: renameSection core — rewrite heading line, return old text

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `rewriteWikilinks` anchor-mapping + `renameSectionInVault` write tool

**Files:**
- Modify: `src/tools/vault.ts` (extend `rewriteWikilinks` with an optional anchor map, ~line 193-211)
- Modify: `src/tools/write.ts` (add `RenameSectionParams`, `renameSectionInVault`; import `renameSection`, `headingMatchesAnchor`; register in `WRITE_TOOL_NAMES`)
- Test: `tests/rename-section.test.ts` (create)

**Interfaces:**
- Consumes: `renameSection` (Task 2), `headingMatchesAnchor` (Task 1), `rewriteWikilinks` (extended below), `getIndex`, `commitWrite`, `writeResolved`, `snapshotBeforeWrite`.
- Produces:
  - Extended `rewriteWikilinks(content, mapTarget, mapAnchor?)` where `mapAnchor?: (target: string, anchor: string) => string | null` maps a link's anchor (return null to leave it). `mapTarget` may return null (keep target) while `mapAnchor` still rewrites the anchor.
  - `interface RenameSectionParams { path: string; from: string; to: string; update_anchors?: boolean }`
  - `function renameSectionInVault(vaultPath, params): Promise<{ path: string; from: string; to: string; updated_notes: number; updated_links: number }>`

- [ ] **Step 1: Write the failing test**

Create `tests/rename-section.test.ts`:

```ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { renameSectionInVault } from "../src/tools/write.js";
import { makeVault, Fixture } from "./fixtures.js";

const read = (v: string, n: string) => readFile(join(v, n), "utf-8");

let fx: Fixture;
before(async () => {
  fx = await makeVault([
    {
      path: "target.md",
      content: "---\ntitle: Target\n---\n# Target\n\n## Old Heading\n\nbody\n",
    },
    {
      path: "refs.md",
      content:
        "# Refs\n" +
        "Full [[target#Old Heading]], base [[target#old heading|alias]], " +
        "embed ![[target#Old Heading]], block [[target#^blk]], " +
        "other [[target#Other]], note [[target]].\n",
    },
    { path: "folder/deep.md", content: "# Deep\nLink [[target#Old Heading]].\n" },
  ]);
});
after(() => fx.cleanup());

test("renameSectionInVault renames heading and rewrites inbound anchors", async () => {
  const r = await renameSectionInVault(fx.vaultPath, {
    path: "target",
    from: "Old Heading",
    to: "New Heading",
  });
  assert.equal(r.from, "Old Heading");
  assert.equal(r.to, "New Heading");
  assert.equal(r.updated_notes, 2); // refs.md + folder/deep.md

  const target = await read(fx.vaultPath, "target.md");
  assert.match(target, /## New Heading/);
  assert.doesNotMatch(target, /Old Heading/);

  const refs = await read(fx.vaultPath, "refs.md");
  assert.match(refs, /\[\[target#New Heading\]\]/);                 // full-path, case match
  assert.match(refs, /\[\[target#New Heading\|alias\]\]/);          // case-insensitive + alias kept
  assert.match(refs, /!\[\[target#New Heading\]\]/);                // embed preserved
  assert.match(refs, /\[\[target#\^blk\]\]/);                       // block ref untouched
  assert.match(refs, /\[\[target#Other\]\]/);                       // non-matching anchor untouched
  assert.match(refs, /\[\[target\]\]/);                             // anchorless link untouched

  const deep = await read(fx.vaultPath, "folder/deep.md");
  assert.match(deep, /\[\[target#New Heading\]\]/);
});

test("renameSectionInVault with update_anchors:false leaves inbound anchors alone", async () => {
  const fx2 = await makeVault([
    { path: "t.md", content: "# T\n\n## H\n\nx\n" },
    { path: "r.md", content: "# R\n[[t#H]]\n" },
  ]);
  const r = await renameSectionInVault(fx2.vaultPath, {
    path: "t",
    from: "H",
    to: "H2",
    update_anchors: false,
  });
  assert.equal(r.updated_notes, 0);
  assert.match(await read(fx2.vaultPath, "t.md"), /## H2/);
  assert.match(await read(fx2.vaultPath, "r.md"), /\[\[t#H\]\]/); // stale, but untouched
  await fx2.cleanup();
});

test("renameSectionInVault fails loud on ambiguous heading", async () => {
  const fx3 = await makeVault([{ path: "a.md", content: "# A\n\n## Log\n\n## Log\n\n" }]);
  await assert.rejects(
    renameSectionInVault(fx3.vaultPath, { path: "a", from: "Log", to: "X" }),
    /Ambiguous section/
  );
  await fx3.cleanup();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/rename-section.test.ts`
Expected: FAIL — `renameSectionInVault` not exported.

- [ ] **Step 3: Extend `rewriteWikilinks` with an anchor map**

In `src/tools/vault.ts`, replace the `rewriteWikilinks` signature/body (~line 193-211) with:

```ts
export function rewriteWikilinks(
  content: string,
  mapTarget: (target: string) => string | null,
  mapAnchor?: (target: string, anchor: string) => string | null
): { content: string; changed: number } {
  let changed = 0;
  const next = content.replace(/(!?)\[\[([^\]]+)\]\]/g, (whole, bang: string, inner: string) => {
    const pipe = inner.indexOf("|");
    const left = pipe === -1 ? inner : inner.slice(0, pipe);
    const alias = pipe === -1 ? "" : inner.slice(pipe); // includes leading "|"
    const hash = left.indexOf("#");
    const target = hash === -1 ? left : left.slice(0, hash);
    const rawAnchor = hash === -1 ? "" : left.slice(hash); // includes leading "#", verbatim
    const trimmedTarget = target.trim();

    const newTarget = mapTarget(trimmedTarget);
    // Only consult mapAnchor for heading anchors (not block refs) when asked.
    let newAnchor: string | null = null;
    if (mapAnchor && hash !== -1) {
      const anchorText = rawAnchor.slice(1).trim(); // drop "#", trim
      if (!anchorText.startsWith("^")) {
        newAnchor = mapAnchor(trimmedTarget, anchorText);
      }
    }
    if (newTarget == null && newAnchor == null) return whole;
    changed++;
    const finalTarget = newTarget == null ? trimmedTarget : newTarget;
    // Preserve the anchor byte-for-byte unless mapAnchor supplied a replacement.
    const finalAnchor = newAnchor == null ? rawAnchor : `#${newAnchor}`;
    return `${bang}[[${finalTarget}${finalAnchor}${alias}]]`;
  });
  return { content: next, changed };
}
```

Note: the JSDoc above `rewriteWikilinks` should gain a line documenting `mapAnchor`.
`rawAnchor` keeps its leading `#` so, when `mapAnchor` is omitted OR returns null,
the anchor is re-emitted **byte-for-byte** (matching the original code exactly) —
this is what keeps `move_note` (target-only) rewrites byte-identical. The
move_note call site is unaffected: it passes only `mapTarget`, so `mapAnchor` is
`undefined` and no anchor is ever remapped.

- [ ] **Step 4: Add the write tool to `src/tools/write.ts`**

Add `renameSection` to the import from `./note-document.js` (the block at ~line 6-18). Add `headingMatchesAnchor` to the import from `./vault.js` (~line 4, which already imports `rewriteWikilinks`). Add `"rename_section"` to `WRITE_TOOL_NAMES` (~line 24-42). After `patchNote` (~line 446), add:

```ts
export interface RenameSectionParams {
  path: string;
  from: string;
  to: string;
  /** Rewrite inbound `[[note#from]]` anchors elsewhere in the vault. Default true. */
  update_anchors?: boolean;
}

/**
 * Rename a heading in a note and (by default) rewrite every inbound
 * `[[note#oldHeading]]` anchor across the vault to the new heading — the
 * heading-level analogue of {@link moveNote}. Anchors match case-insensitively
 * (literal text, not Obsidian slugs); block refs (`#^id`) are never rewritten.
 * Fails loud on a missing or ambiguous `from` heading.
 */
export async function renameSectionInVault(
  vaultPath: string,
  { path, from, to, update_anchors = true }: RenameSectionParams
): Promise<{
  path: string;
  from: string;
  to: string;
  updated_notes: number;
  updated_links: number;
}> {
  if (typeof from !== "string" || from.trim().length === 0) {
    throw new Error("from must be a non-empty string");
  }
  if (typeof to !== "string" || to.trim().length === 0) {
    throw new Error("to must be a non-empty string");
  }

  const canon = canonicalName(path);

  // Capture backlinks + resolve the canonical note path from the pre-write index.
  let backlinks: string[] = [];
  let notePath = canon;
  if (update_anchors) {
    const index = await getIndex(vaultPath);
    notePath = index.resolve(canon) ?? canon;
    backlinks = index.backlinks(notePath);
  }

  // Rename the local heading (fails loud before any snapshot on missing/ambiguous).
  const raw = await readRaw(vaultPath, path);
  const doc = NoteDocument.parse(raw);
  const oldHeading = renameSection(doc, from, to);

  await snapshotBeforeWrite(vaultPath);
  await writeResolved(vaultPath, path, doc.serialize());

  let updatedNotes = 0;
  let updatedLinks = 0;
  if (update_anchors && backlinks.length > 0) {
    const noteLower = notePath.toLowerCase();
    const noteBase = notePath.split("/").pop()!.toLowerCase();
    for (const backlink of backlinks) {
      let btext: string;
      try {
        btext = await readFile(resolveNotePath(vaultPath, backlink), "utf-8");
      } catch {
        continue;
      }
      const { content, changed } = rewriteWikilinks(
        btext,
        () => null, // never change the note target
        (target, anchor) => {
          const norm = target.replace(/\.md$/i, "").replace(/\\/g, "/").toLowerCase();
          const pointsHere =
            norm === noteLower || (!norm.includes("/") && norm === noteBase);
          if (!pointsHere) return null;
          return headingMatchesAnchor(oldHeading, anchor) ? to.trim() : null;
        }
      );
      if (changed > 0) {
        await writeResolved(vaultPath, backlink, content);
        updatedNotes++;
        updatedLinks += changed;
      }
    }
  }

  return { path: canon, from: oldHeading, to: to.trim(), updated_notes: updatedNotes, updated_links: updatedLinks };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx tsx --test tests/rename-section.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Run the full suite (rewriteWikilinks change touches move_note)**

Run: `npm test`
Expected: PASS — especially `tests/move.test.ts` (target-only rewrites must be byte-identical to before).

- [ ] **Step 7: Commit**

```bash
git add src/tools/vault.ts src/tools/write.ts tests/rename-section.test.ts
git commit -m "feat: rename_section write tool rewrites inbound heading anchors

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `broken_anchors` vault-issue kind

**Files:**
- Modify: `src/types.ts` (`ListVaultIssuesParams.kind` gains `"broken_anchors"`; add `BrokenAnchorGroup`)
- Modify: `src/tools/vault-issues.ts` (handle the new kind)
- Test: `tests/broken-anchors.test.ts` (create)

**Interfaces:**
- Consumes: `IndexEntry.linkRefs` (Task 1), `headingMatchesAnchor` (Task 1), `index.resolve`, `index.getEntries`.
- Produces:
  - `interface BrokenAnchorGroup { source: string; targets: { target: string; anchor: string }[] }`
  - `list_vault_issues` accepts `kind: "broken_anchors"` returning `ListResponse<BrokenAnchorGroup>`.

- [ ] **Step 1: Write the failing test**

Create `tests/broken-anchors.test.ts`:

```ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { listVaultIssues } from "../src/tools/vault-issues.js";
import { makeVault, Fixture } from "./fixtures.js";
import { BrokenAnchorGroup } from "../src/types.js";

let fx: Fixture;
before(async () => {
  fx = await makeVault([
    { path: "target.md", content: "# Target\n\n## Real Heading\n\nbody\n" },
    {
      path: "src.md",
      content:
        "# Src\n" +
        "good [[target#Real Heading]], " +   // valid → not broken
        "bad [[target#Gone]], " +            // broken heading anchor
        "case [[target#real heading]], " +   // valid (case-insensitive)
        "block [[target#^blk]], " +          // block ref → ignored
        "missing [[nowhere#Gone]], " +       // unresolved NOTE → not our concern
        "plain [[target]].\n",               // no anchor → ignored
    },
    { path: "clean.md", content: "# Clean\n[[target#Real Heading]]\n" },
  ]);
});
after(() => fx.cleanup());

test("broken_anchors surfaces only resolved-note heading anchors with no match", async () => {
  const res = (await listVaultIssues(fx.vaultPath, { kind: "broken_anchors" })) as {
    results: BrokenAnchorGroup[];
    returned: number;
    truncated: boolean;
  };
  assert.equal(res.results.length, 1);
  const group = res.results[0];
  assert.equal(group.source, "src");
  assert.deepEqual(group.targets, [{ target: "target", anchor: "Gone" }]);
});

test("broken_anchors truncation counts groups", async () => {
  const res = (await listVaultIssues(fx.vaultPath, { kind: "broken_anchors", limit: 0 })) as {
    returned: number;
    omitted: number;
  };
  assert.equal(res.omitted, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/broken-anchors.test.ts`
Expected: FAIL — kind rejected / `BrokenAnchorGroup` missing.

- [ ] **Step 3: Add the type**

In `src/types.ts`, change `ListVaultIssuesParams.kind` (~line 214) to:

```ts
  kind: "orphans" | "unresolved_links" | "broken_anchors";
```

And add near `UnresolvedLinkGroup`:

```ts
/** A source note and its `[[note#heading]]` anchors that match no heading. */
export interface BrokenAnchorGroup {
  source: string;
  targets: { target: string; anchor: string }[];
}
```

- [ ] **Step 4: Handle the kind in `vault-issues.ts`**

Import `headingMatchesAnchor` from `./vault.js` and `BrokenAnchorGroup` from `../types.js`. Change the kind guard (~line 29) to also allow `"broken_anchors"`. Update the return type union to include `ListResponse<BrokenAnchorGroup>`. Before the final return, add a branch:

```ts
  if (kind === "broken_anchors") {
    const groups: BrokenAnchorGroup[] = [];
    for (const entry of index.getEntries()) {
      const targets: { target: string; anchor: string }[] = [];
      for (const ref of entry.linkRefs) {
        if (ref.anchor == null || ref.isBlockRef) continue;
        // A self-anchor ([[#heading]]) resolves to the source note itself.
        const resolved = ref.target === "" ? entry.path : index.resolve(ref.target);
        if (!resolved) continue; // unresolved NOTE is unresolved_links' concern
        const target = index.getEntry(resolved);
        if (!target) continue;
        const ok = target.headings.some((h) => headingMatchesAnchor(h.text, ref.anchor!));
        if (!ok) targets.push({ target: ref.target, anchor: ref.anchor });
      }
      if (targets.length > 0) groups.push({ source: entry.path, targets });
    }
    return toListResponse(groups, effectiveLimit === 0 ? undefined : effectiveLimit);
  }
```

Verify `index.getEntry(path)` exists on `VaultIndex`; if the accessor is named differently (e.g. `entry(path)` or a `byPath` lookup returning the entry), use that. If no single-entry accessor exists, resolve via `index.getEntries().find(e => e.path === resolved)` — but prefer an existing O(1) accessor.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx tsx --test tests/broken-anchors.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/tools/vault-issues.ts tests/broken-anchors.test.ts
git commit -m "feat: broken_anchors — third list_vault_issues kind for dead heading anchors

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: MCP registration + query-CLI subcommands

**Files:**
- Modify: `src/index.ts` (register `rename_section` tool + dispatch; add `broken_anchors` to the `list_vault_issues` `kind` enum description)
- Modify: `src/query-cli.ts` (add `rename-section` command; ensure `vault-issues broken_anchors` works)
- Test: `tests/rename-section-cli.test.ts` (create) — CLI smoke, mirroring `tests/folders-cli.test.ts`

**Interfaces:**
- Consumes: `renameSectionInVault` (Task 3), `RenameSectionParams`, `listVaultIssues` broken_anchors (Task 4).

**CLI structure (verified against live source):** The CLI is NOT commander
`.action`-does-the-work; each `.command()` block calls
`queryTool(toolName, args, verbose)`, and `queryTool` has an `if/else if` chain
dispatching `toolName` → the tool function. So Task 5 has THREE CLI edits: a
`.command()` block, a new `else if` arm in `queryTool`, and an import. The
`vault-issues <kind>` command already forwards an arbitrary `kind`, so
`broken_anchors` needs NO CLI change.

- [ ] **Step 2: Write the failing CLI test**

Create `tests/rename-section-cli.test.ts` modeled on `tests/folders-cli.test.ts`
(verified: it uses `execFile` via `promisify`, `CLI = ["tsx", "src/query-cli.ts"]`,
and runs `npx` with `OBSIDIAN_VAULT_PATH` in env, parsing `JSON.parse(stdout)`):

```ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { makeVault, Fixture } from "./fixtures.js";

const run = promisify(execFile);
const CLI = ["tsx", "src/query-cli.ts"];

let fx: Fixture;
before(async () => {
  fx = await makeVault([
    { path: "t.md", content: "# T\n\n## Old Heading\n\nbody\n" },
    { path: "r.md", content: "# R\n[[t#Old Heading]] and [[t#Dead]].\n" },
  ]);
});
after(() => fx.cleanup());

const cli = async (args: string[]) =>
  run("npx", [...CLI, ...args], { env: { ...process.env, OBSIDIAN_VAULT_PATH: fx.vaultPath } });

test("rename-section CLI renames and rewrites anchors", async () => {
  const { stdout } = await cli(["rename-section", "t", "Old Heading", "New Heading"]);
  const res = JSON.parse(stdout);
  assert.equal(res.updated_notes, 1);
  assert.match(await readFile(join(fx.vaultPath, "t.md"), "utf-8"), /## New Heading/);
  assert.match(await readFile(join(fx.vaultPath, "r.md"), "utf-8"), /\[\[t#New Heading\]\]/);
});

test("vault-issues broken_anchors CLI lists dead anchors", async () => {
  const { stdout } = await cli(["vault-issues", "broken_anchors"]);
  const res = JSON.parse(stdout);
  // After the rename above, r.md's [[t#Dead]] is the surviving broken anchor.
  assert.ok(res.results.some((g: any) => g.targets.some((t: any) => t.anchor === "Dead")));
});
```

Note: these two tests share `fx` and run in order (the rename precedes the
broken-anchors check), so the second asserts on `Dead` (the anchor that was never
valid), not `Old Heading`.

- [ ] **Step 3: Run test to verify it fails**

Run: `npx tsx --test tests/rename-section-cli.test.ts`
Expected: FAIL — `rename-section` command unknown.

- [ ] **Step 4: Register the MCP tool in `src/index.ts`**

Import `renameSectionInVault` and `RenameSectionParams` (alongside the existing `moveNote` import, ~line 38). Add a tool entry near `move_note` (~line 514) in the tools list:

```ts
      {
        name: "rename_section",
        description: "Rename a heading in a note and rewrite every inbound [[note#heading]] anchor across the vault to the new heading, so renaming a section never breaks the link graph. Fails loud on a missing or ambiguous heading. Anchors match case-insensitively; block refs (#^id) are never rewritten.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative note path (with or without .md)" },
            from: { type: "string", description: "Existing heading — a bare heading or a \" > \"-joined heading-path" },
            to: { type: "string", description: "New heading text" },
            update_anchors: { type: "boolean", description: "Rewrite inbound [[note#heading]] anchors elsewhere in the vault (default: true)" }
          },
          required: ["path", "from", "to"]
        }
      },
```

Add the dispatch case near `case "move_note"` (~line 932):

```ts
      case "rename_section": {
        const result = await renameSectionInVault(VAULT_PATH, (args ?? {}) as unknown as RenameSectionParams);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
```

In the `list_vault_issues` tool's `kind` schema (find its `inputSchema`), add `"broken_anchors"` to the enum and mention it in the description.

- [ ] **Step 5: Add the `rename-section` CLI command + dispatch in `src/query-cli.ts`**

(a) Import `renameSectionInVault` alongside the other write-tool imports from `./tools/write.js` (the same import that brings in `patchNote`, `moveNote`).

(b) Add a `.command()` block modeled exactly on `rename-property <path> <from> <to>` (~line 721), with a `--no-update-anchors` option. Commander turns `--no-update-anchors` into `options.updateAnchors` (defaulting `true`):

```ts
program
  .command("rename-section <path> <from> <to>")
  .description("Rename a heading and rewrite inbound [[note#heading]] anchors")
  .option("--no-update-anchors", "Do not rewrite inbound anchors")
  .action(async (path: string, from: string, to: string, options: any, command: Command) => {
    await queryTool(
      "rename_section",
      { path, from, to, update_anchors: options.updateAnchors },
      command.parent?.opts().verbose
    );
  });
```

(c) Add the dispatch arm inside `queryTool`'s `if/else if` chain (near the `patch_note` arm, ~line 112):

```ts
    } else if (toolName === "rename_section") {
      result = await renameSectionInVault(VAULT_PATH!, args);
```

`vault-issues <kind>` (~line 387) already forwards an arbitrary `kind`, so `broken_anchors` needs no CLI change.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx tsx --test tests/rename-section-cli.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/index.ts src/query-cli.ts tests/rename-section-cli.test.ts
git commit -m "feat: register rename_section MCP tool + query-CLI subcommand

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Documentation

**Files:**
- Modify: `CLAUDE.md` (add `rename_section` under Writing tools; add `broken_anchors` to `list_vault_issues`; add CLI examples)
- Modify: `README.md` (same additions, matching its structure)

- [ ] **Step 1: Update `CLAUDE.md`**

- Add a `### rename_section` entry in the Writing tools section (after `replace_section`), documenting purpose, input (`path`, `from`, `to`, `update_anchors`), output (`{ path, from, to, updated_notes, updated_links }`), the case-insensitive anchor match, block-ref exclusion, and fail-loud ambiguity.
- In `### list_vault_issues`, add `"broken_anchors"` to the `kind` list and describe its `{ source, targets: [{ target, anchor }] }` output and group-based truncation. Note it covers "note resolves, heading doesn't" (complement of `unresolved_links`).
- Add CLI examples: `npm run query -- rename-section "projects/alpha" "Old Heading" "New Heading"` and `npm run query -- vault-issues broken_anchors --limit 50`.
- Add `rename_section` to the count in the writes-gating sentence ("the seventeen write tools" → "the eighteen write tools").

- [ ] **Step 2: Update `README.md`**

Mirror the same three additions in README.md's structure (tool list, vault-issues kinds, CLI examples, and any write-tool count).

- [ ] **Step 3: Verify docs match reality**

Run: `npm test` (final green check) and re-read both edited sections for accuracy against the implemented signatures.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: document rename_section and broken_anchors

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review Notes

- **Spec coverage:** Section 1 (index foundation) → Task 1. Section 2 (rename_section) → Tasks 2+3. Section 3 (broken_anchors) → Task 4. Section 4 (surface/tests/docs) → Tasks 5+6. All covered.
- **Type consistency:** `LinkRef`/`extractLinkRefs`/`headingMatchesAnchor` (Task 1) consumed by Tasks 3+4; `renameSection` returns old heading text (Task 2) consumed by Task 3; `renameSectionInVault` (Task 3) consumed by Task 5; `BrokenAnchorGroup` (Task 4) consumed by Task 5 CLI + Task 6 docs.
- **Live-source verification (done during planning):** `VaultIndex.getEntry(path): IndexEntry | undefined` exists (O(1), `src/tools/vault-index.ts:210`) — Task 4 uses it directly. The query CLI dispatches via `queryTool(toolName, args, verbose)` + an `if/else if` chain (not commander `.action` bodies); `rename-section` is modeled on the verified `rename-property <path> <from> <to>` block, and `vault-issues <kind>` already forwards arbitrary kinds so `broken_anchors` needs no CLI change. Task 5 instructions reflect this.
- **Write-tool count:** CLAUDE.md currently says "seventeen"; Task 6 bumps to "eighteen".
