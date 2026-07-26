# Task surface: `list_tasks` + `set_task_state`

## Goal

Add a first-class checkbox-task surface to the headless Obsidian MCP server:
a read tool (`list_tasks`) that enumerates checkbox tasks across the vault with
structured state, and a write tool (`set_task_state`) that changes one task's
state in place. Today an agent must hand-craft a `- [ ]` regex through
`search_notes` (noisy, context-line-expensive, no structured state) and toggle
via `patch_note`. Checkbox tasks are a dominant vault workflow; this makes them
addressable the way notes, links, tags, sections, and properties already are.

## Design principles (inherited from the existing surface)

- **Index-backed reads**, like `get_outline`/`list_notes`: tasks are extracted
  once during index refresh and re-parsed only when a file changes. `list_tasks`
  is pure index lookups + filtering, no per-call file reads.
- **Shared filter vocabulary**: `list_tasks` reuses `folder`/`tags`/`match`/
  `where` via `resolveCandidates`, so "open tasks in `projects/` tagged `#work`"
  is one call, not a fetch-wide-then-filter join.
- **Fail-loud writes**, like `patch_note`/`read_section`: an ambiguous or stale
  target errors and lists candidates rather than silently editing the wrong task.
- **Surgical writes** through the shared `editNote` → `commitWrite` funnel: git
  snapshot, path guard, link-health report — identical guarantees to every other
  writer. Only the target task's marker char changes; everything else is
  byte-preserved.
- **Standard envelopes**: `list_tasks` returns the `ListResponse<T>` window
  (`results`/`returned`/`skipped`/`omitted`/`truncated`) with `limit`/`offset`
  pagination; `set_task_state` follows the link-integrity convention
  (`unresolved_links`/`broken_anchors`).

## State model

Checkbox tasks are list items of the form `- [X] text`, where `X` is a single
marker character. Obsidian core plus common plugins use markers beyond the
Markdown `space`/`x`: `/` (in-progress), `-` (cancelled), `>` (forwarded), and
arbitrary custom chars. The task surface **maps every marker to an
agent-friendly named status** so an agent reasons in words, never in marker
conventions, while the **raw marker is always preserved** for round-trip
fidelity.

### `TaskStatus`

A closed vocabulary:

```
"open" | "done" | "in_progress" | "cancelled" | "forwarded" | "other"
```

### Marker → status (read direction)

A module-level table shared by the parser and the writer, so they never drift:

| marker            | status        |
| ----------------- | ------------- |
| `" "` (space)     | `open`        |
| `x` / `X`         | `done`        |
| `/`               | `in_progress` |
| `-`               | `cancelled`   |
| `>`               | `forwarded`   |
| anything else     | `other`       |

Empty brackets (`[]`) are treated as `open` (marker `" "`).

### Status → marker (write direction)

The inverse map, defined only for the **writable** statuses:

| status        | canonical marker |
| ------------- | ---------------- |
| `open`        | `" "` (space)    |
| `done`        | `x`              |
| `in_progress` | `/`              |
| `cancelled`   | `-`              |
| `forwarded`   | `>`              |

`other` is **read-only**: an agent can see a task whose marker is unrecognized
(e.g. `?`), but cannot *set* status `other` (there is no canonical char for it).
`set_task_state` rejects `status: "other"`.

### `ParsedTask` (index-internal, per-note)

```ts
interface ParsedTask {
  text: string;        // the part after the checkbox, trimmed
  status: TaskStatus;  // mapped from marker
  marker: string;      // the raw char inside the brackets, verbatim
  line: number;        // 0-based body line index (exposed 1-based downstream)
}
```

## Parser: `parseTasks(content): ParsedTask[]`

A new fence-aware parser in `src/tools/vault.ts`, sibling to `parseHeadings` and
reusing its fenced-code-block tracking so tasks inside ``` fences are excluded.

**Match rule** (per body line, outside fences):

```
^(\s*)[-*+]\s+\[(.)\]\s*(.*)$
```

- group 1: leading indentation (captured for future use; not surfaced in v1)
- `[-*+]`: any Markdown bullet
- group 2: the single marker char (may be a space)
- group 3: the task text (trimmed → `text`)

Also accept the empty-bracket form `\[\]` → marker `" "`, status `open`.

Lines that are list items but not checkboxes (`- plain bullet`) are **not**
tasks and are ignored. Order is document order, matching `parseHeadings`.

## Index integration

`IndexEntry` gains one field, populated in `buildEntry` beside `headings`:

```ts
interface IndexEntry {
  // ...existing...
  headings: ParsedHeading[];
  tasks: ParsedTask[];   // NEW — parsed once per file, cached, re-parsed on change
}
```

No change to the refresh lifecycle: unchanged files keep their cached `tasks`;
changed files are re-parsed along with everything else. No BM25 or backlink
impact.

## `list_tasks` (read tool)

New `src/tools/tasks.ts` → `listTasks(vaultPath, params)`. Index-backed, zero
file reads.

### Params

```ts
interface ListTasksParams {
  // Shared candidate filters (verbatim from list_notes):
  folder?: string;
  tags?: string[];
  match?: "any" | "all";                 // governs tags; default "any"
  where?: Record<string, Condition>;     // frontmatter conditions; all apply
  // Task-specific:
  status?: TaskStatus[];                 // restrict to these statuses (any of);
                                         // omitted → all tasks
  // Standard pagination:
  limit?: number;                        // default 100; 0 = unbounded
  offset?: number;                       // default 0
}
```

### Behavior

1. `resolveCandidates(index, { folder, tags, where, tagMatch: match ?? "any",
   whereMatch: "all" })` → surviving entries.
2. For each entry, flat-map its `tasks` into rows, computing `section` per task.
3. If `status` is given, keep only tasks whose `status` is in the set.
4. Window the flat row list through `toListResponse(rows, effectiveLimit,
   offset)`.

`status` is validated: if present, must be a non-empty array of valid status
names (including `other`, which is a legal *filter* value even though it is not a
legal *write* value).

### Row shape (`TaskRow`)

```ts
interface TaskRow {
  path: string;           // note path (no .md)
  text: string;
  status: TaskStatus;
  marker: string;         // raw marker char
  line: number;           // 1-based body line
  section: string | null; // " > "-joined heading-path the task falls under, else null
}
```

`section` is derived from the entry's cached `headings` via `headingPaths`: the
full path of the nearest heading at or before the task's line. `null` when the
task sits above any heading. This reuses machinery the index already holds, so
the row stays a pure lookup.

### Output

`ListResponse<TaskRow>` — `{ results, returned, skipped, omitted, truncated }`,
exactly like `list_notes`.

### Example

```
list_tasks({ folder: "projects", tags: ["work"], status: ["open", "in_progress"] })
→ every not-yet-done task in projects/ tagged #work, one call.
```

## `set_task_state` (write tool)

New `setTaskState(vaultPath, params)` in `src/tools/write.ts`, funneling through
the existing `editNote` → `commitWrite` path. Added to `WRITE_TOOL_NAMES`
(gated by `OBSIDIAN_ALLOW_WRITES`) and to the server-instructions link-integrity
list.

### Params

```ts
interface SetTaskStateParams {
  path: string;                 // required
  text?: string;                // exact task text (post-checkbox)
  line?: number;                // 1-based line tiebreak
  status: WritableTaskStatus;   // required; open|done|in_progress|cancelled|forwarded
}
```

### Addressing (text-primary, optional line tiebreak — fail-loud)

Matching is against the **task text** (the part after the checkbox), exact and
case-sensitive (like `patch_note`'s `find`), independent of the task's current
marker or indentation.

| Given          | Behavior                                                                                  |
| -------------- | ----------------------------------------------------------------------------------------- |
| `text` alone   | unique match → set it; 0 → error "task not found"; >1 → error listing candidate lines      |
| `text` + `line`| the task at `line` must exist **and** its text must equal `text`, else error (stale guard) |
| `line` alone   | positional: the task at that line; error if no task there                                  |
| neither        | error: "provide `text` and/or `line`"                                                      |

The ambiguity error lists the candidate 1-based line numbers so the agent
retries with `line`, mirroring `patch_note`'s occurrence-count error and
`read_section`'s candidate-path error.

### The edit

Parse the note body into lines, locate the target task line, and rewrite **only
the marker char inside the brackets** (`- [ ] x` → `- [x] x`), preserving
indentation, bullet char, surrounding whitespace, and text byte-for-byte. If the
task is already in the requested status (its marker already equals the canonical
marker for `status`), it is a **no-op**: `changed: false`, no write, no git
snapshot — matching how `add_tag` skips a redundant write.

Note: matching is by text, but the rewrite targets the located task line
specifically, so a marker rewrite never touches a different line that happens to
share text.

### Output (link-integrity convention)

```ts
{
  path: string;
  line: number;          // 1-based line touched
  text: string;          // the task's text
  status: TaskStatus;    // resulting status
  marker: string;        // canonical marker written
  changed: boolean;      // false on a no-op
  unresolved_links: string[];
  broken_anchors: { target: string; anchor: string }[];
}
```

Computed via `linkHealthAfterWrite` from the exact resulting content, like every
other content writer. Task text can contain `[[wikilinks]]`, so the report is
meaningful, not merely ceremonial.

## Integration surfaces

1. **`src/types.ts`** — add `TaskStatus`, `WritableTaskStatus`, `ParsedTask`,
   `TaskRow`, `ListTasksParams`, `SetTaskStateParams`.
2. **`src/tools/vault.ts`** — add `parseTasks` + the marker↔status maps
   (module-level, shared by parser and writer).
3. **`src/tools/vault-index.ts`** — add `tasks` to `IndexEntry`, populate in
   `buildEntry`.
4. **`src/tools/tasks.ts`** — `listTasks` (new file).
5. **`src/tools/write.ts`** — `setTaskState`; add to `WRITE_TOOL_NAMES`.
6. **`src/index.ts`** — register `list_tasks` (read) and `set_task_state`
   (gated write); add `set_task_state` to the instructions' link-integrity
   list and `list_tasks` to the pagination/filter lists; add
   `CallToolRequestSchema` cases.
7. **`src/query-cli.ts`** — `tasks` and `set-task-state` commands (operator
   testing surface).
8. **`CLAUDE.md` + `README.md`** — document both tools (repo requires both docs
   updated together).

## Testing

Node's built-in runner via tsx (`tests/*.test.ts`):

- **`tests/parse-tasks.test.ts`** — parser: each marker→status, fence exclusion,
  indentation preserved, `*`/`+` bullets, empty `[]`, plain bullets ignored,
  document order.
- **`tests/tasks.test.ts`** — `list_tasks`: candidate filtering
  (folder/tags/where), `status` array filter (including `other`), `section`
  context (task under a heading, task above all headings → null), pagination
  envelope, empty results (no tasks / filtered to zero).
- **`tests/set-task-state.test.ts`** — addressing matrix (text-unique,
  text-ambiguous→error with candidate lines, text+line, stale text+line→error,
  line-alone, no-task-at-line→error, not-found→error, neither→error); marker
  rewrite fidelity (indentation/bullet/text preserved); no-op when already in
  state; `status: "other"` rejected; link-health passthrough; write-gate
  (rejected when `OBSIDIAN_ALLOW_WRITES` unset).
- **`tests/tasks-cli.test.ts`** — the two CLI commands.

## Scope fence (explicit non-goals)

- **No changes to existing tools.** `bulk_edit` stays frontmatter-only; a
  `set_task_state`-in-bulk verb is out of scope for this sprint.
- **`other` is read-only.** Extended/custom markers are read faithfully, but
  only the five canonical statuses are writable.
- **No task creation/deletion.** `set_task_state` changes an existing task's
  marker; adding or removing task lines remains the job of the section/content
  write tools.
- **`indent`/nesting depth** is captured by the parser but not surfaced in v1
  (YAGNI — added only if a workflow needs hierarchy reconstruction).
