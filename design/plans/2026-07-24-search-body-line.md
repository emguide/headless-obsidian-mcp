# search_notes `body_line` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `search_notes` match rows gain `body_line` — the body-relative (frontmatter-stripped) 1-based line number used by `get_outline`/`list_tasks`/`set_task_state` — alongside ripgrep's file-absolute `line_number`, `null` for hits inside the frontmatter block, so a grep hit can be handed directly to the task/section addressing surface.

**Architecture:** The vault index (`buildEntry`) already parses each note with gray-matter; it additionally records `bodyBegin`, the count of raw lines the frontmatter block occupies before `matter(raw).content` starts. `searchNotes` annotates each collected match with `body_line = line_number - bodyBegin` (or `null` when the hit falls inside the block, or the file is unknown to the index) in a single pass after parsing ripgrep output. Computing the offset from the **same gray-matter parse** that backs `list_tasks`/`get_outline` makes agreement structural — the `NoteDocument` fence-regex divergence on trailing-whitespace closing fences can never leak in.

**Tech Stack:** TypeScript, gray-matter, Node's `node:test` via tsx.

## Global Constraints

- Work happens in a git worktree (CLAUDE.md: anything beyond trivial work), created via `superpowers:using-git-worktrees` at execution time. All file paths below are worktree-relative — never edit the main checkout (see memory `worktree-path-mismatch`).
- Body-line convention (frozen): 1-based, body-relative, frontmatter stripped by **gray-matter** (`matter(raw).content`) — identical to `list_tasks`/`get_outline`/`set_task_state`. Never use `NoteDocument`'s fence regex for line math (memory `frontmatter-stripper-divergence`).
- The change is **additive**: `line_number` keeps its exact current meaning (ripgrep file-absolute); no existing field changes shape.
- Documentation rule (CLAUDE.md): functionality changes update **both** CLAUDE.md and README.md.
- Test suite: `npm test` (`tsx --test tests/*.test.ts`); single file: `npx tsx --test tests/<file>.test.ts`.

---

### Task 1: Index records `bodyBegin`

**Files:**
- Modify: `src/tools/vault-index.ts` (interface `IndexEntry` ~line 32; `buildEntry` ~line 307)
- Test: `tests/index-body-begin.test.ts` (create)

**Interfaces:**
- Consumes: existing `matter(raw)` parse inside `buildEntry`; `getIndex(vaultPath)`, `VaultIndex.getEntry(path)` (path = relative, no `.md`).
- Produces: `IndexEntry.bodyBegin: number` — raw lines before the gray-matter body starts (frontmatter block incl. fences); `0` when the note has no frontmatter or is unreadable. Task 2 relies on this exact name and semantics.

- [x] **Step 1: Write the failing test**

```typescript
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { getIndex } from "../src/tools/vault-index.js";
import { makeVault, Fixture } from "./fixtures.js";

let fx: Fixture;
before(async () => {
  fx = await makeVault([
    {
      path: "fm.md",
      content: ["---", "tags: [work]", "status: active", "---", "# Head", "body line"].join("\n"),
    },
    { path: "plain.md", content: "# Plain\nno frontmatter here\n" },
    {
      // Closing fence with trailing spaces: the case where gray-matter and
      // NoteDocument disagree. bodyBegin must follow gray-matter (the index's
      // own stripper), whatever it decides — asserted via the parsed task line.
      path: "tricky.md",
      content: "---\nk: v\n---   \n- [ ] tricky task\n",
    },
  ]);
});
after(async () => {
  await fx.cleanup();
});

test("bodyBegin counts the frontmatter block's raw lines", async () => {
  const index = await getIndex(fx.vaultPath);
  assert.equal(index.getEntry("fm")?.bodyBegin, 4);
});

test("bodyBegin is 0 for a note without frontmatter", async () => {
  const index = await getIndex(fx.vaultPath);
  assert.equal(index.getEntry("plain")?.bodyBegin, 0);
});

test("bodyBegin agrees with the index's own task line on a trailing-space fence", async () => {
  const index = await getIndex(fx.vaultPath);
  const entry = index.getEntry("tricky");
  assert.ok(entry);
  // The task sits on raw line 4 (1-based). Index task lines are 0-based
  // body-relative; bodyBegin must bridge the two exactly.
  const task = entry.tasks.find((t) => t.text.includes("tricky task"));
  assert.ok(task);
  assert.equal(entry.bodyBegin + task.line + 1, 4);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/index-body-begin.test.ts`
Expected: FAIL — `bodyBegin` is `undefined` (property does not exist yet).

- [x] **Step 3: Add `bodyBegin` to `IndexEntry` and compute it in `buildEntry`**

In the `IndexEntry` interface, after `tasks`:

```typescript
  /**
   * Raw lines before the gray-matter body starts (the frontmatter block
   * including both fences); 0 when the note has no frontmatter. Bridges
   * file-absolute line numbers (ripgrep) to the body-relative convention of
   * headings/tasks: body line = raw line - bodyBegin.
   */
  bodyBegin: number;
```

In `buildEntry`, add `let bodyBegin = 0;` alongside the other defaults, and inside the `try` right after `const parsed = matter(raw);`:

```typescript
    // Lines consumed by the frontmatter block, per gray-matter — the same
    // stripper whose body parseHeadings/parseTasks run on, so body-relative
    // line math stays consistent even on fences NoteDocument would swallow
    // differently. Relies on parsed.content being a suffix of raw (the same
    // invariant set_task_state's byte-preserving reattach uses).
    bodyBegin = raw.slice(0, raw.length - parsed.content.length).split("\n").length - 1;
```

Include `bodyBegin` in the returned object literal (after `tasks`).

- [x] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/index-body-begin.test.ts`
Expected: PASS (3 tests).

- [x] **Step 5: Run the full suite (the interface change touches every entry construction)**

Run: `npm test`
Expected: PASS. If any test constructs an `IndexEntry` literal by hand, add `bodyBegin: 0` there.

- [x] **Step 6: Commit**

```bash
git add src/tools/vault-index.ts tests/index-body-begin.test.ts
git commit -m "feat: index records bodyBegin (frontmatter raw-line offset) per note"
```

### Task 2: `search_notes` emits `body_line`

**Files:**
- Modify: `src/types.ts:43-51` (`SearchResult`)
- Modify: `src/tools/search.ts` (filter block ~line 100; match push ~line 220; after `flushCurrent()` ~line 250)
- Test: `tests/search-body-line.test.ts` (create)

**Interfaces:**
- Consumes: `IndexEntry.bodyBegin` (Task 1); `getIndex`, `VaultIndex.getEntry`; `listTasks(vaultPath, params?)` from `src/tools/tasks.ts` returning `ListResponse<TaskRow>` (rows carry 1-based body-relative `line`).
- Produces: each element of `SearchResult.matches` gains `body_line: number | null`.

- [x] **Step 1: Write the failing test**

```typescript
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { searchNotes } from "../src/tools/search.js";
import { listTasks } from "../src/tools/tasks.js";
import { makeVault, Fixture } from "./fixtures.js";

let fx: Fixture;
before(async () => {
  fx = await makeVault([
    {
      path: "fm.md",
      content: [
        "---",
        "tags: [work]",
        "status: active needle", // frontmatter hit for the null case
        "---",
        "# Head",
        "",
        "- [ ] needle task",
        "needle in body",
      ].join("\n"),
    },
    { path: "plain.md", content: "# Plain\nneedle here\n" },
    {
      // Trailing-space closing fence: gray-matter vs NoteDocument divergence.
      path: "tricky.md",
      content: "---\nk: v\n---   \n- [ ] tricky needle\n",
    },
  ]);
});
after(async () => {
  await fx.cleanup();
});

function matchesOf(result: Awaited<ReturnType<typeof searchNotes>>, path: string) {
  const file = result.results.find((r) => r.path === path);
  assert.ok(file, `expected a result for ${path}`);
  return file.matches;
}

test("body hits carry body_line = line_number minus the frontmatter block", async () => {
  const result = await searchNotes(fx.vaultPath, { pattern: "needle" });
  const matches = matchesOf(result, "fm");
  const task = matches.find((m) => m.content.includes("- [ ]"));
  const body = matches.find((m) => m.content.includes("in body"));
  assert.ok(task && body);
  assert.equal(task.line_number, 7);
  assert.equal(task.body_line, 3);
  assert.equal(body.line_number, 8);
  assert.equal(body.body_line, 4);
});

test("a hit inside the frontmatter block has body_line null", async () => {
  const result = await searchNotes(fx.vaultPath, { pattern: "needle" });
  const fmHit = matchesOf(result, "fm").find((m) => m.content.includes("status:"));
  assert.ok(fmHit);
  assert.equal(fmHit.line_number, 3);
  assert.equal(fmHit.body_line, null);
});

test("without frontmatter, body_line equals line_number", async () => {
  const result = await searchNotes(fx.vaultPath, { pattern: "needle" });
  const hit = matchesOf(result, "plain")[0];
  assert.equal(hit.line_number, 2);
  assert.equal(hit.body_line, 2);
});

test("body_line matches list_tasks' line for the same task (the handoff)", async () => {
  const result = await searchNotes(fx.vaultPath, { pattern: "needle" });
  const tasks = (await listTasks(fx.vaultPath)).results;

  for (const path of ["fm", "tricky"]) {
    const hit = matchesOf(result, path).find((m) => m.content.includes("- [ ]"));
    const task = tasks.find((t) => t.path === path);
    assert.ok(hit && task, `expected a task hit and row for ${path}`);
    assert.equal(hit.body_line, task.line, `body_line/list_tasks divergence in ${path}`);
  }
});

test("filtered search (index pre-resolved) annotates body_line the same way", async () => {
  const result = await searchNotes(fx.vaultPath, { pattern: "needle", tags: ["work"] });
  const task = matchesOf(result, "fm").find((m) => m.content.includes("- [ ]"));
  assert.ok(task);
  assert.equal(task.body_line, 3);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/search-body-line.test.ts`
Expected: FAIL — `body_line` is `undefined` (assertions against `3`/`null` fail; may also fail compile until types change).

- [x] **Step 3: Implement**

`src/types.ts` — extend the matches element:

```typescript
export interface SearchResult {
  path: string;
  matches: Array<{
    line_number: number;
    /**
     * 1-based body-relative line (frontmatter stripped) — the same convention
     * as get_outline/list_tasks/set_task_state, so a grep hit can be handed
     * straight to the task/section surface. Null when the hit falls inside
     * the frontmatter block (or the file is unknown to the index).
     */
    body_line: number | null;
    content: string;
    context_before: string[];
    context_after: string[];
  }>;
}
```

`src/tools/search.ts`:

1. Import the index class type: extend the existing import to `import { getIndex, type VaultIndex } from "./vault-index.js";`
2. In the filter block, keep the fetched index for reuse: replace `const index = await getIndex(vaultPath);` with a hoisted variable. Above `if (hasFilter)` add `let index: VaultIndex | null = null;`, and inside use `index = await getIndex(vaultPath);` (the `resolveCandidates(index, ...)` call is unchanged).
3. At the match push (~line 220), add `body_line: null,` after `line_number` (annotated after collection).
4. After `flushCurrent();` and before the `return`, annotate:

```typescript
  // Bridge ripgrep's file-absolute line numbers to the body-relative
  // convention of get_outline/list_tasks/set_task_state: body_line =
  // line_number - bodyBegin (the note's frontmatter raw-line count, from the
  // same gray-matter parse those tools read). Hits inside the frontmatter
  // block — and files the index doesn't know — stay null.
  if (results.length > 0) {
    const idx = index ?? (await getIndex(vaultPath));
    for (const file of results) {
      const bodyBegin = idx.getEntry(file.path)?.bodyBegin;
      if (bodyBegin === undefined) continue;
      for (const m of file.matches) {
        m.body_line = m.line_number > bodyBegin ? m.line_number - bodyBegin : null;
      }
    }
  }
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/search-body-line.test.ts`
Expected: PASS (5 tests).

- [x] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS — existing search tests never assert the absence of extra match fields, and the CLI JSON-prints the response verbatim, so nothing else moves.

- [x] **Step 6: Commit**

```bash
git add src/types.ts src/tools/search.ts tests/search-body-line.test.ts
git commit -m "feat: search_notes emits body_line alongside line_number"
```

### Task 3: Documentation (tool description, CLAUDE.md, README.md)

**Files:**
- Modify: `src/index.ts:137` (search_notes tool description)
- Modify: `CLAUDE.md` (search_notes **Output** bullet)
- Modify: `README.md` (search_notes **Returns** bullet, ~line 295)

**Interfaces:**
- Consumes: the `body_line` semantics fixed in Task 2. No code produced.

- [x] **Step 1: Update the MCP tool description** (`src/index.ts:137`) — append one sentence so the agent-facing surface states the convention:

```
Each match carries line_number (file-absolute, ripgrep's) and body_line (1-based body-relative with frontmatter stripped — the same line convention as get_outline/list_tasks/set_task_state, so a hit can be handed straight to those tools; null for hits inside the frontmatter block).
```

- [x] **Step 2: Update CLAUDE.md** — in the `### search_notes` **Output** bullet, after "plus context lines", note the two line fields:

```
each match carries `line_number` (file-absolute) and `body_line` (1-based body-relative, frontmatter stripped — the same convention as `get_outline`/`list_tasks`/`set_task_state`, so a grep hit feeds `set_task_state` directly; `null` for hits inside the frontmatter block)
```

- [x] **Step 3: Update README.md** — in `### search_notes` **Returns**, extend the `results` bullet the same way (README wording mirrors CLAUDE.md).

- [x] **Step 4: Verify build and suite still pass**

Run: `npm run build && npm test`
Expected: build clean, all tests PASS.

- [x] **Step 5: Commit**

```bash
git add src/index.ts CLAUDE.md README.md
git commit -m "docs: document search_notes body_line and its line-addressing convention"
```

## Self-Review

- **Spec coverage:** additive `body_line` (Task 2), null-for-frontmatter (Task 2 test 2), gray-matter alignment with the task/outline surface incl. the trailing-space fence divergence (Task 1 test 3, Task 2 test 4), both docs + agent-facing description (Task 3). ✓
- **Placeholder scan:** all steps carry exact code/text. ✓
- **Type consistency:** `bodyBegin` (Task 1) consumed by name in Task 2's annotation; `body_line: number | null` matches the test assertions (`3`, `null`); `getEntry` takes the `.md`-stripped relative path, which is exactly `SearchResult.path`. ✓
