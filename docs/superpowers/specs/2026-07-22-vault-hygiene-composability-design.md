# Vault-hygiene & composability

**Date:** 2026-07-22
**Status:** Approved design — ready for implementation plan

## Problem

The vault index holds knowledge it does not expose, and several tools do not
compose:

1. **Hygiene counts without lists.** `get_vault_stats` counts orphan notes and
   unresolved links, but no tool lists their members. Vault-hygiene agents need
   the lists, not the counts.
2. **`delete_note` silently dangles backlinks.** It never reports the notes
   whose `[[wikilinks]]` it just broke, though the index has them.
3. **`read_notes` is all-or-nothing.** One bad path throws and aborts the whole
   batch (`read.ts:71`); an agent reading 20 notes loses 19 because one moved.
4. **Attachments are undiscoverable.** `move_file` can move a non-markdown file,
   but no tool lists non-markdown files, so an agent cannot find the attachment
   it is asked to move.
5. **Search does not compose with metadata.** `search_notes` cannot be scoped to
   a folder, tag, or frontmatter filter; that requires a full search plus
   client-side intersection.

(A sixth observation — alias-aware link resolution — is **out of scope** for
this round; see Non-goals.)

## Theme

Surface the index's implicit knowledge, and make tools compose. Six observations,
one spec. No new dependencies. No resolver change.

## Non-goals

- **Alias-aware link resolution.** Resolution stays path/basename-only
  (`vault-index.ts:137`). A `[[Some Alias]]` that Obsidian would resolve via
  frontmatter `aliases` continues to count as unresolved. Deferred to a later
  spec. Consequence: the `unresolved_links` list faithfully reflects *current*
  resolution behavior.
- **`search_notes_ranked` filters.** Only `search_notes` gains metadata filters
  this round.
- **Destructive backlink rewriting on delete.** `delete_note` reports dangled
  backlinks; it does not touch them.

## Design

### 1. `list_vault_issues` (new read tool)

Single tool, `kind` param, index-backed (no file reads).

```
list_vault_issues({ kind, limit? })
  kind: 'orphans' | 'unresolved_links'   (required)
  limit?: number                          (caps the returned array)
```

- **`orphans`** → note headers (same shape as `list_notes`) for notes where
  `index.outbound(path).length === 0 && index.backlinks(path).length === 0`.
  Reuses the **exact** predicate `get_vault_stats` uses (`stats.ts:44-46`) so the
  count and the list can never disagree.
- **`unresolved_links`** → grouped by source note:
  `[{ source, targets: [...] }]`, one row per note that has at least one
  unresolved raw `linkTarget`. `targets` is the list of that note's raw link
  targets where `index.resolve(target)` is null.
  - This single grouped shape answers both agent questions — "which notes have
    broken links" (`source`) and "which targets are broken" (`targets`) —
    without a separate flat-edge kind.
  - **Count relationship:** `get_vault_stats.unresolved_links` counts
    per-reference; this tool returns per-source rows. The sum of `targets.length`
    across all rows equals the stats count. Documented explicitly.

`limit` caps the number of returned rows/headers. The return shape is
polymorphic by `kind`; documented per kind in README/CLAUDE.md.

**CLI:** `npm run query -- vault-issues orphans [--limit N]` and
`... vault-issues unresolved_links [--limit N]`.

### 2. `delete_note` — report dangled backlinks

Non-destructive. Before the file is trashed/unlinked, capture
`index.backlinks(canonicalPath)` from a fresh index (`getIndex` refreshes on
every call, so the capture happens at the **start** of the handler, before the
move).

Return gains one field:

```
delete_note(...) → {
  path, deleted, trashed, trash_path?,
  dangled_backlinks: [ "notes/a", "notes/b" ]   // source paths that linked here
}
```

- Source paths only (the paths of notes that contained a `[[wikilink]]`
  resolving to the deleted note).
- Empty array when nothing pointed at it.
- The links themselves are left untouched; the agent decides what to do.
  `list_vault_issues('unresolved_links')` will also report these post-delete.

### 3. `read_notes` — partial results + per-path errors

Per-path try/catch. A failing path goes into an `errors` array instead of
throwing the whole batch.

```
read_notes(['a','gone','b']) → {
  notes:  [ {a}, {b} ],
  errors: [ { path: 'gone', error: 'Note not found or not readable: gone' } ]
}
```

- `errors` is **always present** (may be empty). This is a response-shape change
  from the current bare array; documented as such.
- **Path-traversal still throws** and aborts the whole call — it is a security
  violation, not a missing file (preserves `read.ts:68-70`). Only the
  "not found / not readable / too large / wrong type" class is captured
  per-path.
- The 50-path input cap is unchanged.

### 4. `list_files` (new read tool)

Lists **non-markdown** files (attachments, images, PDFs) so an agent can find
the file it is asked to move.

```
list_files({ folder?, extension?, limit? })
  → [ { path, size, modified, extension } ]
```

- Walks the vault with the **same** ignore rules as `walkVault`
  (`vault.ts:87-126`): skip dotfile-prefixed dirs plus `IGNORED_DIRS`
  (`.obsidian`, `.trash`, `.git`, `node_modules`); unreadable dirs/files skipped
  rather than failing.
- Emits **non-`.md`** files only.
- **Implementation:** refactor `walkVault` to accept a file predicate rather than
  duplicate the traversal. Default predicate keeps the current `.md` filter (so
  `walkVault`'s existing callers are unchanged); `list_files` passes a
  "not `.md`" predicate. One traversal implementation, two callers.
- Does **not** touch the vault index (attachments have no frontmatter/links to
  index).
- `folder` scopes to a subtree (path prefix, relative to vault root).
- `extension` filters, normalized: leading dot optional and case-insensitive, so
  `'png'`, `'.png'`, `'PNG'` all match `x.png`.
- `limit` caps the returned array.
- Output fields: `path` (vault-relative, forward-slash, **literal** — extension
  preserved, unlike the `.md`-stripped note names); `size` (bytes); `modified`
  (ISO mtime); `extension` (lowercased, no dot).

**CLI:** `npm run query -- files [--folder F] [--extension png] [--limit N]`.

### 5. `search_notes` — metadata filters

`search_notes` gains optional filters. When present, the candidate note set is
resolved from the index first, then ripgrep is scoped to those exact paths.

```
search_notes({
  pattern, ...existing,
  folder?,               // path prefix, relative to vault root
  tags?,                 // string[] (leading '#' optional)
  match?,                // 'any' (default) | 'all'  — semantics of `tags`
  where?                 // frontmatter condition object (query_notes syntax)
})
```

- **Candidate resolution** (only when any of `folder`/`tags`/`where` present):
  - `folder` → notes whose path is under the prefix.
  - `tags` → the `find_by_tag` predicate (`tags.ts`), honoring `match`
    (`'any'`/`'all'`, default `'any'`).
  - `where` → the `query_notes` condition engine (`property-match.ts`).
  - Multiple filters combine with AND (a note must satisfy all supplied
    filters). `match` governs only the internal semantics of the `tags` list.
- **Zero-candidate guard:** if filters are present and resolve to an **empty**
  set, return the empty result (`{ results: [], truncated: false,
  files_returned: 0, files_omitted: 0, matches_capped_in: [] }`) **without
  invoking `rg`**. This avoids ripgrep's "no path args → search cwd" footgun.
- **When no filters are present**, behavior is byte-identical to today: `rg` runs
  over the vault root with `--type md`.
- **Passing paths to ripgrep without arg-length blowup:** ripgrep has **no**
  native "read the file list from stdin/a file" option — `-f`/`--file` reads
  *patterns*, not paths, and piping paths to stdin makes `rg` search the path
  text itself, not the files (both verified against `rg 15.2.0` during design).
  Candidate paths must therefore go as trailing argv. To stay under `ARG_MAX` on
  large candidate sets, **chunk the candidate paths into batches** and invoke
  `rg` once per batch (each batch: `rg <flags> -- <pattern> <path...>`), then
  merge the per-batch results before applying the `limit`/`max_matches_per_file`
  caps globally. A conservative batch size (e.g. a few thousand paths, or a
  running argv-byte budget well under `ARG_MAX`) is the implementation detail;
  the **requirement** is: no arg-length blowup, results merged across batches,
  and caps applied to the merged set (not per batch). The same
  `--json`/context/word/multiline flag set as today still applies. When
  filtering, `--type md` is redundant (candidates are already `.md`) but harmless.
- All existing caps (`limit`, `max_matches_per_file`, `context_lines`) and DoS/
  flag-injection protections are unchanged and applied after the filter.

**CLI:** extend `search` with `--folder`, `--tag` (repeatable), `--match`,
`--where '<json>'`.

## Architecture notes

Three buckets:

- **Index-derived reads** (`list_vault_issues`, search candidate resolution):
  lean on existing `vault-index.ts` methods (`resolve`, `backlinks`, `outbound`,
  `getEntries`) and the existing `find_by_tag` / `query_notes` predicates. No new
  index state.
- **Walker extension** (`list_files`): parameterize `walkVault` with a predicate;
  no index involvement.
- **Existing-tool changes** (`read_notes`, `delete_note`, `search_notes`):
  localized behavior changes with documented response-shape notes.

No new dependencies. No resolver change. Writes remain gated by
`OBSIDIAN_ALLOW_WRITES` (only `delete_note` is a write tool; the two new tools
and the `read_notes`/`search_notes` changes are all on the read surface).

## Tool gating

- `list_vault_issues`, `list_files` — **read** tools, always exposed.
- `read_notes`, `search_notes` changes — **read** tools.
- `delete_note` — already a **write** tool; its new `dangled_backlinks` field
  ships within the existing write gate. No change to `WRITE_TOOL_NAMES`.

## Testing

Node's built-in `node:test` via tsx, following existing suite patterns. Per
feature:

- **`list_vault_issues`**: fixture vault with a known orphan and known unresolved
  links; assert `orphans` list matches the `get_vault_stats` orphan count, and
  that `sum(targets.length)` equals the stats `unresolved_links` count; `limit`
  caps; unknown `kind` errors.
- **`delete_note`**: note with N backlinks → `dangled_backlinks` lists exactly
  those N source paths; note with no backlinks → empty array; trash vs permanent
  both report.
- **`read_notes`**: mix of valid + missing paths → valid ones in `notes`, missing
  in `errors`, no throw; path-traversal attempt still throws; all-valid batch →
  empty `errors`.
- **`list_files`**: fixture with `.md` + `.png` + `.pdf` under nested and ignored
  dirs; asserts only non-md returned, ignored dirs skipped, `folder`/`extension`
  (dot-optional, case-insensitive)/`limit` filters, literal path with extension.
- **`search_notes` filters**: `folder`/`tags`(any+all)/`where` each scope results;
  combined filters AND; **zero-candidate filter returns empty without touching
  the filesystem** (assert no whole-vault fallthrough); no-filter path unchanged;
  large candidate set does not overflow argv (chunked into batches, results
  merged, caps applied globally).

## Documentation

Update **both** `CLAUDE.md` and `README.md`: the two new tools, the
`read_notes`/`search_notes`/`delete_note` behavior changes, and the CLI examples.

## Delivery

Implemented on a dedicated branch in an isolated git worktree.
