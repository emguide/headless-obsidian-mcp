# list_folders — Folder discovery for the vault

**Date:** 2026-07-23
**Status:** Approved, pending implementation

## Problem

Nothing in the toolset enumerates the vault's folder structure. An agent orients
itself by pulling note paths (via `list_notes`) and inferring the folder tree
from them — which forces an unbounded `list_notes` (the default 100-note cap
truncates the very paths needed to see the shape of the vault). A cheap,
index-backed `list_folders` closes this loop for a few dozen tokens.

## Purpose

Enumerate the vault's folders as a flat, bounded list so an agent can see the
shape of the vault before searching or reading — the folder-level counterpart to
`list_notes` (notes) and `list_files` (attachments).

## Output shape

Flat list in the standard `ListResponse<FolderEntry>` envelope — the same shape
as every other list-style tool.

```ts
interface FolderEntry {
  path: string;        // vault-relative folder path, e.g. "projects/alpha"
  notes: number;       // notes DIRECTLY in this folder (immediate parent)
  total_notes: number; // notes recursively under this folder (incl. subfolders)
  subfolders: number;  // count of direct child folders
}
```

Results are sorted by `path` and wrapped as
`{ results, returned, omitted, truncated }` — the `ListResponse<T>` envelope, so
a limit-capped result is never mistaken for a complete one.

### Why both counts

`notes` (direct) and `total_notes` (recursive) remove the ambiguity a single
count would carry. An agent can see "`projects` has 2 notes directly but 47 under
it" in one row, distinguishing an organizing folder from a leaf. The recursive
count also matches how `list_notes({ folder })` behaves (prefix match over all
descendants), so the two tools agree.

## Input

```ts
interface ListFoldersParams {
  folder?: string; // scope to descendants of this folder (like list_notes)
  depth?: number;  // relative depth cap: 1 = immediate children of the scope only
  limit?: number;  // default 100; 0 = unbounded (same policy as list_notes)
}
```

- No `folder` → the whole vault. `folder: "projects"` → folders under `projects/`.
- `depth: 1` → only the immediate child folders of the scope (top-level folders
  when unscoped). Omitted → all depths under the scope.
- `limit` follows the established default-100 / `0`-unbounded policy, validated
  exactly like `list_notes`: a positive integer or `0`, else an error.

`depth` is **relative to the scope**, not absolute: `folder: "projects",
depth: 1` means "immediate children of `projects/`".

## Data flow (index-backed, zero extra I/O)

1. `getIndex(vaultPath)` → `index.getEntries()` (already sorted by path).
2. For each note, derive its ancestor folder paths from `path` (split on `/`,
   drop the filename). A root-level note (`foo.md`) contributes no folder.
3. Aggregate into a `Map<folderPath, { direct, total, childSet }>`:
   - `direct`: notes whose immediate parent is this folder.
   - `total`: every ancestor folder of a note gets +1 (so `total` is recursive).
   - `subfolders`: the size of `childSet`, the set of direct-child folder paths
     observed for this folder.
4. Apply the `folder` scope (prefix filter, normalized as `list_notes` does) and
   the `depth` cap (count path segments relative to the scope root).
5. Sort rows by `path`; wrap via `toListResponse(rows, effectiveLimit)` where
   `effectiveLimit` is `undefined` when `limit === 0` (unbounded) else the limit.

The vault index tracks markdown notes only, so folder discovery is notes-driven:
a folder containing only attachments does not appear (attachment discovery is
`list_files`' job). No directory walk beyond the shared index refresh.

## Edge cases

- **Root-level notes** contribute to no folder entry; there is no synthetic root
  row. An agent wanting the root count uses unscoped `list_notes`, or reads
  `total_notes` on the top-level folders.
- **`folder` matching no folder** returns an empty `results` (not an error),
  matching `list_notes`, where a zero-match filter simply returns empty.
- **Trailing slashes / backslashes** in `folder` are normalized exactly as
  `list_notes` normalizes its `folder` prefix.
- **A vault with no subfolders** returns empty `results` with
  `truncated: false` — unambiguous.
- **`limit`/`depth` validation**: non-integer or negative values are rejected
  with a clear error, mirroring `list_notes`' limit validation.

## Wiring

- New file `src/tools/folders.ts` (mirrors `src/tools/list.ts`).
- `FolderEntry` and `ListFoldersParams` added to `src/types.ts`.
- `list_folders` registered in the read-tool set: the MCP server tool list and a
  `folders` subcommand in the query CLI.
- CLAUDE.md and README.md both updated (per the project doc rule).

## Testing

Node `node:test` suite (via tsx), mirroring the `list` tests, covering:

- nested fixtures: direct vs. recursive counts on a multi-level tree;
- `subfolders` count correctness;
- `depth` cap (relative to scope), including `depth: 1` at top level and under a
  scope;
- `folder` scoping (including a nonexistent folder → empty);
- `limit` default, `limit: 0` unbounded, and the `truncated`/`omitted` envelope
  fields;
- root-level note handling (contributes no folder row);
- an empty vault and a flat (no-subfolder) vault.

## Out of scope (YAGNI)

- No nested-tree output — a flat list fits the existing envelope and the agent
  reconstructs hierarchy from paths.
- No attachment-driven folders — `list_files` already covers non-note discovery.
- No per-folder tag/property aggregation — orientation only.
