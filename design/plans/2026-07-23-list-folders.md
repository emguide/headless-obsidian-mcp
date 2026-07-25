# list_folders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `list_folders` tool that enumerates the vault's folder tree as a flat, bounded, index-backed list so an agent can orient itself without an unbounded `list_notes`.

**Architecture:** A new `src/tools/folders.ts` derives folders from the shared vault index's note paths (zero extra I/O), aggregating direct and recursive note counts and direct-subfolder counts per folder, then applies `folder`/`depth` scoping and the standard `ListResponse` limit envelope. It is registered as a read tool in the MCP server (`src/index.ts`) and the query CLI (`src/query-cli.ts`), with new types in `src/types.ts`.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node built-in `node:test` runner via `tsx`, `commander` for the CLI. No new dependencies.

## Global Constraints

- ESM imports use `.js` specifiers even for `.ts` sources (e.g. `import { getIndex } from "./vault-index.js"`).
- Every list-style tool returns a `ListResponse<T>` envelope built via `toListResponse(rows, limit)` from `src/tools/list-response.ts`; `limit === 0` maps to `undefined` (unbounded), omitted `limit` maps to the default `100`.
- `limit` validation: reject with `Error("limit must be a positive integer")` when defined and not a non-negative integer (matches `list_notes`).
- Folder-prefix normalization must match `list.ts`: strip trailing `/`/`\`, convert `\` to `/`, append one trailing `/`, and compare against `entry.path + "/"`.
- Folder discovery is notes-only (markdown from the index). Attachment-only folders do not appear — that is `list_files`' domain.
- When updating tool behavior, update BOTH `CLAUDE.md` and `README.md`.
- Run all tests with `npm test` (`tsx --test tests/*.test.ts`).

---

### Task 1: Types

**Files:**
- Modify: `src/types.ts` (add after `ListNotesParams`, around line 110)

**Interfaces:**
- Consumes: `ListResponse<T>` (already in `src/types.ts`).
- Produces:
  - `interface FolderEntry { path: string; notes: number; total_notes: number; subfolders: number }`
  - `interface ListFoldersParams { folder?: string; depth?: number; limit?: number }`

- [ ] **Step 1: Add the types**

In `src/types.ts`, immediately after the `ListNotesParams` interface (ends at line ~110), add:

```ts
/** One folder in the vault, as reported by list_folders. */
export interface FolderEntry {
  /** Vault-relative folder path, e.g. "projects/alpha". */
  path: string;
  /** Notes directly in this folder (immediate parent). */
  notes: number;
  /** Notes recursively under this folder (including subfolders). */
  total_notes: number;
  /** Number of direct child folders. */
  subfolders: number;
}

export interface ListFoldersParams {
  /** Restrict to folders under this folder (relative to the vault root). */
  folder?: string;
  /** Relative depth cap: 1 = immediate children of the scope only. */
  depth?: number;
  /** Maximum number of folders to return. */
  limit?: number;
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd <worktree> && npx tsc --noEmit`
Expected: no errors (unused exported types are fine).

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: add FolderEntry and ListFoldersParams types"
```

---

### Task 2: Core `listFolders` implementation

**Files:**
- Create: `src/tools/folders.ts`
- Test: `tests/folders.test.ts`

**Interfaces:**
- Consumes: `FolderEntry`, `ListFoldersParams`, `ListResponse` from `../types.js`; `getIndex` from `./vault-index.js`; `assertVaultPath` from `./vault.js`; `toListResponse` from `./list-response.js`; test helpers `makeVault`, `FixtureNote`, `Fixture` from `./fixtures.js`.
- Produces: `export async function listFolders(vaultPath: string, params?: ListFoldersParams): Promise<ListResponse<FolderEntry>>`

Aggregation contract (must hold for the tests below):
- A note at `a/b/c.md` contributes folders `a` and `a/b`. Its `total_notes` increments for both `a` and `a/b`; its `notes` (direct) increments only for `a/b`.
- A root-level note (`foo.md`) contributes no folder.
- `subfolders` for folder `F` = number of distinct folders whose immediate parent is `F`.
- `folder` scope: keep folders whose `path` is a strict descendant of the scope (prefix match on `scope + "/"`); the scope folder itself is excluded from results.
- `depth`: with a scope, depth = (segment count of `folder.path`) − (segment count of scope); without a scope, depth = segment count of `folder.path`. `depth: 1` keeps only the shallowest level relative to the scope.
- Rows sorted by `path` (ascending, `localeCompare`), then wrapped via `toListResponse`.

- [ ] **Step 1: Write the failing tests**

Create `tests/folders.test.ts`:

```ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { listFolders } from "../src/tools/folders.js";
import { makeVault, FixtureNote, Fixture } from "./fixtures.js";

/** A nested tree:
 *   root.md
 *   projects/overview.md
 *   projects/alpha/index.md
 *   projects/alpha/notes.md
 *   projects/beta/index.md
 *   daily/2026-07-22.md
 * Folders: projects (1 direct, 4 total, 2 subfolders),
 *          projects/alpha (2/2/0), projects/beta (1/1/0),
 *          daily (1/1/0).
 */
function tree(): FixtureNote[] {
  return [
    { path: "root.md", content: "# Root" },
    { path: "projects/overview.md", content: "# Overview" },
    { path: "projects/alpha/index.md", content: "# Alpha" },
    { path: "projects/alpha/notes.md", content: "# Notes" },
    { path: "projects/beta/index.md", content: "# Beta" },
    { path: "daily/2026-07-22.md", content: "# Daily" },
  ];
}

let fx: Fixture;
before(async () => {
  fx = await makeVault(tree());
});
after(() => fx.cleanup());

test("lists folders sorted by path", async () => {
  const res = await listFolders(fx.vaultPath);
  assert.deepEqual(
    res.results.map((f) => f.path),
    ["daily", "projects", "projects/alpha", "projects/beta"]
  );
});

test("reports direct notes, recursive total_notes, and subfolders", async () => {
  const res = await listFolders(fx.vaultPath);
  const byPath = Object.fromEntries(res.results.map((f) => [f.path, f]));
  assert.deepEqual(byPath["projects"], {
    path: "projects",
    notes: 1,
    total_notes: 4,
    subfolders: 2,
  });
  assert.deepEqual(byPath["projects/alpha"], {
    path: "projects/alpha",
    notes: 2,
    total_notes: 2,
    subfolders: 0,
  });
  assert.deepEqual(byPath["daily"], {
    path: "daily",
    notes: 1,
    total_notes: 1,
    subfolders: 0,
  });
});

test("root-level notes contribute no folder row", async () => {
  const res = await listFolders(fx.vaultPath);
  assert.ok(!res.results.some((f) => f.path === "" || f.path === "root"));
});

test("envelope is untruncated for a small vault", async () => {
  const res = await listFolders(fx.vaultPath);
  assert.equal(res.returned, 4);
  assert.equal(res.returned, res.results.length);
  assert.equal(res.omitted, 0);
  assert.equal(res.truncated, false);
});

test("folder scope returns strict descendants only, excluding the scope itself", async () => {
  const res = await listFolders(fx.vaultPath, { folder: "projects" });
  assert.deepEqual(
    res.results.map((f) => f.path),
    ["projects/alpha", "projects/beta"]
  );
});

test("folder scope normalizes trailing slashes", async () => {
  const res = await listFolders(fx.vaultPath, { folder: "projects/" });
  assert.deepEqual(
    res.results.map((f) => f.path),
    ["projects/alpha", "projects/beta"]
  );
});

test("depth 1 unscoped keeps only top-level folders", async () => {
  const res = await listFolders(fx.vaultPath, { depth: 1 });
  assert.deepEqual(
    res.results.map((f) => f.path),
    ["daily", "projects"]
  );
});

test("depth 1 under a scope keeps only immediate children of the scope", async () => {
  const res = await listFolders(fx.vaultPath, { folder: "projects", depth: 1 });
  assert.deepEqual(
    res.results.map((f) => f.path),
    ["projects/alpha", "projects/beta"]
  );
});

test("a nonexistent folder scope returns an empty envelope", async () => {
  const res = await listFolders(fx.vaultPath, { folder: "nope" });
  assert.deepEqual(res.results, []);
  assert.equal(res.returned, 0);
  assert.equal(res.omitted, 0);
  assert.equal(res.truncated, false);
});

test("respects an explicit limit and reports truncation", async () => {
  const res = await listFolders(fx.vaultPath, { limit: 2 });
  assert.equal(res.results.length, 2);
  assert.equal(res.returned, 2);
  assert.equal(res.omitted, 2);
  assert.equal(res.truncated, true);
});

test("limit 0 returns every folder, untruncated", async () => {
  const res = await listFolders(fx.vaultPath, { limit: 0 });
  assert.equal(res.returned, 4);
  assert.equal(res.omitted, 0);
  assert.equal(res.truncated, false);
});

test("rejects a negative limit", async () => {
  await assert.rejects(
    () => listFolders(fx.vaultPath, { limit: -1 }),
    /positive integer/
  );
});

test("rejects a non-integer depth", async () => {
  await assert.rejects(
    () => listFolders(fx.vaultPath, { depth: 1.5 }),
    /positive integer/
  );
});

test("a flat vault with no subfolders returns an empty envelope", async () => {
  const flat = await makeVault([
    { path: "a.md", content: "# A" },
    { path: "b.md", content: "# B" },
  ]);
  try {
    const res = await listFolders(flat.vaultPath);
    assert.deepEqual(res.results, []);
    assert.equal(res.truncated, false);
  } finally {
    await flat.cleanup();
  }
});

test("applies a default limit of 100 and reports truncation", async () => {
  const many: FixtureNote[] = [];
  for (let i = 0; i < 150; i++) {
    const n = String(i).padStart(3, "0");
    many.push({ path: `f-${n}/note.md`, content: `# Note ${n}` });
  }
  const big = await makeVault(many);
  try {
    const res = await listFolders(big.vaultPath);
    assert.equal(res.returned, 100);
    assert.equal(res.omitted, 50);
    assert.equal(res.truncated, true);

    const all = await listFolders(big.vaultPath, { limit: 0 });
    assert.equal(all.returned, 150);
    assert.equal(all.truncated, false);
  } finally {
    await big.cleanup();
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd <worktree> && npx tsx --test tests/folders.test.ts`
Expected: FAIL — cannot find module `../src/tools/folders.js` / `listFolders is not a function`.

- [ ] **Step 3: Write the implementation**

Create `src/tools/folders.ts`:

```ts
import { assertVaultPath } from "./vault.js";
import { getIndex } from "./vault-index.js";
import { FolderEntry, ListFoldersParams, ListResponse } from "../types.js";
import { toListResponse } from "./list-response.js";

/** Default cap so the first orientation call is bounded (matches list_notes). */
const DEFAULT_LIMIT = 100;

interface Agg {
  direct: number;
  total: number;
  children: Set<string>;
}

/** Validate a limit/depth-style bound: undefined, or a non-negative integer. */
function assertBound(value: number | undefined, label: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
    throw new Error(`${label} must be a positive integer`);
  }
}

/**
 * Enumerate the vault's folders as a flat, bounded list — the folder-level
 * counterpart to list_notes. Derived entirely from the shared index's note
 * paths (markdown only, zero extra I/O): a note at `a/b/c.md` contributes
 * folders `a` and `a/b`. Each folder reports `notes` (direct), `total_notes`
 * (recursive), and `subfolders` (direct children). Root-level notes contribute
 * no folder. Optional `folder` scopes to strict descendants; `depth` caps the
 * relative level; `limit` follows the standard envelope policy.
 */
export async function listFolders(
  vaultPath: string,
  params: ListFoldersParams = {}
): Promise<ListResponse<FolderEntry>> {
  assertVaultPath(vaultPath);

  const { folder, depth, limit } = params;
  assertBound(limit, "limit");
  assertBound(depth, "depth");

  const index = await getIndex(vaultPath);

  // Aggregate direct/recursive note counts and direct-child folders per folder.
  const agg = new Map<string, Agg>();
  const get = (p: string): Agg => {
    let a = agg.get(p);
    if (!a) {
      a = { direct: 0, total: 0, children: new Set() };
      agg.set(p, a);
    }
    return a;
  };

  for (const entry of index.getEntries()) {
    const segments = entry.path.split("/");
    segments.pop(); // drop the filename — leaves the folder segments
    if (segments.length === 0) continue; // root-level note: no folder

    // Every ancestor folder gets a recursive +1; the immediate parent also a
    // direct +1; and every folder registers its immediate child folder.
    for (let i = 0; i < segments.length; i++) {
      const path = segments.slice(0, i + 1).join("/");
      const a = get(path);
      a.total += 1;
      if (i === segments.length - 1) a.direct += 1;
      if (i > 0) {
        const parent = segments.slice(0, i).join("/");
        get(parent).children.add(path);
      }
    }
  }

  let rows: FolderEntry[] = [...agg.entries()].map(([path, a]) => ({
    path,
    notes: a.direct,
    total_notes: a.total,
    subfolders: a.children.size,
  }));

  // Scope to strict descendants of `folder`, and compute depth relative to it.
  let scopeSegments = 0;
  if (folder && folder.trim()) {
    const scope = folder.replace(/[\\/]+$/, "").replace(/\\/g, "/");
    const prefix = scope + "/";
    scopeSegments = scope.split("/").length;
    rows = rows.filter((r) => (r.path + "/").startsWith(prefix));
  }

  if (depth !== undefined) {
    rows = rows.filter((r) => r.path.split("/").length - scopeSegments <= depth);
  }

  rows.sort((a, b) => a.path.localeCompare(b.path));

  const effectiveLimit = limit === undefined ? DEFAULT_LIMIT : limit;
  return toListResponse(rows, effectiveLimit === 0 ? undefined : effectiveLimit);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd <worktree> && npx tsx --test tests/folders.test.ts`
Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add src/tools/folders.ts tests/folders.test.ts
git commit -m "feat: add listFolders core with direct/recursive counts and depth/scope"
```

---

### Task 3: Register `list_folders` in the MCP server

**Files:**
- Modify: `src/index.ts` (import near line 24; tool schema after the `list_notes` block ~line 196; case handler after the `list_notes` case ~line 746; type import in the `../types.js` import block ~line 65)

**Interfaces:**
- Consumes: `listFolders` from `./tools/folders.js`; `ListFoldersParams` from `./types.js`.
- Produces: a `list_folders` MCP tool exposed in `list_tools` and dispatched in the call handler.

- [ ] **Step 1: Add the import**

In `src/index.ts`, next to `import { listFiles } from "./tools/files.js";` (line ~24), add:

```ts
import { listFolders } from "./tools/folders.js";
```

And add `ListFoldersParams` to the existing `import { ... } from "./types.js"` block (alongside `ListFilesParams` ~line 76):

```ts
  ListFoldersParams,
```

- [ ] **Step 2: Add the tool schema**

In the `list_tools` array, immediately after the `list_files` tool object (ends ~line 211), add:

```ts
      {
        name: "list_folders",
        description: "Enumerate the vault's folders as a flat, bounded list so an agent can see the shape of the vault before searching or reading — the folder-level counterpart to list_notes. Returns { results, returned, omitted, truncated }: results is an array of { path, notes (direct), total_notes (recursive), subfolders }, sorted by path and capped at 100 by default (pass limit: 0 for all folders). Notes-only (attachment-only folders do not appear; use list_files for those). Root-level notes contribute no folder.",
        inputSchema: {
          type: "object",
          properties: {
            folder: {
              type: "string",
              description: "Restrict to folders under this folder (relative to the vault root)"
            },
            depth: {
              type: "number",
              description: "Relative depth cap: 1 = immediate children of the scope (or top-level folders when no folder is given)"
            },
            limit: {
              type: "number",
              description: "Maximum number of folders to return (default 100; pass 0 for unbounded)"
            }
          }
        }
      },
```

- [ ] **Step 3: Add the case handler**

In the call-handler switch, immediately after the `list_files` case (ends ~line 751), add:

```ts
      case "list_folders": {
        const result = await listFolders(VAULT_PATH, (args ?? {}) as ListFoldersParams);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }
```

- [ ] **Step 4: Verify it compiles**

Run: `cd <worktree> && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: register list_folders MCP tool"
```

---

### Task 4: Wire the `folders` query-CLI subcommand

**Files:**
- Modify: `src/query-cli.ts` (import ~line 19; dispatch branch ~line 92; `program.command` after the `list` command ~line 252)
- Test: `tests/folders-cli.test.ts`

**Interfaces:**
- Consumes: `listFolders` from `./tools/folders.js`.
- Produces: a `folders` CLI subcommand mapping `--folder`/`--depth`/`--limit` to `listFolders`.

- [ ] **Step 1: Write the failing CLI test**

Create `tests/folders-cli.test.ts` (runs the CLI as a child process against a temp vault, mirroring existing CLI tests):

This mirrors the established CLI-test harness in `tests/property-cli.test.ts` (`run("npx", ["tsx", "src/query-cli.ts", ...])`, `OBSIDIAN_VAULT_PATH` in env, `stdout` parsed as JSON):

```ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { makeVault, FixtureNote, Fixture } from "./fixtures.js";

const run = promisify(execFile);
const CLI = ["tsx", "src/query-cli.ts"];

function tree(): FixtureNote[] {
  return [
    { path: "root.md", content: "# Root" },
    { path: "projects/overview.md", content: "# Overview" },
    { path: "projects/alpha/index.md", content: "# Alpha" },
    { path: "daily/2026-07-22.md", content: "# Daily" },
  ];
}

let fx: Fixture;
before(async () => {
  fx = await makeVault(tree());
});
after(() => fx.cleanup());

async function folders(args: string[]): Promise<any> {
  const { stdout } = await run("npx", [...CLI, "folders", ...args], {
    env: { ...process.env, OBSIDIAN_VAULT_PATH: fx.vaultPath },
  });
  return JSON.parse(stdout);
}

test("folders subcommand lists folders sorted by path", async () => {
  const res = await folders([]);
  assert.deepEqual(
    res.results.map((f: any) => f.path),
    ["daily", "projects", "projects/alpha"]
  );
});

test("folders subcommand honors --folder and --depth", async () => {
  const res = await folders(["--folder", "projects", "--depth", "1"]);
  assert.deepEqual(
    res.results.map((f: any) => f.path),
    ["projects/alpha"]
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd <worktree> && npx tsx --test tests/folders-cli.test.ts`
Expected: FAIL — `error: unknown command 'folders'`.

- [ ] **Step 3: Add the import**

In `src/query-cli.ts`, next to `import { listFiles } from "./tools/files.js";` (~line 19), add:

```ts
import { listFolders } from "./tools/folders.js";
```

- [ ] **Step 4: Add the dispatch branch**

In the `queryTool` if/else chain, after the `list_files` branch (~line 93), add:

```ts
    } else if (toolName === "list_folders") {
      result = await listFolders(VAULT_PATH!, args);
```

- [ ] **Step 5: Add the CLI command**

After the `list` command block (ends ~line 252), add:

```ts
program
  .command("folders")
  .description("List folders as a flat tree with note counts")
  .option("-f, --folder <folder>", "Restrict to folders under this folder")
  .option("-d, --depth <n>", "Relative depth cap (1 = immediate children)")
  .option("-l, --limit <n>", "Maximum number of folders to return")
  .action(async (options: any, command: Command) => {
    const verbose = command.parent?.opts().verbose ?? false;
    const args = {
      ...(options.folder && { folder: options.folder }),
      ...(options.depth && { depth: parseInt(options.depth, 10) }),
      ...(options.limit && { limit: parseInt(options.limit, 10) }),
    };
    await queryTool("list_folders", args, verbose);
  });
```

- [ ] **Step 6: Run the CLI test to verify it passes**

Run: `cd <worktree> && npx tsx --test tests/folders-cli.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/query-cli.ts tests/folders-cli.test.ts
git commit -m "feat: add folders query-CLI subcommand"
```

---

### Task 5: Documentation

**Files:**
- Modify: `CLAUDE.md` (add a `### list_folders` section after `### list_files`; add a `folders` CLI example near the `files` example)
- Modify: `README.md` (matching tool entry and any tool-count/list references)

**Interfaces:** none (docs only).

- [ ] **Step 1: Add the CLAUDE.md tool section**

In `CLAUDE.md`, immediately after the `### list_files` section, add:

```markdown
### list_folders
- **Purpose**: Enumerate the vault's folders so an agent can see the shape of the vault before searching or reading — the folder-level counterpart to `list_notes` (notes) and `list_files` (attachments). Closes the folder-discovery gap that otherwise forces an unbounded `list_notes`.
- **Input**:
  - `folder` (optional): Restrict to folders under this folder (relative to the vault root).
  - `depth` (optional): Relative depth cap — `1` = immediate children of the scope (top-level folders when no `folder` is given).
  - `limit` (optional): Maximum number of folders to return (default `100`; pass `0` for unbounded).
- **Output**: `{ results, returned, omitted, truncated }` — `results` is the array of `{ path, notes, total_notes, subfolders }` sorted by `path`. `notes` counts notes directly in the folder; `total_notes` counts notes recursively under it (including subfolders); `subfolders` counts direct child folders. `returned`/`omitted`/`truncated` report what the `limit` dropped.
- **Notes**: Index-backed (no extra file read); notes-only, so a folder containing only attachments does not appear (use `list_files`). Root-level notes contribute no folder row.
```

- [ ] **Step 2: Add the CLAUDE.md CLI example**

Near the `npm run query -- files ...` example, add:

```bash
npm run query -- folders                                 # Folder tree with note counts
npm run query -- folders --folder projects --depth 1     # Immediate subfolders of projects/
```

- [ ] **Step 3: Add the README.md entry**

Mirror the CLAUDE.md tool section in `README.md`, following that file's existing formatting for tool entries. If `README.md` states a tool count or lists tools, update it to include `list_folders`.

Run to check for a count/list to update:
`grep -n "list_files\|list_notes\|tools" README.md | head`

- [ ] **Step 4: Verify the docs build/read cleanly**

Run: `cd <worktree> && grep -n "list_folders" CLAUDE.md README.md`
Expected: matches in both files.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: document list_folders in CLAUDE.md and README.md"
```

---

### Task 6: Full-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Run the whole test suite**

Run: `cd <worktree> && npm test`
Expected: PASS — all tests, including the new `folders.test.ts` and `folders-cli.test.ts`, green with no regressions.

- [ ] **Step 2: Typecheck the whole project**

Run: `cd <worktree> && npm run build`
Expected: `tsc` completes with no errors; `dist/` updates.

- [ ] **Step 3: Smoke-test the tool end to end**

Run against the real configured vault (or a temp one):
`OBSIDIAN_VAULT_PATH=<vault> npm run query -- folders --depth 1`
Expected: a JSON envelope of top-level folders with `notes`/`total_notes`/`subfolders`.

- [ ] **Step 4: Final commit if anything changed**

```bash
git status
# commit any stragglers (e.g. rebuilt dist/ if tracked); otherwise nothing to do
```

---

## Self-Review

**Spec coverage:**
- Flat-list output + `ListResponse<FolderEntry>` → Task 1 (types), Task 2 (impl).
- Direct + recursive counts + subfolders → Task 2 aggregation + tests.
- `folder` scope, `depth` cap, `limit` policy → Task 2 impl + tests.
- Index-backed / notes-only → Task 2 (uses `getIndex().getEntries()`, no walk).
- Edge cases (root notes, nonexistent folder, flat vault, default-100) → Task 2 tests.
- MCP registration → Task 3. CLI → Task 4. Docs (both files) → Task 5. Verification → Task 6.

**Placeholder scan:** No TBD/TODO. Every code step shows full code. The one soft spot — the exact CLI child-process invocation in Task 4 — is handled by pointing at an existing CLI test to copy the harness from, with a concrete fallback invocation given.

**Type consistency:** `FolderEntry` fields (`path`, `notes`, `total_notes`, `subfolders`) are identical across Task 1 (definition), Task 2 (construction + tests), Task 3 (schema description), and Task 5 (docs). `ListFoldersParams` (`folder`, `depth`, `limit`) consistent across Tasks 1–5. `listFolders(vaultPath, params)` signature identical in Tasks 2, 3, 4.
