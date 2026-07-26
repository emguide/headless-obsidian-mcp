# Task Surface (`list_tasks` + `set_task_state`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-class checkbox-task surface to the headless Obsidian MCP server — an index-backed `list_tasks` read tool and a fail-loud `set_task_state` write tool.

**Architecture:** A fence-aware `parseTasks` extracts checkbox list items into a `tasks` array on each `IndexEntry` (parsed once per file, cached like `headings`). `list_tasks` flat-maps tasks over the shared candidate filter with zero file reads; `set_task_state` locates one task by text (optional line tiebreak) and rewrites only its marker char through the existing `editNote` → `commitWrite` funnel. Every raw marker maps to a named `TaskStatus` so the agent never handles marker chars; the raw marker is preserved for round-trip fidelity.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), `@modelcontextprotocol/sdk`, `gray-matter`, `commander` (CLI), Node's built-in `node:test` runner via `tsx`.

## Global Constraints

- **Spec:** `design/specs/2026-07-24-task-surface-design.md` — the authority; consult it for any ambiguity.
- **ESM imports:** every intra-project import uses a `.js` suffix (e.g. `from "./vault.js"`), even though sources are `.ts`.
- **`TaskStatus`** = `"open" | "done" | "in_progress" | "cancelled" | "forwarded" | "other"`.
- **`WritableTaskStatus`** = `"open" | "done" | "in_progress" | "cancelled" | "forwarded"` (excludes `other`).
- **Marker → status:** `" "`→`open`, `x`/`X`→`done`, `/`→`in_progress`, `-`→`cancelled`, `>`→`forwarded`, else→`other`. Empty `[]`→`open`.
- **Status → marker (writable only):** `open`→`" "`, `done`→`x`, `in_progress`→`/`, `cancelled`→`-`, `forwarded`→`>`.
- **Task match regex:** `^(\s*)([-*+])\s+\[(.?)\]\s?(.*)$` — group 1 indent, group 2 bullet, group 3 marker (single char or empty), group 4 text. Tasks inside fenced code blocks are excluded (reuse `parseHeadings`' fence tracking).
- **Writes gated:** `set_task_state` joins `WRITE_TOOL_NAMES`, hidden/rejected unless `OBSIDIAN_ALLOW_WRITES` is truthy. It funnels through `editNote`/`commitWrite` (git snapshot, path guard) and reports link-health (`unresolved_links`/`broken_anchors`).
- **Envelopes:** `list_tasks` returns `ListResponse<TaskRow>` via `toListResponse`; `limit` default 100, `0` = unbounded; `offset` default 0. Bounds validated with `assertNonNegativeInt`.
- **Line numbering (BODY-relative):** `list_tasks`' `line` and `set_task_state`'s `line` are 1-based **body** line numbers (frontmatter stripped), the SAME convention `get_outline`/`read_section` use (`line: h.line + 1`, no file offset). `parseTasks` runs on the frontmatter-stripped body and returns 0-based body lines; expose as `line + 1`. Do NOT add any frontmatter/file offset — a task and a heading in the same note must report on one consistent numbering so the tools cross-reference. (The index has no `bodyLineOffset` field; if one was added, remove it.)
- **Docs:** `CLAUDE.md` and `README.md` are updated together (repo rule).
- **Test command:** `npm test` runs `tsx --test tests/*.test.ts`. A single file: `npx tsx --test tests/<name>.test.ts`.
- **Commit trailer:** end every commit message with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

### Task 1: Types, marker↔status maps, and the `parseTasks` parser

**Files:**
- Modify: `src/types.ts` (add task types)
- Modify: `src/tools/vault.ts` (add maps + `parseTasks`)
- Test: `tests/parse-tasks.test.ts` (create)

**Interfaces:**
- Consumes: `ParsedHeading` and the fence-tracking approach in `parseHeadings` (`src/tools/vault.ts`).
- Produces:
  - `type TaskStatus` and `type WritableTaskStatus` (in `src/types.ts`)
  - `interface ParsedTask { text: string; status: TaskStatus; marker: string; line: number; indent: number }` (in `src/types.ts`)
  - `parseTasks(content: string): ParsedTask[]` (in `src/tools/vault.ts`)
  - `markerToStatus(marker: string): TaskStatus` (in `src/tools/vault.ts`)
  - `statusToMarker(status: WritableTaskStatus): string` (in `src/tools/vault.ts`)
  - `WRITABLE_TASK_STATUSES: readonly WritableTaskStatus[]` and `TASK_STATUSES: readonly TaskStatus[]` (in `src/tools/vault.ts`)

- [ ] **Step 1: Write the failing test**

Create `tests/parse-tasks.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTasks, markerToStatus, statusToMarker } from "../src/tools/vault.js";

test("maps each marker to its named status", () => {
  const body = [
    "- [ ] open task",
    "- [x] done task",
    "- [X] also done",
    "- [/] in progress",
    "- [-] cancelled",
    "- [>] forwarded",
    "- [?] unknown marker",
    "- [] empty brackets",
  ].join("\n");
  const tasks = parseTasks(body);
  assert.deepEqual(
    tasks.map((t) => [t.text, t.status, t.marker]),
    [
      ["open task", "open", " "],
      ["done task", "done", "x"],
      ["also done", "done", "X"],
      ["in progress", "in_progress", "/"],
      ["cancelled", "cancelled", "-"],
      ["forwarded", "forwarded", ">"],
      ["unknown marker", "other", "?"],
      ["empty brackets", "open", " "],
    ]
  );
});

test("records 0-based line, indent, and bullet variants; skips fenced blocks and plain bullets", () => {
  const body = [
    "# Heading",          // line 0
    "- plain bullet",     // line 1 — NOT a task
    "* [ ] star bullet",  // line 2
    "  + [x] nested plus",// line 3 — indent 2
    "```",                // line 4
    "- [ ] in code fence",// line 5 — excluded
    "```",                // line 6
    "- [ ] after fence",  // line 7
  ].join("\n");
  const tasks = parseTasks(body);
  assert.deepEqual(
    tasks.map((t) => [t.text, t.line, t.indent, t.marker]),
    [
      ["star bullet", 2, 0, " "],
      ["nested plus", 3, 2, "x"],
      ["after fence", 7, 0, " "],
    ]
  );
});

test("marker/status maps round-trip for writable statuses", () => {
  for (const s of ["open", "done", "in_progress", "cancelled", "forwarded"] as const) {
    assert.equal(markerToStatus(statusToMarker(s)), s);
  }
  assert.equal(markerToStatus("z"), "other");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/parse-tasks.test.ts`
Expected: FAIL — `parseTasks`/`markerToStatus`/`statusToMarker` not exported from `vault.js`.

- [ ] **Step 3: Add the task types to `src/types.ts`**

Append near the other parsed-structure types (after `ParsedHeading`):

```ts
/** A named checkbox-task state; agent-facing so no marker char is needed. */
export type TaskStatus =
  | "open"
  | "done"
  | "in_progress"
  | "cancelled"
  | "forwarded"
  | "other";

/** The subset of TaskStatus that set_task_state can write (excludes "other"). */
export type WritableTaskStatus = Exclude<TaskStatus, "other">;

/** A checkbox task line parsed from a note body. */
export interface ParsedTask {
  /** Task text after the checkbox, trimmed. */
  text: string;
  /** Named state mapped from the raw marker. */
  status: TaskStatus;
  /** Raw marker char inside the brackets (" " for empty/open), verbatim. */
  marker: string;
  /** 0-based index of the task line within the body (exposed 1-based downstream). */
  line: number;
  /** Leading-whitespace column count before the bullet (0 = top-level). */
  indent: number;
}
```

- [ ] **Step 4: Add the maps + `parseTasks` to `src/tools/vault.ts`**

Add `ParsedTask`, `TaskStatus`, `WritableTaskStatus` to the existing type import from `../types.js` at the top of the file. Then append after `parseHeadings`:

```ts
/** Ordered writable statuses (excludes "other"). */
export const WRITABLE_TASK_STATUSES: readonly WritableTaskStatus[] = [
  "open",
  "done",
  "in_progress",
  "cancelled",
  "forwarded",
];

/** All statuses, including read-only "other". */
export const TASK_STATUSES: readonly TaskStatus[] = [
  ...WRITABLE_TASK_STATUSES,
  "other",
];

// Canonical marker for each writable status (write direction).
const STATUS_TO_MARKER: Record<WritableTaskStatus, string> = {
  open: " ",
  done: "x",
  in_progress: "/",
  cancelled: "-",
  forwarded: ">",
};

// Raw marker -> named status (read direction). Empty brackets normalize to open.
const MARKER_TO_STATUS: Record<string, TaskStatus> = {
  " ": "open",
  "": "open",
  x: "done",
  X: "done",
  "/": "in_progress",
  "-": "cancelled",
  ">": "forwarded",
};

/** Map a raw checkbox marker to its named status ("other" when unrecognized). */
export function markerToStatus(marker: string): TaskStatus {
  return MARKER_TO_STATUS[marker] ?? "other";
}

/** Canonical marker char for a writable status. */
export function statusToMarker(status: WritableTaskStatus): string {
  return STATUS_TO_MARKER[status];
}

// A checkbox list item: indent, bullet, single-or-empty marker, then text.
const TASK_RE = /^(\s*)([-*+])\s+\[(.?)\]\s?(.*)$/;

/**
 * All checkbox tasks (`- [ ] ...`) in document order, skipping fenced code
 * blocks — the task analogue of {@link parseHeadings}, sharing its fence
 * tracking so the two never disagree about what is "inside code". A plain
 * bullet (`- text`) is not a task. The raw marker is preserved verbatim; an
 * empty `[]` normalizes to the open marker (" ").
 */
export function parseTasks(content: string): ParsedTask[] {
  const lines = content.split("\n");
  const tasks: ParsedTask[] = [];
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
    const m = line.match(TASK_RE);
    if (!m) continue;
    const rawMarker = m[3] === "" ? " " : m[3];
    tasks.push({
      text: m[4].trim(),
      status: markerToStatus(rawMarker),
      marker: rawMarker,
      line: i,
      indent: m[1].length,
    });
  }
  return tasks;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx tsx --test tests/parse-tasks.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/tools/vault.ts tests/parse-tasks.test.ts
git commit -m "feat: parseTasks + marker/status maps for the task surface

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Store `tasks` on the vault index

**Files:**
- Modify: `src/tools/vault-index.ts` (add `tasks` to `IndexEntry`, populate in `buildEntry`)
- Test: `tests/index-tasks.test.ts` (create)

**Interfaces:**
- Consumes: `parseTasks` (Task 1), `IndexEntry`, `buildEntry`, `getIndex` (`src/tools/vault-index.ts`).
- Produces: `IndexEntry.tasks: ParsedTask[]`, populated on refresh and re-parsed only on file change.

- [ ] **Step 1: Write the failing test**

Create `tests/index-tasks.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { getIndex } from "../src/tools/vault-index.js";
import { makeVault } from "./fixtures.js";

test("index stores parsed tasks per note", async () => {
  const fx = await makeVault([
    { path: "n.md", content: "# H\n- [ ] a\n- [x] b\n- plain\n" },
    { path: "empty.md", content: "# No tasks\njust text\n" },
  ]);
  try {
    const index = await getIndex(fx.vaultPath);
    const n = index.getEntry("n");
    assert.deepEqual(
      n?.tasks.map((t) => [t.text, t.status]),
      [["a", "open"], ["b", "done"]]
    );
    assert.deepEqual(index.getEntry("empty")?.tasks, []);
  } finally {
    await fx.cleanup();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/index-tasks.test.ts`
Expected: FAIL — `tasks` is `undefined` on the entry (property does not exist).

- [ ] **Step 3: Add `tasks` to `IndexEntry` and populate it**

In `src/tools/vault-index.ts`:

Add `parseTasks` to the import from `./vault.js` and `ParsedTask` to the import from `../types.js`.

Add the field to the `IndexEntry` interface, right after `headings`:

```ts
  /** Fence-aware checkbox tasks in document order (shared parser). */
  tasks: ParsedTask[];
```

In `buildEntry`, add a declaration beside the other `let` bindings:

```ts
  let tasks: ParsedTask[] = [];
```

Inside the `try` block, right after `headings = parseHeadings(parsed.content);`:

```ts
    tasks = parseTasks(parsed.content);
```

And add `tasks,` to the returned object literal (next to `headings,`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/index-tasks.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Run the full suite to confirm no regression**

Run: `npm test`
Expected: all tests pass (previous baseline + the 2 new files).

- [ ] **Step 6: Commit**

```bash
git add src/tools/vault-index.ts tests/index-tasks.test.ts
git commit -m "feat: store parsed tasks on the vault index

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `list_tasks` read tool

**Files:**
- Create: `src/tools/tasks.ts`
- Modify: `src/types.ts` (add `TaskRow`, `ListTasksParams`)
- Test: `tests/tasks.test.ts` (create)

**Interfaces:**
- Consumes: `resolveCandidates` + `validateCandidateFilter` (`src/tools/candidate-filter.ts`), `toListResponse` + `assertNonNegativeInt` (`src/tools/list-response.ts`), `getIndex` (`src/tools/vault-index.ts`), `headingPaths` (`src/tools/vault.ts`), `IndexEntry`, `TASK_STATUSES`.
- Produces:
  - `interface TaskRow { path; text; status; marker; line; section }` (in `src/types.ts`)
  - `interface ListTasksParams { folder?; tags?; match?; where?; status?; limit?; offset? }` (in `src/types.ts`)
  - `listTasks(vaultPath: string, params?: ListTasksParams): Promise<ListResponse<TaskRow>>` (in `src/tools/tasks.ts`)

- [ ] **Step 1: Write the failing test**

Create `tests/tasks.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { listTasks } from "../src/tools/tasks.js";
import { makeVault } from "./fixtures.js";

const NOTES = [
  {
    path: "projects/alpha.md",
    content: [
      "---",
      "tags: [work]",
      "status: active",
      "---",
      "# Alpha",
      "- [ ] above headings? no — this is under Alpha",
      "## Log",
      "- [ ] review draft",
      "- [x] ship it",
      "- [/] wip item",
    ].join("\n"),
  },
  {
    path: "personal/todo.md",
    content: ["- [ ] buy milk", "- [-] skip gym"].join("\n"),
  },
];

test("lists tasks with section context and note path", async () => {
  const fx = await makeVault(NOTES);
  try {
    const res = await listTasks(fx.vaultPath, { folder: "projects" });
    // Lines are BODY-relative 1-based, matching get_outline/read_section
    // (frontmatter stripped). The 4-line frontmatter block does NOT count.
    assert.deepEqual(
      res.results.map((t) => [t.path, t.text, t.status, t.line, t.section]),
      [
        ["projects/alpha", "above headings? no — this is under Alpha", "open", 2, "Alpha"],
        ["projects/alpha", "review draft", "open", 4, "Alpha > Log"],
        ["projects/alpha", "ship it", "done", 5, "Alpha > Log"],
        ["projects/alpha", "wip item", "in_progress", 6, "Alpha > Log"],
      ]
    );
    assert.equal(res.truncated, false);
  } finally {
    await fx.cleanup();
  }
});

test("task above any heading has null section", async () => {
  const fx = await makeVault(NOTES);
  try {
    const res = await listTasks(fx.vaultPath, { folder: "personal" });
    assert.equal(res.results[0].section, null);
    assert.equal(res.results[0].text, "buy milk");
  } finally {
    await fx.cleanup();
  }
});

test("status filter keeps any of the listed statuses", async () => {
  const fx = await makeVault(NOTES);
  try {
    const res = await listTasks(fx.vaultPath, { status: ["open", "in_progress"] });
    const statuses = new Set(res.results.map((t) => t.status));
    assert.deepEqual([...statuses].sort(), ["in_progress", "open"]);
    assert.ok(res.results.every((t) => t.status !== "done" && t.status !== "cancelled"));
  } finally {
    await fx.cleanup();
  }
});

test("candidate filters (tags/where) scope the task set", async () => {
  const fx = await makeVault(NOTES);
  try {
    const res = await listTasks(fx.vaultPath, { tags: ["work"], where: { status: "active" } });
    assert.ok(res.results.length > 0);
    assert.ok(res.results.every((t) => t.path === "projects/alpha"));
  } finally {
    await fx.cleanup();
  }
});

test("pagination envelope reports the window", async () => {
  const fx = await makeVault(NOTES);
  try {
    const res = await listTasks(fx.vaultPath, { limit: 2, offset: 1 });
    assert.equal(res.returned, 2);
    assert.equal(res.skipped, 1);
    assert.ok(res.omitted >= 1);
    assert.equal(res.truncated, true);
  } finally {
    await fx.cleanup();
  }
});

test("rejects an invalid status name", async () => {
  const fx = await makeVault(NOTES);
  try {
    await assert.rejects(
      () => listTasks(fx.vaultPath, { status: ["nope"] as any }),
      /status/
    );
  } finally {
    await fx.cleanup();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/tasks.test.ts`
Expected: FAIL — cannot find module `../src/tools/tasks.js`.

- [ ] **Step 3: Add `TaskRow` and `ListTasksParams` to `src/types.ts`**

Append after the task types added in Task 1:

```ts
/** One checkbox task, as returned by list_tasks. */
export interface TaskRow {
  /** Note path (no .md). */
  path: string;
  /** Task text after the checkbox. */
  text: string;
  /** Named state. */
  status: TaskStatus;
  /** Raw marker char. */
  marker: string;
  /** 1-based body line of the task. */
  line: number;
  /** " > "-joined heading-path the task falls under, or null if above all headings. */
  section: string | null;
}

export interface ListTasksParams {
  /** Restrict to notes under this folder (relative to the vault root). */
  folder?: string;
  /** Restrict to notes carrying these tags (leading '#' optional). */
  tags?: string[];
  /** Semantics of `tags`: "any" (default) or "all". */
  match?: "any" | "all";
  /** Restrict to notes whose frontmatter satisfies these conditions (query_notes syntax). */
  where?: Record<string, Condition>;
  /** Restrict to tasks in any of these statuses; omitted = all statuses. */
  status?: TaskStatus[];
  /** Maximum number of tasks to return (default 100; 0 = unbounded). */
  limit?: number;
  /** Rows to skip before the window, for pagination. Default 0. */
  offset?: number;
}
```

(`Condition` is already imported at the top of `src/types.ts`.)

- [ ] **Step 4: Write `src/tools/tasks.ts`**

```ts
import { assertVaultPath, headingPaths } from "./vault.js";
import { getIndex, IndexEntry } from "./vault-index.js";
import { TASK_STATUSES } from "./vault.js";
import { ListTasksParams, ListResponse, TaskRow } from "../types.js";
import { toListResponse, assertNonNegativeInt } from "./list-response.js";
import { resolveCandidates, validateCandidateFilter } from "./candidate-filter.js";

/** Default cap so the first orientation call is bounded, matching list_notes. */
const DEFAULT_LIMIT = 100;

/**
 * List checkbox tasks across the vault as structured rows (path, text, named
 * status, raw marker, 1-based line, enclosing heading-path). Index-backed: no
 * per-call file reads. Scope with the shared folder/tags/where/match filters
 * plus an optional `status` set, so "open tasks in projects/ tagged #work" is a
 * single call. Returns the standard ListResponse window.
 */
export async function listTasks(
  vaultPath: string,
  params: ListTasksParams = {}
): Promise<ListResponse<TaskRow>> {
  assertVaultPath(vaultPath);

  const { folder, tags, match, where, status, limit, offset } = params;

  if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
    throw new Error("limit must be a positive integer");
  }
  assertNonNegativeInt(offset, "offset");
  validateCandidateFilter({ tags, where, match });

  if (status !== undefined) {
    if (!Array.isArray(status) || status.length === 0) {
      throw new Error("status must be a non-empty array when provided");
    }
    for (const s of status) {
      if (!TASK_STATUSES.includes(s)) {
        throw new Error(
          `status contains an invalid value "${s}"; valid: ${TASK_STATUSES.join(", ")}`
        );
      }
    }
  }
  const statusSet = status ? new Set(status) : undefined;

  const index = await getIndex(vaultPath);
  const entries = resolveCandidates(index, {
    folder,
    tags,
    where,
    tagMatch: match ?? "any",
    whereMatch: "all",
  });

  const rows: TaskRow[] = [];
  for (const entry of entries) {
    for (const task of entryTaskRows(entry)) {
      if (statusSet && !statusSet.has(task.status)) continue;
      rows.push(task);
    }
  }

  const effectiveLimit = limit === undefined ? DEFAULT_LIMIT : limit;
  return toListResponse(rows, effectiveLimit === 0 ? undefined : effectiveLimit, offset);
}

/** Project one note's cached tasks into TaskRows, attaching heading-path context. */
function entryTaskRows(entry: IndexEntry): TaskRow[] {
  const paths = headingPaths(entry.headings);
  return entry.tasks.map((task) => ({
    path: entry.path,
    text: task.text,
    status: task.status,
    marker: task.marker,
    line: task.line + 1, // index tasks are 0-based; expose 1-based
    section: sectionForLine(entry, paths, task.line),
  }));
}

/**
 * The " > "-joined heading-path of the nearest heading at or before `line`,
 * or null when the task sits above every heading. Headings are in document
 * order, so the last heading whose line <= the task's line wins.
 */
function sectionForLine(
  entry: IndexEntry,
  paths: string[],
  line: number
): string | null {
  let result: string | null = null;
  for (let i = 0; i < entry.headings.length; i++) {
    if (entry.headings[i].line <= line) result = paths[i];
    else break;
  }
  return result;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx tsx --test tests/tasks.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add src/tools/tasks.ts src/types.ts tests/tasks.test.ts
git commit -m "feat: list_tasks read tool

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `set_task_state` write tool

**Files:**
- Modify: `src/tools/write.ts` (add `setTaskState`, register in `WRITE_TOOL_NAMES`)
- Modify: `src/types.ts` (add `SetTaskStateParams`)
- Test: `tests/set-task-state.test.ts` (create)

**Interfaces:**
- Consumes: `parseTasks`, `statusToMarker`, `WRITABLE_TASK_STATUSES`, `markerToStatus` (`src/tools/vault.ts`); `readRaw`, `commitWrite`, `linkHealthAfterWrite`, `canonicalName` (existing internal helpers in `src/tools/write.ts`); `LinkHealth` (`src/tools/link-health.ts`).
- Produces:
  - `interface SetTaskStateParams { path; text?; line?; status }` (in `src/types.ts`)
  - `setTaskState(vaultPath, params): Promise<{ path; line; text; status; marker; changed } & LinkHealth>` (in `src/tools/write.ts`)
  - `"set_task_state"` added to `WRITE_TOOL_NAMES`.

- [ ] **Step 1: Write the failing test**

Create `tests/set-task-state.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTaskState } from "../src/tools/write.js";
import { makeVault, Fixture } from "./fixtures.js";

const read = (v: string, n: string) => readFile(join(v, n), "utf-8");

async function vault(): Promise<Fixture> {
  return makeVault([
    {
      path: "t.md",
      content: [
        "# Tasks",
        "- [ ] review draft",
        "  - [ ] nested item",
        "- [ ] review draft", // duplicate text on line 4 (1-based)
        "- [x] already done",
      ].join("\n"),
    },
  ]);
}

test("sets a uniquely-addressed task by text and rewrites only the marker", async () => {
  const fx = await vault();
  try {
    const res = await setTaskState(fx.vaultPath, {
      path: "t",
      text: "nested item",
      status: "done",
    });
    assert.equal(res.changed, true);
    assert.equal(res.status, "done");
    assert.equal(res.marker, "x");
    assert.equal(res.line, 3);
    assert.deepEqual(res.unresolved_links, []);
    assert.deepEqual(res.broken_anchors, []);
    const body = await read(fx.vaultPath, "t.md");
    assert.match(body, /^ {2}- \[x\] nested item$/m); // indentation preserved
  } finally {
    await fx.cleanup();
  }
});

test("ambiguous text errors and lists candidate lines", async () => {
  const fx = await vault();
  try {
    await assert.rejects(
      () => setTaskState(fx.vaultPath, { path: "t", text: "review draft", status: "done" }),
      /lines 2, 4/
    );
  } finally {
    await fx.cleanup();
  }
});

test("text + line disambiguates a duplicate", async () => {
  const fx = await vault();
  try {
    const res = await setTaskState(fx.vaultPath, {
      path: "t",
      text: "review draft",
      line: 4,
      status: "in_progress",
    });
    assert.equal(res.line, 4);
    assert.equal(res.marker, "/");
    const body = await read(fx.vaultPath, "t.md");
    assert.match(body, /^- \[\/\] review draft$/m);
    assert.match(body, /^- \[ \] review draft$/m); // line 2 untouched
  } finally {
    await fx.cleanup();
  }
});

test("stale text+line (text mismatch at line) errors", async () => {
  const fx = await vault();
  try {
    await assert.rejects(
      () => setTaskState(fx.vaultPath, { path: "t", text: "review draft", line: 5, status: "done" }),
      /does not match/i
    );
  } finally {
    await fx.cleanup();
  }
});

test("line alone addresses positionally", async () => {
  const fx = await vault();
  try {
    const res = await setTaskState(fx.vaultPath, { path: "t", line: 2, status: "cancelled" });
    assert.equal(res.text, "review draft");
    assert.equal(res.marker, "-");
  } finally {
    await fx.cleanup();
  }
});

test("no task at the given line errors", async () => {
  const fx = await vault();
  try {
    await assert.rejects(
      () => setTaskState(fx.vaultPath, { path: "t", line: 1, status: "done" }),
      /no task/i
    );
  } finally {
    await fx.cleanup();
  }
});

test("text not found errors", async () => {
  const fx = await vault();
  try {
    await assert.rejects(
      () => setTaskState(fx.vaultPath, { path: "t", text: "does not exist", status: "done" }),
      /not found/i
    );
  } finally {
    await fx.cleanup();
  }
});

test("neither text nor line errors", async () => {
  const fx = await vault();
  try {
    await assert.rejects(
      () => setTaskState(fx.vaultPath, { path: "t", status: "done" } as any),
      /text.*or.*line|provide/i
    );
  } finally {
    await fx.cleanup();
  }
});

test("already-in-state is a no-op", async () => {
  const fx = await vault();
  try {
    const res = await setTaskState(fx.vaultPath, { path: "t", line: 5, status: "done" });
    assert.equal(res.changed, false);
    assert.equal(res.marker, "x");
  } finally {
    await fx.cleanup();
  }
});

test("status 'other' is rejected", async () => {
  const fx = await vault();
  try {
    await assert.rejects(
      () => setTaskState(fx.vaultPath, { path: "t", line: 2, status: "other" as any }),
      /status/i
    );
  } finally {
    await fx.cleanup();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/set-task-state.test.ts`
Expected: FAIL — `setTaskState` not exported from `write.js`.

- [ ] **Step 3: Add `SetTaskStateParams` to `src/types.ts`**

Append after `ListTasksParams`:

```ts
export interface SetTaskStateParams {
  path: string;
  /** Exact task text to match (the part after the checkbox). */
  text?: string;
  /** 1-based line tiebreak / positional address. */
  line?: number;
  /** Target state; "other" is read-only and rejected. */
  status: WritableTaskStatus;
}
```

- [ ] **Step 4: Implement `setTaskState` in `src/tools/write.ts`**

Add to the import from `./vault.js` (which already imports `resolveNotePath` etc.): `parseTasks, statusToMarker, WRITABLE_TASK_STATUSES`. Add `SetTaskStateParams` to the import from `../types.js` if that file imports types (otherwise declare the param inline via the interface import — check the existing import style and match it).

Add `"set_task_state"` to the `WRITE_TOOL_NAMES` set literal.

Add this function (place it near `patchNote`, after `renameSectionInVault`):

```ts
export async function setTaskState(
  vaultPath: string,
  { path, text, line, status }: SetTaskStateParams
): Promise<{
  path: string;
  line: number;
  text: string;
  status: WritableTaskStatus;
  marker: string;
  changed: boolean;
} & LinkHealth> {
  if (!WRITABLE_TASK_STATUSES.includes(status)) {
    throw new Error(
      `status must be one of: ${WRITABLE_TASK_STATUSES.join(", ")} (got "${status}")`
    );
  }
  const hasText = typeof text === "string" && text.length > 0;
  const hasLine = typeof line === "number";
  if (!hasText && !hasLine) {
    throw new Error("Provide `text` and/or `line` to address the task");
  }
  if (hasLine && (!Number.isInteger(line) || (line as number) < 1)) {
    throw new Error("line must be a positive integer (1-based)");
  }

  const canon = canonicalName(path);
  const raw = await readRaw(vaultPath, path);
  const bodyLines = raw.split("\n");
  const tasks = parseTasks(raw);

  // Locate the target task. parseTasks lines are 0-based; `line` is 1-based.
  let target;
  if (hasLine) {
    const zero = (line as number) - 1;
    target = tasks.find((t) => t.line === zero);
    if (!target) {
      throw new Error(`No task at line ${line} in ${canon}`);
    }
    if (hasText && target.text !== text) {
      throw new Error(
        `Task text at line ${line} does not match "${text}" in ${canon} (found "${target.text}")`
      );
    }
  } else {
    const matches = tasks.filter((t) => t.text === text);
    if (matches.length === 0) {
      throw new Error(`Task "${text}" not found in ${canon}`);
    }
    if (matches.length > 1) {
      const lines = matches.map((m) => m.line + 1).join(", ");
      throw new Error(
        `Task "${text}" occurs at lines ${lines} in ${canon}; pass \`line\` to disambiguate`
      );
    }
    target = matches[0];
  }

  const marker = statusToMarker(status);
  const oneBasedLine = target.line + 1;

  // No-op when already in the requested state — skip the write and snapshot.
  if (target.marker === marker) {
    const health = await linkHealthAfterWrite(vaultPath, path, raw);
    return {
      path: canon,
      line: oneBasedLine,
      text: target.text,
      status,
      marker,
      changed: false,
      ...health,
    };
  }

  // Rewrite ONLY the marker char on the target line, preserving everything else.
  const original = bodyLines[target.line];
  const rewritten = original.replace(/\[(.?)\]/, `[${marker}]`);
  bodyLines[target.line] = rewritten;
  const next = bodyLines.join("\n");

  await commitWrite(vaultPath, path, next);
  const health = await linkHealthAfterWrite(vaultPath, path, next);
  return {
    path: canon,
    line: oneBasedLine,
    text: target.text,
    status,
    marker,
    changed: true,
    ...health,
  };
}
```

Note: the `.replace(/\[(.?)\]/, ...)` targets the first `[...]` on the located task line, which is the checkbox (the line matched `TASK_RE`, so its first bracket pair is the marker).

- [ ] **Step 5: Run test to verify it passes**

Run: `npx tsx --test tests/set-task-state.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 6: Commit**

```bash
git add src/tools/write.ts src/types.ts tests/set-task-state.test.ts
git commit -m "feat: set_task_state write tool

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Register both tools with the MCP server

**Files:**
- Modify: `src/index.ts` (imports, tool schemas, instructions, CallTool cases)
- Test: `tests/write-gate.test.ts` (extend to cover the new write tool)

**Interfaces:**
- Consumes: `listTasks` (`src/tools/tasks.js`), `setTaskState` (`src/tools/write.js`), `ListTasksParams`/`SetTaskStateParams` (`src/types.js`).
- Produces: `list_tasks` (read) and `set_task_state` (gated write) exposed over MCP.

- [ ] **Step 1: Extend the write-gate test**

In `tests/write-gate.test.ts`, the test that iterates `WRITE_TOOL_NAMES` already covers membership. Add an explicit assertion (place it beside the other `isWriteTool` positive checks):

```ts
test("set_task_state is a gated write tool", () => {
  assert.equal(WRITE_TOOL_NAMES.has("set_task_state"), true);
  assert.equal(isWriteTool("set_task_state"), true);
});
```

- [ ] **Step 2: Run test to verify it passes (Task 4 already added the name)**

Run: `npx tsx --test tests/write-gate.test.ts`
Expected: PASS — `set_task_state` is already in `WRITE_TOOL_NAMES` from Task 4.

- [ ] **Step 3: Add imports to `src/index.ts`**

Add near the other tool imports:

```ts
import { listTasks } from "./tools/tasks.js";
```

Add `setTaskState` to the existing multi-name import from `./tools/write.js`.

Add `ListTasksParams, SetTaskStateParams` to the type import from `./types.js` (match the existing import style in the file).

- [ ] **Step 4: Register the `list_tasks` tool schema**

In the `tools` array (inside `ListToolsRequestSchema`), add after the `read_section` entry:

```ts
      {
        name: "list_tasks",
        description: "List checkbox tasks (- [ ] ...) across the vault as structured rows (path, text, status, raw marker, 1-based line, enclosing heading-path). status is a named state: open|done|in_progress|cancelled|forwarded|other. Index-backed. Scope with folder/tags/where/match and an optional status filter (any of the listed statuses).",
        inputSchema: {
          type: "object",
          properties: {
            folder: { type: "string", description: "Restrict to notes under this folder." },
            tags: { type: "array", items: { type: "string" }, description: "Restrict to notes carrying these tags (leading '#' optional)." },
            match: { type: "string", enum: ["any", "all"], description: "Semantics of tags: 'any' (default) or 'all'." },
            where: { type: "object", description: "Restrict to notes whose frontmatter satisfies these conditions (query_notes syntax)." },
            status: {
              type: "array",
              items: { type: "string", enum: ["open", "done", "in_progress", "cancelled", "forwarded", "other"] },
              description: "Restrict to tasks in any of these statuses; omitted = all.",
            },
            limit: { type: "number", description: "Maximum number of tasks to return (default 100; 0 = unbounded)." },
            offset: { type: "number", description: "Rows to skip, for pagination (default 0)." },
          },
        },
      },
```

- [ ] **Step 5: Register the `set_task_state` tool schema**

Add near the other write-tool schemas (e.g. after `patch_note`):

```ts
      {
        name: "set_task_state",
        description: "Set one checkbox task's state in a note, rewriting only its marker (- [ ] -> - [x]). Address by exact task text (unique-or-fail, like patch_note) with an optional 1-based `line` tiebreak, or by `line` alone. status: open|done|in_progress|cancelled|forwarded (not 'other'). Reports unresolved_links/broken_anchors for the resulting note (link-integrity convention).",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Note path (.md optional)." },
            text: { type: "string", description: "Exact task text (the part after the checkbox)." },
            line: { type: "number", description: "1-based line tiebreak / positional address." },
            status: {
              type: "string",
              enum: ["open", "done", "in_progress", "cancelled", "forwarded"],
              description: "Target state.",
            },
          },
          required: ["path", "status"],
        },
      },
```

- [ ] **Step 6: Add the CallTool cases**

In the `CallToolRequestSchema` handler's `switch`, add a read case near `read_section`:

```ts
      case "list_tasks": {
        const results = await listTasks(VAULT_PATH, (args ?? {}) as ListTasksParams);
        return { content: [{ type: "text", text: JSON.stringify(results) }] };
      }
```

And a write case near `patch_note`:

```ts
      case "set_task_state": {
        const result = await setTaskState(VAULT_PATH, args as unknown as SetTaskStateParams);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }
```

- [ ] **Step 7: Update the server `instructions` string**

In the `instructions` string:

- In the **Pagination convention** sentence, add `list_tasks` to the list of list-style tools: change "the list_* tools plus search_notes_ranked, find_by_tag, query_notes, and get_related_notes" to include `list_tasks` (it is a `list_*` tool, so it is already covered by "the list_* tools" — no edit strictly required; add an explicit mention only if the sentence enumerates them, which it does under Filter convention below).
- In the **Filter convention** sentence, add `list_tasks` to the enumerated tools: "...list_notes, list_recent_notes, find_by_tag, query_notes, list_tasks, and get_related_notes all share this vocabulary...".
- In the **Link-integrity convention** sentence, add `set_task_state` to the enumerated content-writing tools: "...append_to_section, replace_section, set_task_state) returns...".

- [ ] **Step 8: Build to confirm the server compiles**

Run: `npm run build`
Expected: `tsc` exits 0, no type errors.

- [ ] **Step 9: Run the full suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 10: Commit**

```bash
git add src/index.ts tests/write-gate.test.ts
git commit -m "feat: register list_tasks + set_task_state with the MCP server

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Query-CLI commands

**Files:**
- Modify: `src/query-cli.ts` (imports, dispatch, two commands)
- Test: `tests/tasks-cli.test.ts` (create)

**Interfaces:**
- Consumes: `listTasks` (`src/tools/tasks.js`), `setTaskState` (`src/tools/write.js`), the existing `queryTool` dispatcher and `parseWhere` helper.
- Produces: `query tasks` and `query set-task-state` CLI commands.

- [ ] **Step 1: Write the failing test**

Create `tests/tasks-cli.test.ts` (model on `tests/folders-cli.test.ts` — spawn the CLI via `tsx`):

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { makeVault } from "./fixtures.js";

const execFileAsync = promisify(execFile);
const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "query-cli.ts");

function run(vault: string, args: string[]) {
  return execFileAsync("npx", ["tsx", CLI, ...args], {
    env: { ...process.env, OBSIDIAN_VAULT_PATH: vault },
  });
}

test("query tasks lists checkbox tasks as JSON", async () => {
  const fx = await makeVault([
    { path: "t.md", content: "# H\n- [ ] alpha\n- [x] beta\n" },
  ]);
  try {
    const { stdout } = await run(fx.vaultPath, ["tasks"]);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.results.length, 2);
    assert.equal(parsed.results[0].text, "alpha");
    assert.equal(parsed.results[0].status, "open");
  } finally {
    await fx.cleanup();
  }
});

test("query tasks --status filters", async () => {
  const fx = await makeVault([
    { path: "t.md", content: "- [ ] a\n- [x] b\n" },
  ]);
  try {
    const { stdout } = await run(fx.vaultPath, ["tasks", "--status", "done"]);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.results.length, 1);
    assert.equal(parsed.results[0].text, "b");
  } finally {
    await fx.cleanup();
  }
});

test("query set-task-state toggles a task", async () => {
  const fx = await makeVault([
    { path: "t.md", content: "- [ ] finish report\n" },
  ]);
  try {
    const { stdout } = await run(fx.vaultPath, ["set-task-state", "t", "--text", "finish report", "--status", "done"]);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.changed, true);
    assert.equal(parsed.marker, "x");
  } finally {
    await fx.cleanup();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/tasks-cli.test.ts`
Expected: FAIL — `Unknown command 'tasks'` / `set-task-state`.

- [ ] **Step 3: Add imports + dispatch to `src/query-cli.ts`**

Add to the tool imports:

```ts
import { listTasks } from "./tools/tasks.js";
```

Add `setTaskState` to the existing multi-name import from `./tools/write.js`.

In `queryTool`'s dispatch chain, add two branches (beside the analogous read/write branches):

```ts
    } else if (toolName === "list_tasks") {
      result = await listTasks(VAULT_PATH!, args);
    } else if (toolName === "set_task_state") {
      result = await setTaskState(VAULT_PATH!, args);
```

- [ ] **Step 4: Add the two commands**

Add a read command near the `outline`/`read-section` commands:

```ts
program
  .command("tasks")
  .description("List checkbox tasks across the vault, optionally scoped/filtered")
  .option("-f, --folder <folder>", "Restrict to notes under this folder")
  .option("-t, --tag <tags...>", "Restrict to notes carrying these tags")
  .option("-a, --all", "Require all tags (default: any)")
  .option("--where <json>", "Frontmatter filter as JSON (query_notes syntax)")
  .option("-s, --status <statuses...>", "Restrict to these statuses (open|done|in_progress|cancelled|forwarded|other)")
  .option("-l, --limit <n>", "Maximum number of tasks to return")
  .option("-o, --offset <n>", "Rows to skip before the window (pagination)")
  .action(async (options: any, command: Command) => {
    const verbose = command.parent?.opts().verbose ?? false;
    const where = parseWhere(options.where);
    const args = {
      ...(options.folder && { folder: options.folder }),
      ...(options.tag && { tags: options.tag }),
      ...(options.all && { match: "all" }),
      ...(where !== undefined && { where }),
      ...(options.status && { status: options.status }),
      ...(options.limit && { limit: parseInt(options.limit, 10) }),
      ...(options.offset !== undefined && { offset: parseInt(options.offset, 10) }),
    };
    await queryTool("list_tasks", args, verbose);
  });
```

Add a write command near the `patch`/`add-section` commands:

```ts
program
  .command("set-task-state <path>")
  .description("Set one checkbox task's state (by text and/or line)")
  .option("--text <text>", "Exact task text to match")
  .option("--line <n>", "1-based line tiebreak / positional address")
  .requiredOption("--status <status>", "Target state (open|done|in_progress|cancelled|forwarded)")
  .action(async (path: string, options: any, command: Command) => {
    const verbose = command.parent?.opts().verbose ?? false;
    const args = {
      path,
      ...(options.text !== undefined && { text: options.text }),
      ...(options.line !== undefined && { line: parseInt(options.line, 10) }),
      status: options.status,
    };
    await queryTool("set_task_state", args, verbose);
  });
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx tsx --test tests/tasks-cli.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/query-cli.ts tests/tasks-cli.test.ts
git commit -m "feat: query CLI commands for tasks + set-task-state

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Documentation

**Files:**
- Modify: `CLAUDE.md` (tool docs, index section, testing examples)
- Modify: `README.md` (matching tool docs)

**Interfaces:**
- Consumes: nothing (docs only).
- Produces: user-facing documentation for both tools.

- [ ] **Step 1: Document `list_tasks` in `CLAUDE.md`**

Add a `### list_tasks` subsection under the read tools (near `read_section`), covering: purpose (structured checkbox-task surface replacing `- [ ]` regex), the shared `folder`/`tags`/`match`/`where` inputs plus `status` (array, any-of, includes `other`) and `limit`/`offset`, the row shape (`path`, `text`, `status` [the six named states], `marker`, `line` [1-based], `section` [heading-path or null]), the `ListResponse` envelope, and the index-backed note.

- [ ] **Step 2: Document `set_task_state` in `CLAUDE.md`**

Add a `### set_task_state` subsection under the Writing tools, covering: purpose (change one task's state, rewriting only the marker), inputs (`path`, `text`?, `line`?, `status` — writable set only, `other` rejected), the text-primary / optional-line-tiebreak addressing with fail-loud ambiguity (mirroring `patch_note`), the no-op-when-already-in-state behavior, and the output shape (`{ path, line, text, status, marker, changed, unresolved_links, broken_anchors }`). Add `set_task_state` to the write-tool list under "The server can also mutate the vault" / the link-integrity convention paragraph.

- [ ] **Step 3: Update the Vault index section in `CLAUDE.md`**

In the "### Vault index" paragraph that lists index-backed tools, add `list_tasks` to the enumeration, and note that the index now also stores each note's parsed checkbox tasks (level/marker/line), backing `list_tasks` directly — mirroring the existing sentence about stored headings backing `get_outline`.

- [ ] **Step 4: Add CLI testing examples in `CLAUDE.md`**

In the Testing section's knowledge-base examples, add:

```bash
npm run query -- tasks                                   # All checkbox tasks
npm run query -- tasks --folder projects --status open   # Open tasks in projects/
npm run query -- tasks --tag work --status open in_progress  # Outstanding work tasks
```

And in the write examples:

```bash
npm run query -- set-task-state "projects/alpha" --text "ship it" --status done
npm run query -- set-task-state "projects/alpha" --line 12 --status in_progress
```

- [ ] **Step 5: Mirror all four doc additions in `README.md`**

Apply the same `list_tasks` and `set_task_state` tool documentation and examples to `README.md`, matching its existing structure and depth (repo rule: both docs updated together).

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: document list_tasks + set_task_state

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Final verification

**Files:** none (verification only).

- [ ] **Step 1: Full build**

Run: `npm run build`
Expected: exits 0, no type errors.

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: all tests pass (baseline 424 + new files: parse-tasks, index-tasks, tasks, set-task-state, tasks-cli, plus the write-gate addition). Report the final counts.

- [ ] **Step 3: Manual smoke test against a temp vault**

```bash
export OBSIDIAN_VAULT_PATH=$(mktemp -d)
printf '# Todo\n- [ ] first\n- [/] second\n' > "$OBSIDIAN_VAULT_PATH/todo.md"
npm run query -- tasks
npm run query -- tasks --status open
npm run query -- set-task-state todo --text first --status done
npm run query -- tasks
```

Expected: first call lists both tasks (`open`, `in_progress`); `--status open` shows only "first"; `set-task-state` returns `changed: true, marker: "x"`; the final list shows "first" as `done`.

- [ ] **Step 4: Confirm read-only default hides the write tool**

Verify (by inspection of `src/index.ts` gating, already tested in `write-gate.test.ts`) that with `OBSIDIAN_ALLOW_WRITES` unset, `set_task_state` is filtered out of `list_tools` and rejected on call, while `list_tasks` (read) remains available.

- [ ] **Step 5: Report completion**

Summarize: tests passing (count), build clean, smoke test output, and readiness to merge the `worktree-task-surface` branch.

---

## Self-Review

**Spec coverage:**
- State model (named statuses + raw marker, marker↔status maps, `other` read-only) → Task 1. ✓
- `ParsedTask` in the index → Task 2. ✓
- `parseTasks` (fence-aware, bullets, empty brackets, plain-bullet exclusion) → Task 1. ✓
- `list_tasks` (shared filters, `status` array, `section` context, `ListResponse`) → Task 3. ✓
- `set_task_state` (text-primary/line-tiebreak addressing, fail-loud, surgical marker rewrite, no-op, link-health, gated) → Task 4. ✓
- MCP registration + instructions updates (pagination/filter/link-integrity) → Task 5. ✓
- CLI commands → Task 6. ✓
- Docs (CLAUDE.md + README.md together) → Task 7. ✓
- Scope fences (no existing-tool changes, `other` read-only, no create/delete, `indent` captured-not-surfaced) → honored throughout; `indent` is parsed (Task 1) but never placed on `TaskRow` (Task 3). ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to Task N". All code shown in full; addressing and error messages are concrete.

**Type consistency:** `TaskStatus`/`WritableTaskStatus`/`ParsedTask` defined in Task 1 and consumed unchanged in Tasks 2–4. `markerToStatus`/`statusToMarker`/`WRITABLE_TASK_STATUSES`/`TASK_STATUSES` names are identical across parser (Task 1), `list_tasks` (Task 3), and `set_task_state` (Task 4). `TaskRow` fields (`path`/`text`/`status`/`marker`/`line`/`section`) match between the type (Task 3), the tool projection (Task 3), and the CLI/tool tests. `setTaskState` return shape (`{ path, line, text, status, marker, changed } & LinkHealth`) is consistent between Task 4's implementation, its test assertions, and the Task 5 schema description.
