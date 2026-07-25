# Link context (`include_context`) — design

**Date:** 2026-07-24
**Status:** approved (autonomous session; design decisions recorded here)

## Problem

Backlinks are bare paths from the index (`links.ts`), so "who references this
note, and why" takes a second step — and the workable approximation
(`search_notes` on the basename) cannot distinguish resolved links from text
mentions or from same-basename links to a different note. Hand-rolling link
regexes through `search_notes` is exactly the antipattern the structured
surfaces (`list_tasks`) were built to kill. The same gap makes `delete_note`'s
`dangled_backlinks` and `list_vault_issues`' broken-reference kinds
non-actionable: you get the source path but not what the reference says.

## Decision

Add an opt-in `include_context: true` parameter to three tools. When set, each
reported link row gains `context`: the source line(s) containing that link, as
`{ line, text }` pairs — `line` 1-based and **body-relative** (frontmatter
stripped; the same convention as `get_outline`/`list_tasks`), `text` the line
verbatim (verbatim so it can be fed straight into `patch_note.find`).

Context is computed by **call-time file reads** (the index does not retain body
text — same precedent as `read_section`), and is **opt-in** so a 200-backlink
hub note stays cheap by default. Link identification reuses the shared
`extractLinkRefs` parser and index resolution — never a hand-rolled regex — so
a context line is reported iff the index itself counts that line's link.

### Tool surfaces

- **`get_links`** — with `include_context: true`, every row in all three
  arrays is decorated:
  - `outbound_links`: `{ target, path, context }` — lines in the inspected
    note whose link resolves to `path`.
  - `unresolved_links`: rows become `{ target, context }` (bare strings
    without the flag) — lines containing that exact raw target.
  - `backlinks`: rows become `{ path, context }` — lines in each source note
    whose link resolves to the inspected note.
  Without the flag, the result shape is byte-for-byte unchanged.
- **`delete_note`** — with `include_context: true`, `dangled_backlinks` rows
  become `{ path, context }`, computed against the **pre-delete** index (the
  deleted note must still resolve for its backlink lines to be identified).
- **`list_vault_issues`** — with `include_context: true`:
  - kind `unresolved_links`: each group's `targets` rows become
    `{ target, context }`.
  - kind `broken_anchors`: each `{ target, anchor }` row gains `context`
    (matched on target + anchor, block-refs excluded).
  - kind `orphans`: `include_context` errors loudly (orphans have no links to
    contextualize) — consistent with the fail-loud house rule.
  Context is computed only for the **returned window** (after `offset`/`limit`
  slicing), so a bounded call reads a bounded number of files.

### Shared helper

`src/tools/link-context.ts`:

- `scanLinkLines(fullPath)` — read the file, strip frontmatter with
  gray-matter (the index's own stripper, so line numbers agree with
  `get_outline`/`list_tasks`), split into lines, and return the lines that
  contain wikilinks, each with its parsed `LinkRef[]`.
- `linkContext(scanned, match)` — filter those lines by a per-ref predicate
  and return `{ line, text }` rows.

An unreadable source file (deleted between index refresh and the call-time
read) degrades to an empty `context` array rather than failing the call —
context is a report-only decoration, same philosophy as link-health.

**Known limitation:** scanning is per-line, so a wikilink spanning a newline
(which Obsidian does not render anyway) is counted by the index but yields no
context line.

### Non-goals

- No context for `search`-style tools (they already return matched lines).
- No cap on context rows per source; the flag is opt-in and windows bound the
  file count.
- No index change: link line numbers are not stored; reads are call-time.

## Testing

New `tests/link-context.test.ts`: default shapes unchanged; decorated shapes
for all three tools; body-relative line numbers under a frontmatter block;
alias/anchor links matched; multi-link lines and multi-line sources;
`orphans` + `include_context` fails loud; `delete_note` context captured
pre-delete. CLI flags (`--include-context`) on `links`, `vault-issues`,
`delete`.
