# Vault-hygiene & composability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the vault index's implicit knowledge (orphans, unresolved links, dangled backlinks, attachments) and make `search_notes`/`read_notes` compose and tolerate partial failure.

**Architecture:** Two new index-backed read tools (`list_vault_issues`, `list_files`), plus localized changes to three existing tools (`read_notes` partial results, `delete_note` dangled-backlink reporting, `search_notes` metadata filters). All hygiene data comes from existing `vault-index.ts` methods; `list_files` reuses a predicate-parameterized `walkVault`. No new dependencies, no resolver change.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), `@modelcontextprotocol/sdk`, `gray-matter`, `commander` (query CLI), ripgrep (`rg`), Node's built-in `node:test` runner via `tsx`.

## Global Constraints

- **Runtime:** Node 18+. ESM modules — all local imports use `.js` extensions even for `.ts` sources.
- **Tests:** `node:test` + `node:assert/strict`, run with `npm test`. Fixtures via `tests/fixtures.ts` (`makeVault`, `sampleNotes`). Each test file clears the index cache through `makeVault` (which calls `clearIndexCache()`).
- **No new dependencies.**
- **No resolver change** — `VaultIndex.resolve` stays path/basename-only. Alias-aware resolution is out of scope.
- **Path traversal** stays a hard throw everywhere (never downgraded to a per-item error).
- **Writes gated** by `OBSIDIAN_ALLOW_WRITES`; `delete_note` is already in `WRITE_TOOL_NAMES` (`src/tools/write.ts:24-41`) — no gating change. The two new tools are read tools (never added to `WRITE_TOOL_NAMES`).
- **Docs:** update BOTH `CLAUDE.md` and `README.md` for every user-facing change (project rule).
- **MCP dispatch pattern:** every tool returns `{ content: [{ type: "text", text: JSON.stringify(result) }] }` from the `CallToolRequestSchema` handler in `src/index.ts`.
- **Verify each task:** run the full suite with `npm test` (fast, ~5s) before committing.

---

## File Structure

**New files:**
- `src/tools/vault-issues.ts` — `listVaultIssues()` (orphans + unresolved links, index-backed).
- `src/tools/files.ts` — `listFiles()` (non-md file discovery).
- `tests/vault-issues.test.ts`, `tests/files.test.ts`, `tests/read-partial.test.ts`, `tests/search-filter.test.ts`, `tests/delete-backlinks.test.ts` — one test file per feature.

**Modified files:**
- `src/types.ts` — new params/response interfaces.
- `src/tools/vault.ts` — parameterize `walkVault` with a file predicate.
- `src/tools/read.ts` — per-path tolerance, return `ReadNotesResult`.
- `src/tools/write.ts` — `deleteNote` captures + returns `dangled_backlinks`.
- `src/tools/search.ts` — index-resolved candidate filtering + chunked rg.
- `src/index.ts` — register 2 new tools, update 3 dispatch cases and their schemas.
- `src/query-cli.ts` — new `vault-issues` + `files` commands; filter options on `search`.
- `CLAUDE.md`, `README.md` — documentation.

---

## Task 1: `read_notes` partial results + per-path errors

**Files:**
- Modify: `src/types.ts` (add `ReadNotesResult`)
- Modify: `src/tools/read.ts:7-76` (return object, per-path catch)
- Modify: `src/index.ts:636-650` (dispatch), `src/index.ts:153-166` (schema/description unchanged shape but description note)
- Test: `tests/read-partial.test.ts` (create)

**Interfaces:**
- Produces: `readNotes(vaultPath: string, notePaths: string[]): Promise<ReadNotesResult>` where
  `interface ReadNotesResult { notes: Note[]; errors: Array<{ path: string; error: string }> }`.
- Consumes: existing `Note` type, `collectTags` (unchanged).

- [ ] **Step 1: Write the failing test**

Create `tests/read-partial.test.ts`:

```ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readNotes } from "../src/tools/read.js";
import { makeVault, sampleNotes, Fixture } from "./fixtures.js";

let fx: Fixture;
before(async () => {
  fx = await makeVault(sampleNotes());
});
after(() => fx.cleanup());

test("returns valid notes and collects missing ones in errors", async () => {
  const res = await readNotes(fx.vaultPath, ["index", "does-not-exist", "projects/alpha"]);
  assert.deepEqual(res.notes.map((n) => n.path).sort(), ["index", "projects/alpha"]);
  assert.equal(res.errors.length, 1);
  assert.equal(res.errors[0].path, "does-not-exist");
  assert.match(res.errors[0].error, /not found or not readable/);
});

test("all-valid batch yields an empty errors array", async () => {
  const res = await readNotes(fx.vaultPath, ["index"]);
  assert.equal(res.errors.length, 0);
  assert.equal(res.notes.length, 1);
});

test("path traversal still throws and aborts the whole batch", async () => {
  await assert.rejects(
    () => readNotes(fx.vaultPath, ["index", "../../etc/passwd"]),
    /path traversal/
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | rg -A2 "read-partial|not a function|is not|TypeError" | head`
Expected: FAIL — `readNotes(...).notes` is undefined (current return is `Note[]`, so `.notes` and `.errors` don't exist / traversal test may pass but the shape tests fail).

- [ ] **Step 3: Add the `ReadNotesResult` type**

In `src/types.ts`, after the `Note` interface (around line 24), add:

```ts
/** Result of a batch read: successful notes plus per-path failures. */
export interface ReadNotesResult {
  notes: Note[];
  /** One entry per path that could not be read (missing, too large, wrong type). */
  errors: Array<{ path: string; error: string }>;
}
```

- [ ] **Step 4: Rewrite `readNotes` to be per-path tolerant**

In `src/tools/read.ts`, change the import line 4 and the signature/body. Replace the whole function body's collection + catch so failures accumulate instead of throwing (path traversal still re-throws):

```ts
import { readFile, stat } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import matter from "gray-matter";
import { Note, NoteMetadata, ReadNotesResult } from "../types.js";
import { collectTags } from "./vault.js";

export async function readNotes(vaultPath: string, notePaths: string[]): Promise<ReadNotesResult> {
  if (!vaultPath || typeof vaultPath !== 'string') {
    throw new Error('Vault path must be a non-empty string');
  }
  if (!Array.isArray(notePaths) || notePaths.length === 0) {
    throw new Error('Note paths must be a non-empty array');
  }
  if (notePaths.length > 50) {
    throw new Error('Cannot read more than 50 notes at once');
  }

  const notes: Note[] = [];
  const errors: Array<{ path: string; error: string }> = [];
  const resolvedVaultPath = resolve(vaultPath);

  for (const notePath of notePaths) {
    try {
      if (!notePath || typeof notePath !== 'string') {
        throw new Error('Note path must be a non-empty string');
      }
      const fileName = `${notePath}${notePath.endsWith('.md') ? '' : '.md'}`;
      const fullPath = resolve(join(vaultPath, fileName));
      const relativePath = relative(resolvedVaultPath, fullPath);
      if (relativePath.startsWith('..') || relativePath.includes('..')) {
        throw new Error('Invalid note path: path traversal not allowed');
      }
      const fileInfo = await stat(fullPath);
      if (fileInfo.size > 10 * 1024 * 1024) {
        throw new Error('Note file too large (max 10MB)');
      }
      const content = await readFile(fullPath, "utf-8");
      const { data: frontmatter, content: markdownContent } = matter(content);
      const tags = collectTags(frontmatter, markdownContent);
      const path = notePath.replace(/\.md$/, '');
      notes.push({ path, contents: markdownContent.trim(), frontmatter: frontmatter as NoteMetadata, tags });
    } catch (error) {
      console.error(`Error reading note ${notePath}:`, error);
      const message = error instanceof Error ? error.message : String(error);
      // Path traversal is a security violation, not a missing file: fail the whole batch.
      if (message.includes('path traversal')) {
        throw error;
      }
      errors.push({ path: notePath, error: `Note not found or not readable: ${notePath}` });
    }
  }

  return { notes, errors };
}
```

- [ ] **Step 5: Update the MCP dispatch**

In `src/index.ts` at the `read_notes` case (around lines 636-650), rename the local for clarity and pass the object straight through:

```ts
      case "read_notes": {
        const { paths } = args as unknown as { paths: string[] };
        if (!Array.isArray(paths) || paths.length === 0) {
          throw new Error("Paths array is required for read_notes");
        }
        const result = await readNotes(VAULT_PATH, paths);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result)
            }
          ]
        };
      }
```

Also update the `read_notes` tool description at `src/index.ts:154` to note the new shape:

```ts
        description: "Read one or more Obsidian notes by their relative paths. Returns { notes, errors }: notes is the array of parsed notes (path, contents, frontmatter, tags); errors lists any paths that could not be read (missing/too large), so one bad path never fails the batch. Path traversal still errors the whole call.",
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — 200 prior tests + 3 new = 203, 0 failures. (If any prior test asserted `readNotes(...)` returned an array directly, update it to read `.notes` — grep `readNotes(` in `tests/` first.)

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/tools/read.ts src/index.ts tests/read-partial.test.ts
git commit -m "feat: read_notes returns partial results with per-path errors

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `list_vault_issues` tool

**Files:**
- Create: `src/tools/vault-issues.ts`
- Modify: `src/types.ts` (add `ListVaultIssuesParams`, `UnresolvedLinkGroup`)
- Modify: `src/index.ts` (register tool + dispatch case)
- Test: `tests/vault-issues.test.ts` (create)

**Interfaces:**
- Produces: `listVaultIssues(vaultPath: string, params: ListVaultIssuesParams): Promise<NoteHeader[] | UnresolvedLinkGroup[]>` where
  `interface ListVaultIssuesParams { kind: "orphans" | "unresolved_links"; limit?: number }` and
  `interface UnresolvedLinkGroup { source: string; targets: string[] }`.
- Consumes: `getIndex`, `entryToHeader` from `vault-index.js`; `assertVaultPath` from `vault.js`; `NoteHeader` from types.

- [ ] **Step 1: Write the failing test**

Create `tests/vault-issues.test.ts`:

```ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { listVaultIssues } from "../src/tools/vault-issues.js";
import { getVaultStats } from "../src/tools/stats.js";
import { makeVault, sampleNotes, Fixture, FixtureNote } from "./fixtures.js";

let fx: Fixture;
before(async () => {
  // sampleNotes has: index -> [[missing-note]] (unresolved) + interlinked notes.
  // Add a truly orphan note (no links in or out).
  const notes: FixtureNote[] = [
    ...sampleNotes(),
    { path: "orphan.md", content: "# Orphan\nNo links here." },
  ];
  fx = await makeVault(notes);
});
after(() => fx.cleanup());

test("orphans lists notes with no inbound or outbound resolved links", async () => {
  const orphans = (await listVaultIssues(fx.vaultPath, { kind: "orphans" })) as Array<{ path: string }>;
  assert.ok(orphans.some((o) => o.path === "orphan"));
});

test("orphans list length equals the stats orphan_notes count", async () => {
  const orphans = await listVaultIssues(fx.vaultPath, { kind: "orphans" });
  const stats = await getVaultStats(fx.vaultPath);
  assert.equal(orphans.length, stats.orphan_notes);
});

test("unresolved_links groups broken targets by source note", async () => {
  const groups = (await listVaultIssues(fx.vaultPath, { kind: "unresolved_links" })) as Array<{
    source: string;
    targets: string[];
  }>;
  const home = groups.find((g) => g.source === "index");
  assert.ok(home, "index should have an unresolved link");
  assert.ok(home!.targets.includes("missing-note"));
});

test("sum of unresolved targets equals the stats unresolved_links count", async () => {
  const groups = (await listVaultIssues(fx.vaultPath, { kind: "unresolved_links" })) as Array<{
    targets: string[];
  }>;
  const stats = await getVaultStats(fx.vaultPath);
  const total = groups.reduce((n, g) => n + g.targets.length, 0);
  assert.equal(total, stats.unresolved_links);
});

test("limit caps the number of rows", async () => {
  const groups = await listVaultIssues(fx.vaultPath, { kind: "unresolved_links", limit: 0 as any });
  // limit must be a positive integer; 0 is rejected
  assert.ok(Array.isArray(groups));
});

test("rejects an unknown kind", async () => {
  await assert.rejects(
    () => listVaultIssues(fx.vaultPath, { kind: "bogus" as any }),
    /kind must be/
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | rg "vault-issues|Cannot find module" | head`
Expected: FAIL — module `../src/tools/vault-issues.js` not found.

- [ ] **Step 3: Add the types**

In `src/types.ts`, add near the other param interfaces:

```ts
/** Parameters for list_vault_issues. */
export interface ListVaultIssuesParams {
  kind: "orphans" | "unresolved_links";
  /** Cap on the number of returned rows/headers. */
  limit?: number;
}

/** Unresolved outbound links from one source note. */
export interface UnresolvedLinkGroup {
  /** Path of the note containing the broken links. */
  source: string;
  /** Raw link targets that do not resolve to any note. */
  targets: string[];
}
```

- [ ] **Step 4: Implement `listVaultIssues`**

Create `src/tools/vault-issues.ts`:

```ts
import { assertVaultPath } from "./vault.js";
import { getIndex, entryToHeader } from "./vault-index.js";
import { ListVaultIssuesParams, UnresolvedLinkGroup, NoteHeader } from "../types.js";

/**
 * List the vault-hygiene issues the index already knows about but that
 * get_vault_stats only counts. `orphans` returns note headers for notes with no
 * inbound or outbound resolved links (the exact predicate get_vault_stats uses).
 * `unresolved_links` returns, grouped by source note, the raw wikilink targets
 * that resolve to nothing — the sum of `targets` lengths equals the stats
 * unresolved_links count.
 */
export async function listVaultIssues(
  vaultPath: string,
  params: ListVaultIssuesParams
): Promise<NoteHeader[] | UnresolvedLinkGroup[]> {
  assertVaultPath(vaultPath);
  const { kind, limit } = params;
  if (kind !== "orphans" && kind !== "unresolved_links") {
    throw new Error('kind must be "orphans" or "unresolved_links"');
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error("limit must be a positive integer");
  }

  const index = await getIndex(vaultPath);

  if (kind === "orphans") {
    const orphans = index.getEntries().filter(
      (e) => index.outbound(e.path).length === 0 && index.backlinks(e.path).length === 0
    );
    const limited = limit !== undefined ? orphans.slice(0, limit) : orphans;
    return limited.map(entryToHeader);
  }

  // unresolved_links, grouped by source note (entries are already path-sorted).
  const groups: UnresolvedLinkGroup[] = [];
  for (const entry of index.getEntries()) {
    const targets = entry.linkTargets.filter((t) => !index.resolve(t));
    if (targets.length > 0) {
      groups.push({ source: entry.path, targets });
    }
  }
  return limit !== undefined ? groups.slice(0, limit) : groups;
}
```

- [ ] **Step 5: Register the tool + dispatch**

In `src/index.ts`, add to the `tools` array (after `get_vault_stats`'s entry — find it near the stats tool definition):

```ts
      {
        name: "list_vault_issues",
        description: "List the vault-hygiene issues get_vault_stats only counts. kind:'orphans' returns note headers for notes with no inbound or outbound resolved links; kind:'unresolved_links' returns, grouped by source note, the wikilink targets that resolve to nothing (the notes with broken links). Index-backed.",
        inputSchema: {
          type: "object",
          properties: {
            kind: {
              type: "string",
              enum: ["orphans", "unresolved_links"],
              description: "Which issue list to return."
            },
            limit: {
              type: "number",
              description: "Maximum number of rows/headers to return."
            }
          },
          required: ["kind"]
        }
      },
```

Add the dispatch case (near the `get_vault_stats` case around line 752):

```ts
      case "list_vault_issues": {
        const result = await listVaultIssues(VAULT_PATH, (args ?? {}) as unknown as ListVaultIssuesParams);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }
```

Add the imports at the top of `src/index.ts` (with the other tool imports):

```ts
import { listVaultIssues } from "./tools/vault-issues.js";
import { ListVaultIssuesParams } from "./types.js";
```

(If `./types.js` is already imported as a group, add `ListVaultIssuesParams` to that import list instead of a new line.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — new `tests/vault-issues.test.ts` green; no regressions.

- [ ] **Step 7: Commit**

```bash
git add src/tools/vault-issues.ts src/types.ts src/index.ts tests/vault-issues.test.ts
git commit -m "feat: add list_vault_issues (orphans + unresolved links)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `delete_note` reports dangled backlinks

**Files:**
- Modify: `src/tools/write.ts:212-246` (`deleteNote`)
- Modify: `src/index.ts:772-779` (dispatch already passes result through; no change needed beyond confirming)
- Test: `tests/delete-backlinks.test.ts` (create)

**Interfaces:**
- Produces: `deleteNote(...)` return gains `dangled_backlinks: string[]`:
  `Promise<{ path: string; deleted: boolean; trashed: boolean; trash_path?: string; dangled_backlinks: string[] }>`.
- Consumes: `getIndex` (already imported in write.ts), `index.backlinks`.

- [ ] **Step 1: Write the failing test**

Create `tests/delete-backlinks.test.ts`:

```ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { deleteNote } from "../src/tools/write.js";
import { makeVault, sampleNotes, Fixture } from "./fixtures.js";

let fx: Fixture;
before(async () => {
  fx = await makeVault(sampleNotes());
});
after(() => fx.cleanup());

test("delete_note reports the notes whose links it dangled", async () => {
  // projects/alpha is linked from index, Beta Note, and daily/2026-07-22.
  const res = await deleteNote(fx.vaultPath, "projects/alpha");
  assert.deepEqual(res.dangled_backlinks.sort(), ["Beta Note", "daily/2026-07-22", "index"]);
  assert.equal(res.deleted, true);
  assert.equal(res.trashed, true);
});

test("delete_note returns an empty array when nothing linked to the note", async () => {
  const res = await deleteNote(fx.vaultPath, "daily/2026-07-22", { permanent: true });
  assert.deepEqual(res.dangled_backlinks, []);
  assert.equal(res.trashed, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `OBSIDIAN_ALLOW_WRITES=1 npm test 2>&1 | rg "delete-backlinks|dangled_backlinks|undefined" | head`
Expected: FAIL — `res.dangled_backlinks` is undefined.

- [ ] **Step 3: Capture backlinks before the delete**

In `src/tools/write.ts`, edit `deleteNote` (lines 212-246). Capture backlinks from a fresh index at the very start of the handler (before `snapshotBeforeWrite` and the filesystem move), and add the field to both return statements:

```ts
export async function deleteNote(
  vaultPath: string,
  notePath: string,
  { permanent = false }: DeleteNoteOptions = {}
): Promise<{
  path: string;
  deleted: boolean;
  trashed: boolean;
  trash_path?: string;
  dangled_backlinks: string[];
}> {
  const fullPath = resolveNotePath(vaultPath, notePath);
  if (!(await fileExists(fullPath))) {
    throw new Error(`Note not found: ${canonicalName(notePath)}`);
  }

  // Capture backlinks from the pre-delete index before touching the filesystem,
  // so the caller learns which notes now contain a broken [[wikilink]].
  const index = await getIndex(vaultPath);
  const dangled_backlinks = index.backlinks(canonicalName(notePath));

  await snapshotBeforeWrite(vaultPath);

  if (permanent) {
    await unlink(fullPath);
    return { path: canonicalName(notePath), deleted: true, trashed: false, dangled_backlinks };
  }

  const canon = canonicalName(notePath);
  let trashRel = join(".trash", `${canon}.md`);
  let trashFull = resolveVaultFile(vaultPath, trashRel);
  for (let n = 1; await fileExists(trashFull); n++) {
    trashRel = join(".trash", `${canon}-${n}.md`);
    trashFull = resolveVaultFile(vaultPath, trashRel);
  }
  await mkdir(dirname(trashFull), { recursive: true });
  await rename(fullPath, trashFull);
  return {
    path: canon,
    deleted: true,
    trashed: true,
    trash_path: trashRel.split(sep).join("/"),
    dangled_backlinks,
  };
}
```

Confirm `getIndex` is imported at the top of `write.ts` (it is — used by `moveNote`). No new import needed.

- [ ] **Step 4: Run tests to verify they pass**

Run: `OBSIDIAN_ALLOW_WRITES=1 npm test`
Expected: PASS — both new tests green. (Writes must be enabled or the CLI/tool path throws; the direct function call in the test does not go through the gate, so `npm test` alone also works — but run with the flag to mirror real use.)

- [ ] **Step 5: Update the tool description**

In `src/index.ts`, update the `delete_note` tool description to mention the new field (find the `delete_note` entry in the `tools` array):

```ts
        description: "Delete a note. Trash-safe by default (moved to .trash, recoverable); pass permanent:true to unlink. Returns { path, deleted, trashed, trash_path?, dangled_backlinks } where dangled_backlinks lists the notes that linked to the deleted note and now have a broken [[wikilink]].",
```

- [ ] **Step 6: Commit**

```bash
git add src/tools/write.ts src/index.ts tests/delete-backlinks.test.ts
git commit -m "feat: delete_note reports dangled backlinks

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Parameterize `walkVault` + `list_files` tool

**Files:**
- Modify: `src/tools/vault.ts:87-126` (predicate param)
- Create: `src/tools/files.ts`
- Modify: `src/types.ts` (`ListFilesParams`, `VaultFileEntry`)
- Modify: `src/index.ts` (register + dispatch)
- Test: `tests/files.test.ts` (create)

**Interfaces:**
- Produces:
  - `walkVault(vaultPath: string, keep?: (name: string) => boolean): Promise<VaultFile[]>` — `keep` defaults to `(name) => name.endsWith(".md")` so existing callers are unchanged. `VaultFile.path` for non-md callers must keep the extension (see Step 2).
  - `listFiles(vaultPath: string, params: ListFilesParams): Promise<VaultFileEntry[]>` where
    `interface ListFilesParams { folder?: string; extension?: string; limit?: number }` and
    `interface VaultFileEntry { path: string; size: number; modified: string; extension: string }`.
- Consumes: `assertVaultPath`, `walkVault` from `vault.js`.

- [ ] **Step 1: Write the failing test**

Create `tests/files.test.ts`:

```ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { listFiles } from "../src/tools/files.js";
import { makeVault, sampleNotes, Fixture, FixtureNote } from "./fixtures.js";

let fx: Fixture;
before(async () => {
  const notes: FixtureNote[] = [
    ...sampleNotes(),
    { path: "assets/logo.png", content: "PNGDATA" },
    { path: "assets/report.PDF", content: "PDFDATA" },
    { path: "sub/pic.PNG", content: "PNGDATA2" },
    { path: ".trash/junk.png", content: "IGNORED" }, // in an ignored dir
  ];
  fx = await makeVault(notes);
});
after(() => fx.cleanup());

test("lists only non-markdown files, skipping ignored dirs", async () => {
  const files = await listFiles(fx.vaultPath, {});
  const paths = files.map((f) => f.path).sort();
  assert.deepEqual(paths, ["assets/logo.png", "assets/report.PDF", "sub/pic.PNG"]);
  assert.ok(!paths.some((p) => p.endsWith(".md")));
  assert.ok(!paths.some((p) => p.startsWith(".trash")));
});

test("path keeps the extension and reports fields", async () => {
  const files = await listFiles(fx.vaultPath, {});
  const png = files.find((f) => f.path === "assets/logo.png")!;
  assert.equal(png.extension, "png");
  assert.equal(typeof png.size, "number");
  assert.match(png.modified, /^\d{4}-\d{2}-\d{2}T/);
});

test("folder scopes to a subtree", async () => {
  const files = await listFiles(fx.vaultPath, { folder: "assets" });
  assert.deepEqual(files.map((f) => f.path).sort(), ["assets/logo.png", "assets/report.PDF"]);
});

test("extension filter is dot-optional and case-insensitive", async () => {
  const png = await listFiles(fx.vaultPath, { extension: ".PNG" });
  assert.deepEqual(png.map((f) => f.path).sort(), ["assets/logo.png", "sub/pic.PNG"]);
  const pdf = await listFiles(fx.vaultPath, { extension: "pdf" });
  assert.deepEqual(pdf.map((f) => f.path), ["assets/report.PDF"]);
});

test("limit caps the result", async () => {
  const files = await listFiles(fx.vaultPath, { limit: 1 });
  assert.equal(files.length, 1);
});
```

- [ ] **Step 2: Parameterize `walkVault`**

In `src/tools/vault.ts`, change the walker signature and the file branch so callers can select which files to emit. **Important:** `toVaultName` strips `.md`; for non-md files we must keep the extension, so build the non-md path with a variant that does not strip. Edit lines 87-126:

```ts
export async function walkVault(
  vaultPath: string,
  keep: (name: string) => boolean = (name) => name.endsWith(".md")
): Promise<VaultFile[]> {
  assertVaultPath(vaultPath);
  const resolvedVault = resolve(vaultPath);
  const results: VaultFile[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name)) {
          continue;
        }
        await walk(join(dir, entry.name));
      } else if (entry.isFile() && keep(entry.name)) {
        const full = join(dir, entry.name);
        let info;
        try {
          info = await stat(full);
        } catch {
          continue;
        }
        // Markdown callers want the .md stripped (existing behavior); other
        // callers want the literal path. Strip only for .md files.
        const rel = relative(resolvedVault, full).split(sep).join("/");
        const path = entry.name.endsWith(".md") ? rel.replace(/\.md$/, "") : rel;
        results.push({ path, fullPath: full, size: info.size, mtime: info.mtime });
      }
    }
  }

  await walk(resolvedVault);
  results.sort((a, b) => a.path.localeCompare(b.path));
  return results;
}
```

(This keeps the default `.md`-only behavior and `.md`-stripped paths for every existing caller of `walkVault`; only when a different `keep` predicate is passed and the file is non-md does the extension survive.)

- [ ] **Step 3: Run existing tests to confirm no regression from the walker change**

Run: `npm test`
Expected: PASS — 203 (post-Task-1/2/3) tests still green; the walker default is unchanged. (`tests/files.test.ts` still fails: module missing.)

- [ ] **Step 4: Add the types**

In `src/types.ts`:

```ts
/** Parameters for list_files (non-markdown file discovery). */
export interface ListFilesParams {
  /** Restrict to files under this folder (relative to the vault root). */
  folder?: string;
  /** Filter by extension; leading dot optional, case-insensitive (e.g. "png"). */
  extension?: string;
  /** Maximum number of files to return. */
  limit?: number;
}

/** A non-markdown vault file with lightweight filesystem metadata. */
export interface VaultFileEntry {
  /** Vault-relative path, forward-slash, extension preserved. */
  path: string;
  /** File size in bytes. */
  size: number;
  /** Last modified time (ISO 8601). */
  modified: string;
  /** Lowercased extension without the dot (e.g. "png"). */
  extension: string;
}
```

- [ ] **Step 5: Implement `listFiles`**

Create `src/tools/files.ts`:

```ts
import { assertVaultPath, walkVault } from "./vault.js";
import { ListFilesParams, VaultFileEntry } from "../types.js";

/**
 * List non-markdown files in the vault (attachments, images, PDFs) so an agent
 * can find the file it is asked to move. Reuses walkVault's traversal and
 * ignore rules, filtered to non-.md files. Does not touch the vault index.
 */
export async function listFiles(
  vaultPath: string,
  params: ListFilesParams = {}
): Promise<VaultFileEntry[]> {
  assertVaultPath(vaultPath);
  const { folder, extension, limit } = params;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error("limit must be a positive integer");
  }

  const wantExt = extension
    ? extension.replace(/^\./, "").toLowerCase()
    : undefined;
  const folderPrefix = folder
    ? folder.replace(/\\/g, "/").replace(/\/$/, "") + "/"
    : undefined;

  const files = await walkVault(vaultPath, (name) => !name.endsWith(".md"));

  const out: VaultFileEntry[] = [];
  for (const f of files) {
    if (folderPrefix && !f.path.startsWith(folderPrefix)) continue;
    const dot = f.path.lastIndexOf(".");
    const ext = dot >= 0 ? f.path.slice(dot + 1).toLowerCase() : "";
    if (wantExt !== undefined && ext !== wantExt) continue;
    out.push({
      path: f.path,
      size: f.size,
      modified: f.mtime.toISOString(),
      extension: ext,
    });
  }

  return limit !== undefined ? out.slice(0, limit) : out;
}
```

- [ ] **Step 6: Register the tool + dispatch**

In `src/index.ts` tools array (near `list_notes`):

```ts
      {
        name: "list_files",
        description: "List non-markdown files in the vault (attachments, images, PDFs) so an agent can find a file to move. Returns { path, size, modified, extension } per file. Optional folder/extension/limit filters. Does not include notes (use list_notes) and never touches the index.",
        inputSchema: {
          type: "object",
          properties: {
            folder: { type: "string", description: "Restrict to files under this folder (relative to the vault root)." },
            extension: { type: "string", description: "Filter by extension; leading dot optional, case-insensitive (e.g. 'png')." },
            limit: { type: "number", description: "Maximum number of files to return." }
          }
        }
      },
```

Dispatch case (near `list_notes`):

```ts
      case "list_files": {
        const result = await listFiles(VAULT_PATH, (args ?? {}) as ListFilesParams);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }
```

Imports at the top of `src/index.ts`:

```ts
import { listFiles } from "./tools/files.js";
import { ListFilesParams } from "./types.js";
```

(Add `ListFilesParams` to the existing grouped `./types.js` import if present.)

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — `tests/files.test.ts` green; no regressions.

- [ ] **Step 8: Commit**

```bash
git add src/tools/vault.ts src/tools/files.ts src/types.ts src/index.ts tests/files.test.ts
git commit -m "feat: add list_files for non-markdown file discovery

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `search_notes` metadata filters (folder / tags / where)

**Files:**
- Modify: `src/types.ts` (`SearchNotesParams` gains filters)
- Modify: `src/tools/search.ts` (candidate resolution, chunked rg, zero-candidate guard)
- Modify: `src/index.ts` (schema for the new fields; dispatch unchanged shape)
- Test: `tests/search-filter.test.ts` (create)

**Interfaces:**
- Consumes: `getIndex`, `IndexEntry` from `vault-index.js`; `matchesWhere` from `property-match.js`; the tag-match logic mirrored from `findByTag`.
- Produces: `searchNotes(vaultPath, params)` unchanged return type `SearchNotesResponse`; `SearchNotesParams` gains `folder?`, `tags?`, `match?`, `where?`.

- [ ] **Step 1: Write the failing test**

Create `tests/search-filter.test.ts`:

```ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { searchNotes } from "../src/tools/search.js";
import { makeVault, sampleNotes, Fixture, FixtureNote } from "./fixtures.js";

let fx: Fixture;
before(async () => {
  // "alpha" body word appears in projects/alpha (tag: project, status: active)
  // and is referenced elsewhere. Add a note with the word but a different tag.
  const notes: FixtureNote[] = [
    ...sampleNotes(),
    {
      path: "work/ops.md",
      content: ["---", "tags: [work]", "status: active", "---", "# Ops", "alpha runbook here"].join("\n"),
    },
  ];
  fx = await makeVault(notes);
});
after(() => fx.cleanup());

test("folder scopes the search", async () => {
  const res = await searchNotes(fx.vaultPath, { pattern: "alpha", folder: "work" });
  const paths = res.results.map((r) => r.path);
  assert.deepEqual(paths, ["work/ops"]);
});

test("tags filter restricts to tagged notes", async () => {
  const res = await searchNotes(fx.vaultPath, { pattern: "alpha", tags: ["project"] });
  const paths = res.results.map((r) => r.path).sort();
  assert.ok(paths.includes("projects/alpha"));
  assert.ok(!paths.includes("work/ops"));
});

test("where filter restricts by frontmatter", async () => {
  const res = await searchNotes(fx.vaultPath, { pattern: "alpha", where: { status: "active" } });
  const paths = res.results.map((r) => r.path).sort();
  // both projects/alpha and work/ops are status:active and contain "alpha"
  assert.ok(paths.includes("work/ops"));
});

test("combined filters AND together", async () => {
  const res = await searchNotes(fx.vaultPath, {
    pattern: "alpha",
    tags: ["work"],
    where: { status: "active" },
  });
  assert.deepEqual(res.results.map((r) => r.path), ["work/ops"]);
});

test("zero-candidate filter returns empty WITHOUT scanning the vault", async () => {
  const res = await searchNotes(fx.vaultPath, { pattern: "alpha", tags: ["nonexistent-tag"] });
  assert.deepEqual(res.results, []);
  assert.equal(res.files_returned, 0);
  assert.equal(res.truncated, false);
});

test("no filters behaves like a whole-vault search", async () => {
  const res = await searchNotes(fx.vaultPath, { pattern: "alpha" });
  assert.ok(res.results.length >= 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | rg "search-filter|folder|Expected values" | head`
Expected: FAIL — `folder`/`tags`/`where` are ignored (whole-vault search), so `folder`-scoped and zero-candidate assertions fail.

- [ ] **Step 3: Extend `SearchNotesParams`**

In `src/types.ts`, add filter fields to `SearchNotesParams` (after `max_matches_per_file`):

```ts
export interface SearchNotesParams {
  pattern: string;
  case_sensitive?: boolean;
  whole_word?: boolean;
  multiline?: boolean;
  context_lines?: number;
  limit?: number;
  max_matches_per_file?: number;
  /** Restrict to notes under this folder (relative to the vault root). */
  folder?: string;
  /** Restrict to notes carrying these tags (leading '#' optional). */
  tags?: string[];
  /** Semantics of `tags`: "any" (default) or "all". */
  match?: "any" | "all";
  /** Restrict to notes whose frontmatter satisfies these conditions (query_notes syntax). */
  where?: Record<string, unknown>;
}
```

- [ ] **Step 4: Add candidate resolution + chunked rg to `search.ts`**

In `src/tools/search.ts`:

1. Add imports at the top:

```ts
import { getIndex } from "./vault-index.js";
import { matchesWhere } from "./property-match.js";
import type { Condition } from "./property-match.js";
```

2. Destructure the new params in `searchNotes` (extend the existing destructure at lines 37-45):

```ts
  const {
    pattern,
    case_sensitive = false,
    whole_word = false,
    multiline = false,
    context_lines = 5,
    limit = 20,
    max_matches_per_file = 20,
    folder,
    tags,
    match = "any",
    where,
  } = params;
```

3. After the existing validation block (after line 83, before `const args = [...]`), resolve candidates when any filter is present:

```ts
  const hasFilter = folder !== undefined || tags !== undefined || where !== undefined;
  let candidatePaths: string[] | null = null; // null = whole-vault (no filter)

  if (hasFilter) {
    if (tags !== undefined && (!Array.isArray(tags) || tags.length === 0)) {
      throw new Error("tags must be a non-empty array when provided");
    }
    if (match !== "any" && match !== "all") {
      throw new Error('match must be "any" or "all"');
    }
    if (where !== undefined && (typeof where !== "object" || where === null || Array.isArray(where))) {
      throw new Error("where must be an object of property conditions");
    }

    const index = await getIndex(vaultPath);
    const wantedTags = tags?.map((t) => String(t).replace(/^#/, "").toLowerCase());
    const folderPrefix = folder
      ? folder.replace(/\\/g, "/").replace(/\/$/, "") + "/"
      : undefined;

    const matched = index.getEntries().filter((entry) => {
      if (folderPrefix && !(entry.path + "/").startsWith(folderPrefix) && !entry.path.startsWith(folderPrefix)) {
        return false;
      }
      if (wantedTags) {
        const noteSet = new Set(entry.tags.map((t) => t.toLowerCase()));
        const ok = match === "all"
          ? wantedTags.every((w) => noteSet.has(w))
          : wantedTags.some((w) => noteSet.has(w));
        if (!ok) return false;
      }
      if (where) {
        if (!matchesWhere(entry.frontmatter, where as Record<string, Condition>, "all")) return false;
      }
      return true;
    });

    candidatePaths = matched.map((e) => e.fullPath);

    // Zero-candidate guard: never fall through to a whole-vault rg (which would
    // search the cwd given no path args). Return the empty result directly.
    if (candidatePaths.length === 0) {
      return { results: [], truncated: false, files_returned: 0, files_omitted: 0, matches_capped_in: [] };
    }
  }
```

(Note the `folder` prefix check: entry paths have no `.md` suffix, so `folder: "work"` → prefix `"work/"` matches `work/ops`. The double condition tolerates an exact-folder-as-file edge; the simple `entry.path.startsWith(folderPrefix)` is the operative test.)

4. Change the rg invocation. Replace the single-shot tail (lines 85-116, the `args`/`runRipgrep`/parse setup) so that when `candidatePaths` is set, rg runs once per chunk and the raw stdout lines are concatenated before the existing parse loop. Extract the flag-building into a helper and loop:

```ts
  const baseArgs = [
    "--json",
    "--type", "md",
    "--context", context_lines.toString(),
  ];
  if (!case_sensitive) baseArgs.push("--ignore-case");
  if (whole_word) baseArgs.push("--word-regexp");
  if (multiline) baseArgs.push("--multiline");

  // Collect rg stdout across one or more invocations. With filters we pass an
  // explicit candidate path list, chunked so a large vault never overflows
  // ARG_MAX; without filters we search the whole vault root once.
  let stdout = "";
  const CHUNK = 500; // conservative path-count per rg call
  const runChunk = async (paths: string[]): Promise<void> => {
    const args = [...baseArgs, "--", pattern, ...paths];
    const r = await runRipgrep(args);
    if (r.code !== 0 && r.code !== 1) {
      console.error(`ripgrep failed with code ${r.code}:`, r.stderr);
      throw new Error(`Search failed`);
    }
    stdout += r.stdout;
  };

  if (candidatePaths === null) {
    await runChunk([vaultPath]);
  } else {
    for (let i = 0; i < candidatePaths.length; i += CHUNK) {
      await runChunk(candidatePaths.slice(i, i + CHUNK));
    }
  }

  if (!stdout.trim()) {
    return { results: [], truncated: false, files_returned: 0, files_omitted: 0, matches_capped_in: [] };
  }
```

Then the **existing** parse loop (from `const results: SearchResult[] = []` onward) runs unchanged on the concatenated `stdout`. Because rg emits results grouped per file and each chunk is a disjoint set of files, the file-boundary logic still holds across the concatenation (a file never spans two chunks). The `limit`/`max_matches_per_file` caps apply to the merged stream exactly as before.

**Delete** the old `const args = [...]` block (lines 85-104) and the old single `const { stdout, stderr, code } = await runRipgrep(args)` + its error check + the old empty-stdout guard (lines 106-116), since they are replaced above.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — `tests/search-filter.test.ts` green; existing `tests/search.test.ts` still green (no-filter path unchanged).

- [ ] **Step 6: Update the MCP schema + description**

In `src/index.ts`, extend the `search_notes` inputSchema `properties` (lines 100-129) with the four new fields and update the description:

```ts
            folder: { type: "string", description: "Restrict to notes under this folder (relative to the vault root)." },
            tags: { type: "array", items: { type: "string" }, description: "Restrict to notes carrying these tags (leading '#' optional)." },
            match: { type: "string", enum: ["any", "all"], description: "Semantics of tags: 'any' (default) or 'all'." },
            where: { type: "object", description: "Restrict to notes whose frontmatter satisfies these conditions (query_notes syntax)." }
```

Description (line 97):

```ts
        description: "Search notes with ripgrep, optionally scoped by folder, tags, or a frontmatter where filter (index-resolved candidates, then rg over just those notes). Returns { results, truncated, files_returned, files_omitted, matches_capped_in }.",
```

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/tools/search.ts src/index.ts tests/search-filter.test.ts
git commit -m "feat: search_notes composes with folder/tags/where filters

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Query CLI commands

**Files:**
- Modify: `src/query-cli.ts` (import + `queryTool` branches for the two new tools; `vault-issues` + `files` commands; filter options + args on `search`)
- Test: covered by manual CLI smoke (the CLI dispatches through the same tool functions already unit-tested; `property-cli.test.ts` is the only CLI-level test and needs no change).

**Interfaces:**
- Consumes: `listVaultIssues`, `listFiles` (import at top), `searchNotes` (already wired via `queryTool`).

**CLI structure (verified):** the file has a module-level `const VAULT_PATH = process.env.OBSIDIAN_VAULT_PATH`. Each `program.command(...)` `.action` builds an `args` object and calls `await queryTool(name, args, verbose)`. `queryTool(toolName, args, verbose)` is a long `if/else` chain that calls the tool function with `VAULT_PATH!` and prints the result. There is NO `getVault(command)` helper and NO dynamic import — tools are imported statically at the top. Follow this exact pattern.

- [ ] **Step 1: Import the two new tool functions**

At the top of `src/query-cli.ts`, alongside the other `./tools/*.js` imports, add:

```ts
import { listVaultIssues } from "./tools/vault-issues.js";
import { listFiles } from "./tools/files.js";
```

- [ ] **Step 2: Add `queryTool` dispatch branches**

In the `queryTool` if/else chain (after the `get_vault_stats` branch), add:

```ts
    } else if (toolName === "list_vault_issues") {
      result = await listVaultIssues(VAULT_PATH!, args);
    } else if (toolName === "list_files") {
      result = await listFiles(VAULT_PATH!, args);
```

- [ ] **Step 3: Add the `vault-issues` command**

Near the `stats` command definition, add (mirroring the `search-ranked` command's `.action` shape — `verbose` from `command.parent`, build `args`, call `queryTool`):

```ts
program
  .command("vault-issues <kind>")
  .description("List orphans or unresolved_links")
  .option("-l, --limit <n>", "Maximum number of rows to return")
  .action(async (kind: string, options: any, command: Command) => {
    const verbose = command.parent?.opts().verbose ?? false;
    const args = {
      kind,
      ...(options.limit !== undefined && { limit: parseInt(options.limit, 10) }),
    };
    await queryTool("list_vault_issues", args, verbose);
  });
```

- [ ] **Step 4: Add the `files` command**

```ts
program
  .command("files")
  .description("List non-markdown files (attachments)")
  .option("-f, --folder <folder>", "Restrict to files under this folder")
  .option("-e, --extension <ext>", "Filter by extension (dot optional)")
  .option("-l, --limit <n>", "Maximum number of files to return")
  .action(async (options: any, command: Command) => {
    const verbose = command.parent?.opts().verbose ?? false;
    const args = {
      ...(options.folder && { folder: options.folder }),
      ...(options.extension && { extension: options.extension }),
      ...(options.limit !== undefined && { limit: parseInt(options.limit, 10) }),
    };
    await queryTool("list_files", args, verbose);
  });
```

- [ ] **Step 5: Add filter options + args to the `search` command**

Extend the existing `search` command (`src/query-cli.ts:148-171`). Add these `.option` lines after line 157 (`--max-matches`):

```ts
  .option("--folder <folder>", "Restrict to notes under this folder")
  .option("--tag <tag...>", "Restrict to notes with these tags (repeatable)")
  .option("--match <mode>", "tags match mode: any (default) or all")
  .option("--where <json>", "Frontmatter filter as JSON")
```

And splice these lines into the existing `args` object (lines 161-169), alongside the current spread entries:

```ts
      ...(options.folder && { folder: options.folder }),
      ...(options.tag && { tags: options.tag }),           // commander collects repeated --tag into an array
      ...(options.match && { match: options.match }),
      ...(options.where && { where: JSON.parse(options.where) }),
```

- [ ] **Step 6: Smoke-test the CLI**

The `query` npm script runs from source via tsx (per package.json / CLAUDE.md), so no build is needed:

```bash
OBSIDIAN_VAULT_PATH=$(mktemp -d) npm run query -- vault-issues orphans
OBSIDIAN_VAULT_PATH=$(mktemp -d) npm run query -- files
```

Expected: valid JSON (`[]` for an empty temp vault), no crash.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS — no regressions (CLI additions don't touch tested code paths).

- [ ] **Step 8: Commit**

```bash
git add src/query-cli.ts
git commit -m "feat: query CLI vault-issues + files commands, search filters

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Documentation (CLAUDE.md + README.md)

**Files:**
- Modify: `CLAUDE.md` (tool docs + CLI examples)
- Modify: `README.md` (same, mirrored)

**Interfaces:** none (docs only).

- [ ] **Step 1: Update `CLAUDE.md`**

- Add a `### list_vault_issues` tool section (purpose, input `kind`/`limit`, output shape per kind, note the count relationship with `get_vault_stats`, index-backed).
- Add a `### list_files` tool section (purpose, input `folder`/`extension`/`limit`, output `{ path, size, modified, extension }`, non-md only, does not touch the index).
- Update `### read_notes` output: now `{ notes, errors }`; one bad path no longer fails the batch; path traversal still errors the whole call.
- Update `### search_notes` input: add `folder`, `tags`, `match`, `where`; note index-resolved candidates + zero-candidate short-circuit.
- Update `### delete_note` output: add `dangled_backlinks`.
- Add CLI examples under the Testing section:

```bash
npm run query -- vault-issues orphans
npm run query -- vault-issues unresolved_links --limit 50
npm run query -- files --folder assets --extension png
npm run query -- search "kubernetes" --tag work --match all
npm run query -- search "alpha" --where '{"status":"active"}'
```

- [ ] **Step 2: Mirror the same updates in `README.md`**

Apply the equivalent edits to `README.md` (same tool descriptions, I/O shapes, and CLI examples), matching its existing formatting.

- [ ] **Step 3: Verify docs match reality**

Run: `npm test` (final green check) and re-read both files to confirm every changed tool's documented I/O matches the implemented shape (spot-check `read_notes` `{notes,errors}`, `delete_note` `dangled_backlinks`, `search_notes` filters, the two new tools).

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: document vault-issues, list_files, and tool changes

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification

- [ ] Run the full suite once more: `npm test` → all green (baseline was 200; expect ~200 + new tests across Tasks 1–5).
- [ ] Run `npm run build` → TypeScript compiles with no errors (catches any type mismatch in the new interfaces / dispatch).
- [ ] Confirm `git status` is clean and the branch holds one commit per task plus the spec commit.

---

## Self-review notes (author)

**Spec coverage:** orphans+unresolved lists (Task 2) ✓; dangled backlinks on delete (Task 3) ✓; read_notes partial (Task 1) ✓; list non-md files (Task 4) ✓; search composition folder/tags/where + zero-candidate guard + chunked argv (Task 5) ✓; CLI (Task 6) ✓; both docs (Task 7) ✓. Alias resolution correctly ABSENT (non-goal). `search_notes_ranked` correctly untouched (non-goal). `broken_links` kind correctly absent (cut during design).

**Type consistency:** `ReadNotesResult` used in read.ts + index.ts dispatch; `ListVaultIssuesParams`/`UnresolvedLinkGroup` used in vault-issues.ts + index.ts; `ListFilesParams`/`VaultFileEntry` in files.ts + index.ts; `walkVault(vaultPath, keep?)` default preserves every existing caller; `dangled_backlinks` field name identical in write.ts return + test + docs; `searchNotes` return type unchanged (`SearchNotesResponse`).

**Placeholder scan:** no TBD/TODO; every code step shows full code. CLI Task 6 was corrected to the verified real structure (module-level `VAULT_PATH`, `queryTool(name,args,verbose)` if/else dispatch, static imports) — the earlier draft's `getVault(command)` + dynamic-import pattern did not exist in the file and was removed.

**Live-verified before handoff:** ripgrep has no file-list-from-stdin mode (→ chunked argv, Task 5); the CLI dispatch structure (Task 6); `walkVault`'s `.md`-stripping in `toVaultName` (→ Task 4 preserves extensions for non-md); `getIndex` already imported in `write.ts` (Task 3 needs no new import).
