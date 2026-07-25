# `list_notes` Default Limit + Truncation Signal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `list_notes` a default limit (100) and a first-class truncation signal so the agent's first orientation call is bounded and a capped result is never mistaken for complete.

**Architecture:** Change `listNotes` to return an envelope `{ notes, total, returned, truncated }` (mirroring the existing `search_notes` `SearchNotesResponse` precedent) instead of a bare `NoteHeader[]`. Apply a default limit of 100 when `limit` is omitted; treat explicit `limit: 0` as unbounded (matching `search_notes`). The MCP handler and query CLI already `JSON.stringify` whatever the tool returns, so they need no logic change — only tests, callers reading the result, and docs ripple.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node's built-in `node:test` runner via `tsx`, no extra test deps.

## Global Constraints

- ESM imports use `.js` specifiers even for `.ts` sources (e.g. `import { listNotes } from "../src/tools/list.js"`).
- Tests run with `npm test` (Node `node:test` via `tsx`). Run a single file with `npx tsx --test tests/<file>.test.ts`.
- `CLAUDE.md` and `README.md` must stay in sync — any documented behavior change updates **both** (repo documentation rule).
- Default limit is exactly **100**. `limit: 0` means **unbounded**. Any other non-positive or non-integer `limit` throws `limit must be a positive integer`.
- Do not change `NoteHeader` or `ListNotesParams`. Do not touch other listing tools (`list_files`, `list_recent_notes`, `find_by_tag`, etc.).
- Commit messages end with the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer.
- All git/file operations use the worktree at `.claude/worktrees/list-notes-default-limit`. Because absolute-path writes can resolve against the main checkout, prefer worktree-relative paths and verify `git status` shows changes on branch `worktree-list-notes-default-limit` before committing.

---

### Task 1: Add the `ListNotesResponse` envelope type

**Files:**
- Modify: `src/types.ts` (add interface after `NoteHeader`, near line 79)

**Interfaces:**
- Consumes: existing `NoteHeader` interface.
- Produces: `ListNotesResponse` — `{ notes: NoteHeader[]; total: number; returned: number; truncated: boolean }`. Task 2's `listNotes` returns this; Tasks 3–5 read `.notes`/`.total`/`.truncated`.

- [ ] **Step 1: Add the interface**

In `src/types.ts`, immediately after the closing brace of the `NoteHeader` interface (currently ending at line 79) and before `ParsedHeading`, insert:

```ts
/** The bounded result of `listNotes`, with truncation metadata. */
export interface ListNotesResponse {
  /** Matching note headers, at most `limit` entries (unless limit is 0). */
  notes: NoteHeader[];
  /** Notes matching the folder filter, before the limit was applied. */
  total: number;
  /** Number of notes in `notes` (== notes.length). */
  returned: number;
  /** True if the limit dropped notes (total > returned). */
  truncated: boolean;
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: PASS (no type errors). The interface is not yet referenced, which is fine.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: add ListNotesResponse envelope type

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Implement default limit + truncation in `listNotes`

This is the core behavior change, done TDD. All test edits and the implementation ship together because the existing tests assert the *old* bare-array shape and would break the moment the implementation changes — they must move in lockstep.

**Files:**
- Modify: `src/tools/list.ts` (whole `listNotes` body, lines 10–37)
- Test: `tests/list.test.ts` (rewrite assertions for the envelope; add default-limit, truncation, and `limit: 0` cases)

**Interfaces:**
- Consumes: `ListNotesResponse` from Task 1; `getIndex`, `entryToHeader` from `./vault-index.js`; `ListNotesParams` from `../types.js`.
- Produces: `listNotes(vaultPath, params): Promise<ListNotesResponse>`. Tasks 3 (CLI — no code change but relies on the shape) and 5 (docs) describe this shape; Task 4 (`cache.test.ts`) reads `.notes`.

- [ ] **Step 1: Rewrite the test file to the envelope shape and new behavior**

Replace the entire contents of `tests/list.test.ts` with:

```ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { listNotes } from "../src/tools/list.js";
import { makeVault, sampleNotes, FixtureNote, Fixture } from "./fixtures.js";

let fx: Fixture;
before(async () => {
  fx = await makeVault(sampleNotes());
});
after(() => fx.cleanup());

test("returns an envelope with notes sorted by path", async () => {
  const res = await listNotes(fx.vaultPath);
  assert.deepEqual(
    res.notes.map((n) => n.path),
    ["Beta Note", "daily/2026-07-22", "index", "projects/alpha"]
  );
});

test("reports total, returned, and untruncated for a small vault", async () => {
  const res = await listNotes(fx.vaultPath);
  assert.equal(res.total, 4);
  assert.equal(res.returned, 4);
  assert.equal(res.returned, res.notes.length);
  assert.equal(res.truncated, false);
});

test("uses frontmatter title, falling back to basename", async () => {
  const res = await listNotes(fx.vaultPath);
  const byPath = Object.fromEntries(res.notes.map((n) => [n.path, n]));
  assert.equal(byPath["index"].title, "Home"); // frontmatter title
  assert.equal(byPath["Beta Note"].title, "Beta Note"); // basename fallback
});

test("extracts the first heading as headline", async () => {
  const res = await listNotes(fx.vaultPath);
  const alpha = res.notes.find((n) => n.path === "projects/alpha");
  assert.equal(alpha?.headline, "Alpha");
});

test("filters by folder without matching sibling prefixes", async () => {
  const res = await listNotes(fx.vaultPath, { folder: "projects" });
  assert.deepEqual(
    res.notes.map((n) => n.path),
    ["projects/alpha"]
  );
  assert.equal(res.total, 1);
  assert.equal(res.truncated, false);
});

test("respects an explicit limit and reports truncation", async () => {
  const res = await listNotes(fx.vaultPath, { limit: 2 });
  assert.equal(res.notes.length, 2);
  assert.equal(res.returned, 2);
  assert.equal(res.total, 4);
  assert.equal(res.truncated, true);
});

test("limit >= total is not truncated", async () => {
  const res = await listNotes(fx.vaultPath, { limit: 4 });
  assert.equal(res.returned, 4);
  assert.equal(res.truncated, false);
});

test("limit 0 returns every note, untruncated", async () => {
  const res = await listNotes(fx.vaultPath, { limit: 0 });
  assert.equal(res.returned, 4);
  assert.equal(res.total, 4);
  assert.equal(res.truncated, false);
});

test("rejects a negative limit", async () => {
  await assert.rejects(
    () => listNotes(fx.vaultPath, { limit: -1 }),
    /positive integer/
  );
});

test("rejects a non-integer limit", async () => {
  await assert.rejects(
    () => listNotes(fx.vaultPath, { limit: 1.5 }),
    /positive integer/
  );
});

test("applies a default limit of 100 and reports truncation", async () => {
  const many: FixtureNote[] = [];
  for (let i = 0; i < 150; i++) {
    const n = String(i).padStart(3, "0");
    many.push({ path: `bulk/note-${n}.md`, content: `# Note ${n}\n` });
  }
  const big = await makeVault(many);
  try {
    const res = await listNotes(big.vaultPath);
    assert.equal(res.total, 150);
    assert.equal(res.returned, 100);
    assert.equal(res.notes.length, 100);
    assert.equal(res.truncated, true);

    // limit 0 escapes the default and returns all 150.
    const all = await listNotes(big.vaultPath, { limit: 0 });
    assert.equal(all.returned, 150);
    assert.equal(all.truncated, false);
  } finally {
    await big.cleanup();
  }
});
```

Note: `FixtureNote` and `Fixture` are already exported from `tests/fixtures.js` (see `tests/fixtures.ts:6` and `:15`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test tests/list.test.ts`
Expected: FAIL. The current `listNotes` returns a bare array, so `res.notes` is `undefined` and `res.notes.map` throws / assertions on `res.total` fail. (The `limit: 0` test currently *throws* in the implementation, which is the old behavior we're replacing.)

- [ ] **Step 3: Rewrite `listNotes` to apply the default and return the envelope**

Replace the entire body of `src/tools/list.ts` with:

```ts
import { assertVaultPath } from "./vault.js";
import { getIndex, entryToHeader } from "./vault-index.js";
import { ListNotesParams, ListNotesResponse } from "../types.js";

/** Default cap on `list_notes` so the first orientation call is bounded. */
const DEFAULT_LIMIT = 100;

/**
 * List notes in the vault as lightweight headers (path, title, tags, first
 * heading, size, mtime) without returning full contents. Gives an agent a
 * "table of contents" so it can orient itself before searching or reading.
 *
 * Bounded by default: with no `limit`, at most `DEFAULT_LIMIT` notes are
 * returned. Pass `limit: 0` for an unbounded list (matching `search_notes`).
 * The result is an envelope reporting `total`/`returned`/`truncated` so a
 * capped list is never mistaken for a complete one.
 */
export async function listNotes(
  vaultPath: string,
  params: ListNotesParams = {}
): Promise<ListNotesResponse> {
  assertVaultPath(vaultPath);

  const { folder, limit } = params;

  // `limit: 0` is the sentinel for "unbounded"; any other non-positive or
  // non-integer value is rejected. Omitting `limit` applies DEFAULT_LIMIT.
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
    throw new Error("limit must be a positive integer");
  }

  const index = await getIndex(vaultPath);
  let entries = index.getEntries();

  if (folder && typeof folder === "string" && folder.trim()) {
    // Normalize the folder prefix to forward slashes with a trailing slash so
    // "projects" matches "projects/foo" but not "projects-archive/foo".
    const prefix = folder.replace(/[\\/]+$/, "").replace(/\\/g, "/") + "/";
    entries = entries.filter((e) => (e.path + "/").startsWith(prefix));
  }

  const total = entries.length;

  // Resolve the effective cap: explicit 0 => unbounded; omitted => default.
  const effectiveLimit = limit === undefined ? DEFAULT_LIMIT : limit;
  if (effectiveLimit !== 0) {
    entries = entries.slice(0, effectiveLimit);
  }

  const notes = entries.map(entryToHeader);
  return {
    notes,
    total,
    returned: notes.length,
    truncated: total > notes.length,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test tests/list.test.ts`
Expected: PASS (all list tests green).

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS. (If `cache.test.ts` or another consumer now type-errors on the bare-array assumption, that is expected and fixed in Task 4 — but `tsc` over `.test.ts` files may surface it here. If so, proceed to Task 4 before relying on a clean `tsc`; the `list.test.ts` file itself must type-check cleanly.)

- [ ] **Step 6: Commit**

```bash
git add src/tools/list.ts tests/list.test.ts
git commit -m "feat: default limit and truncation signal for list_notes

listNotes now returns { notes, total, returned, truncated } and caps at
100 by default; limit: 0 means unbounded (matching search_notes).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Update the MCP tool description in `index.ts`

The `list_notes` handler already does `JSON.stringify(results)` on whatever `listNotes` returns (`src/index.ts:734-739`), so the envelope flows through unchanged. Only the agent-facing schema/description needs to state the new default and `0` convention.

**Files:**
- Modify: `src/index.ts` (tool registration block, lines 177–192)

**Interfaces:**
- Consumes: `listNotes` returning `ListNotesResponse` (Task 2). No handler code change.
- Produces: updated tool metadata only.

- [ ] **Step 1: Update the description and the `limit` schema text**

In `src/index.ts`, in the `list_notes` tool object (starting at line 177), replace the `description` field value and the `limit` property description.

Change the `description` from:

```ts
        description: "List notes in the vault as lightweight headers (path, title, tags, first heading, size, modified time) without full contents. Use it to discover what exists and orient before searching or reading.",
```

to:

```ts
        description: "List notes in the vault as lightweight headers (path, title, tags, first heading, size, modified time) without full contents. Use it to discover what exists and orient before searching or reading. Returns { notes, total, returned, truncated }: notes is capped at 100 by default (pass limit: 0 for all notes), and truncated is true when the cap dropped notes.",
```

Change the `limit` property from:

```ts
            limit: {
              type: "number",
              description: "Maximum number of notes to return"
            }
```

to:

```ts
            limit: {
              type: "number",
              description: "Maximum number of notes to return (default 100; pass 0 for unbounded)"
            }
```

- [ ] **Step 2: Type-check and confirm the handler still compiles**

Run: `npx tsc --noEmit`
Expected: PASS. (The handler at line 734 stringifies the result generically; no change needed there.)

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "docs: describe list_notes default limit in MCP tool schema

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Fix the `cache.test.ts` caller for the new shape

`tests/cache.test.ts` calls `listNotes` twice and reads the result as a bare array (`before.some(...)`, `after.some(...)`). Those become `.notes.some(...)`.

**Files:**
- Modify: `tests/cache.test.ts` (lines 31 and 36–37)

**Interfaces:**
- Consumes: `listNotes` returning `ListNotesResponse` (Task 2).
- Produces: nothing new.

- [ ] **Step 1: Run the full suite to see the failure**

Run: `npm test`
Expected: FAIL in `tests/cache.test.ts` — the "drops entries for deleted files" test calls `before.some(...)` on an object that no longer has `.some`, throwing `before.some is not a function`.

- [ ] **Step 2: Update the two assertions**

In `tests/cache.test.ts`, in the "drops entries for deleted files" test, change:

```ts
    const before = await listNotes(fx.vaultPath);
    assert.ok(before.some((n) => n.path === "Beta Note"));

    await rm(join(fx.vaultPath, "Beta Note.md"));

    const after = await listNotes(fx.vaultPath);
    assert.ok(!after.some((n) => n.path === "Beta Note"));
```

to:

```ts
    const before = await listNotes(fx.vaultPath);
    assert.ok(before.notes.some((n) => n.path === "Beta Note"));

    await rm(join(fx.vaultPath, "Beta Note.md"));

    const after = await listNotes(fx.vaultPath);
    assert.ok(!after.notes.some((n) => n.path === "Beta Note"));
```

- [ ] **Step 3: Run the full suite to verify it passes**

Run: `npm test`
Expected: PASS. All tests green (was 254; now higher due to the new list tests). 0 failures.

- [ ] **Step 4: Commit**

```bash
git add tests/cache.test.ts
git commit -m "test: read list_notes envelope in cache test

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Update `CLAUDE.md` and `README.md`

Both docs describe `list_notes` as returning a bare array with an unbounded `limit`. Update both to the envelope shape, the default of 100, and the `0 = unbounded` convention. The repo rule requires both files change together.

**Files:**
- Modify: `CLAUDE.md` (`### list_notes` section, starting line 53)
- Modify: `README.md` (`### list_notes` section, lines 277–285)

**Interfaces:**
- Consumes: the shipped behavior from Tasks 2–3.
- Produces: nothing (documentation).

- [ ] **Step 1: Update `CLAUDE.md`**

In `CLAUDE.md`, replace the `list_notes` `Input` and `Output` bullets. Change:

```markdown
- **Input**:
  - `folder` (optional): Restrict to notes under this folder (relative to the vault root)
  - `limit` (optional): Maximum number of notes to return
- **Output**: Array of note headers with `path`, `title` (frontmatter title or basename), `tags`, `headline` (first markdown heading), `size`, and `modified` (ISO timestamp)
```

to:

```markdown
- **Input**:
  - `folder` (optional): Restrict to notes under this folder (relative to the vault root)
  - `limit` (optional): Maximum number of notes to return (default `100`; pass `0` for unbounded — no cap)
- **Output**: `{ notes, total, returned, truncated }` — `notes` is the array of note headers (`path`, `title` (frontmatter title or basename), `tags`, `headline` (first markdown heading), `size`, `modified` (ISO timestamp)), bounded by `limit` (default `100`); `total` is the count before the limit, `returned` is `notes.length`, and `truncated` is `true` when the limit dropped notes — so a capped first-orientation call isn't mistaken for a complete one.
```

- [ ] **Step 2: Update `README.md`**

In `README.md`, in the `### list_notes` section, change:

```markdown
**Parameters:**
- `folder` (string, optional): Restrict to notes under this folder (relative to the vault root)
- `limit` (number, optional): Maximum number of notes to return

**Returns:** Array of note headers with `path`, `title` (frontmatter title or basename), `tags`, `headline` (first markdown heading), `size`, and `modified` (ISO timestamp).
```

to:

```markdown
**Parameters:**
- `folder` (string, optional): Restrict to notes under this folder (relative to the vault root)
- `limit` (number, optional): Maximum number of notes to return (default `100`; pass `0` for unbounded — no cap)

**Returns:** `{ notes, total, returned, truncated }`. `notes` is the array of note headers (`path`, `title` (frontmatter title or basename), `tags`, `headline` (first markdown heading), `size`, `modified` (ISO timestamp)), bounded by `limit` (default `100`). `total` is the match count before the limit, `returned` is `notes.length`, and `truncated` is `true` when the limit dropped notes.
```

- [ ] **Step 3: Verify no other doc references the old shape**

Run: `grep -n "list_notes" CLAUDE.md README.md`
Expected: remaining hits are cross-references ("same shape as `list_notes`") for *other* tools and the tool-list line — those are fine and unchanged. Confirm the `list_notes` section itself now reads as the envelope. (Note: several other tools say "same shape as `list_notes`" meaning the *header* shape; those remain correct because the headers inside `notes` are unchanged.)

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: document list_notes default limit + envelope shape

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Final full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Run the whole suite**

Run: `npm test`
Expected: PASS, 0 failures. Count is the prior 254 plus the net-new `list.test.ts` cases (the file went from 6 tests to 11).

- [ ] **Step 2: Type-check the whole project**

Run: `npx tsc --noEmit`
Expected: PASS, no errors.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: PASS — compiles to `dist/` with no errors.

- [ ] **Step 4: Smoke-test the CLI against a real listing (optional but recommended)**

Run: `OBSIDIAN_VAULT_PATH=<some vault> npm run query -- list --limit 2`
Expected: prints the envelope JSON `{ "notes": [...2 items...], "total": N, "returned": 2, "truncated": true }`. Confirms the CLI print path handles the new shape (it stringifies generically, so this is a sanity check, not a code change).

- [ ] **Step 5: Confirm the branch is clean and all work is committed**

Run: `git status && git log --oneline -6`
Expected: working tree clean; the six commits from Tasks 1–5 (plus the earlier spec commit) present on `worktree-list-notes-default-limit`.

---

## Self-Review

**Spec coverage:**
- Default limit 100 → Task 2 (`DEFAULT_LIMIT`, default-limit test).
- `limit: 0` unbounded → Task 2 (validation `< 0`, `effectiveLimit` branch, `limit: 0` tests).
- Envelope `{ notes, total, returned, truncated }` → Task 1 (type) + Task 2 (return).
- Truncation signal → Task 2 (`truncated: total > notes.length`, truncation tests).
- Negative/non-integer still throws → Task 2 ("rejects a negative/non-integer limit" tests).
- `folder` unchanged, `total` post-filter pre-limit → Task 2 (folder test asserts `total`).
- MCP description update → Task 3.
- CLI prints envelope unchanged → Task 6 Step 4 (verify only; spec noted no code change).
- `cache.test.ts` ripple → Task 4.
- `CLAUDE.md` + `README.md` → Task 5.
- All 254 existing tests still pass → Task 4 Step 3 + Task 6.
- Out-of-scope (no other tools, no pagination) → respected; no task touches them.

**Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to Task N". Every code step shows full code. The one conditional note (Task 2 Step 5 about `tsc` surfacing the `cache.test.ts` error early) is a real ordering caveat, not a placeholder.

**Type consistency:** `ListNotesResponse` fields (`notes`, `total`, `returned`, `truncated`) are identical across Task 1 (definition), Task 2 (construction), Task 3 (description text), Task 4 (`.notes`), and Task 5 (docs). `listNotes` signature `(vaultPath, params) => Promise<ListNotesResponse>` is consistent throughout. `DEFAULT_LIMIT = 100` used once. `FixtureNote`/`Fixture` imports match `tests/fixtures.ts` exports.
