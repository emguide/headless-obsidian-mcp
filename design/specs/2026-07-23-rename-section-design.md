# rename_section + broken-anchor detection — design

## Problem

Renaming a heading silently breaks the link graph. `move_note` rewrites `[[note]]`
wikilinks so renaming a *note* is safe, but there is no equivalent for renaming a
*heading*: an agent that retitles a section via `patch_note` breaks every
`[[note#heading]]` anchor pointing at it, and `list_vault_issues` won't surface
it — unresolved-link detection checks note targets, not anchors.

This is the last structural edit that can corrupt the link graph undetected. Two
complementary pieces close it:

1. **`rename_section`** — a write tool that renames a heading and rewrites every
   inbound `[[…#oldHeading]]` anchor across the vault to the new heading (reusing
   `move_note`'s backlink-rewrite machinery).
2. **`broken_anchors`** — a third `list_vault_issues` kind that surfaces
   `[[note#heading]]` links whose note resolves but whose heading anchor matches
   no heading in the target note (the detection complement).

Both rest on the same foundation: **the index currently discards anchors**
(`linkTargets` is anchor-stripped), so neither feature can see heading anchors
until the index retains them.

## Section 1 — Index foundation (shared enabler)

`extractLinkTargets` in `src/tools/vault.ts` strips both alias and anchor. Add a
parallel extractor that keeps the anchor:

```ts
// src/tools/vault.ts
export interface LinkRef {
  target: string;        // note target, alias + anchor stripped, trimmed (may be "")
  anchor: string | null; // raw heading anchor text after '#', or null
  isBlockRef: boolean;   // true when anchor began with '^' (block ref, not a heading)
}
export function extractLinkRefs(content: string): LinkRef[]
```

- Parse each wikilink with the existing `WIKILINK_RE`. Split off `|alias`, then split
  the left side on the first `#`. `anchor` is the text after `#` (trimmed), `null`
  when there is no `#`. A `#^blockid` sets `isBlockRef: true` and `anchor` = the id
  without the leading `^`.
- `IndexEntry` gains `linkRefs: LinkRef[]` (document order), built in
  `buildEntry` alongside the existing `linkTargets`. `linkTargets` is left exactly
  as-is so every existing consumer (`resolve`, backlink graph, `unresolved_links`)
  is untouched — `linkRefs` is purely additive.

Shared anchor-matching helper (used by both deliverables), colocated with the
wikilink machinery in `vault.ts`:

```ts
// Case-insensitive, trimmed exact match of a heading's text against a link anchor.
// Deliberately NOT Obsidian's full slug normalization (spaces->dashes etc.) —
// literal case-insensitive text, per design decision.
export function headingMatchesAnchor(headingText: string, anchor: string): boolean {
  return headingText.trim().toLowerCase() === anchor.trim().toLowerCase();
}
```

## Section 2 — `rename_section` write tool

Location: `src/tools/write.ts`, in the write-tools list and dispatch.

- **Input:** `path` (required), `from` (required — bare heading or `" > "`
  heading-path), `to` (required — the new bare heading text), `update_anchors`
  (optional, default `true`).
- **Behavior:**
  1. Load the note via `NoteDocument`. A new `renameSection(doc, from, to)` core
     in `note-document.ts` resolves `from` with the existing `resolveSection`
     (identical fail-loud ambiguity: an ambiguous bare heading throws, listing the
     candidate full paths; a missing one throws `not found`). It rewrites **only
     the heading line** — preserving the `#`-level prefix and any trailing `#`s —
     to the new text, leaving the body untouched. It returns the resolved section's
     **old bare heading text** (the leaf of the heading-path) so the caller can
     match inbound anchors.
  2. If `update_anchors`, capture `index.backlinks(canonicalPath)` from the
     pre-write index, then run `move_note`'s exact backlink loop: for each backlink
     note, `rewriteWikilinks` where the link's note target **resolves to this note**
     AND `headingMatchesAnchor(oldHeading, anchor)` → replace the anchor's heading
     text with `to` (preserving `!` embed prefix, `|alias`, and the note target).
     `rewriteWikilinks` already preserves the anchor structure; the map returns the
     same note target but the loop needs an anchor-aware variant. Add an optional
     anchor-mapping parameter to `rewriteWikilinks` (or a sibling
     `rewriteWikilinkAnchors`) so the note-target map and anchor map compose without
     duplicating the parse.
  3. All writes funnel through `commitWrite` / the git guard exactly like every
     other write; path-traversal protected via `resolveNotePath`.
- **Output:** `{ path, from, to, updated_notes, updated_links }` — `from`/`to` are
  the resolved old/new heading, `updated_notes`/`updated_links` mirror
  `move_note`'s counters (notes touched, anchors rewritten). The note's own heading
  rewrite is always applied; the counters cover only inbound anchors.
- **Edge cases:** renaming to the same text is a no-op that still succeeds
  (0 anchors). A note with the target heading but zero inbound anchors succeeds
  with `updated_notes: 0`. Block-ref anchors (`#^id`) are never matched (they are
  not headings).

## Section 3 — `broken_anchors` vault-issue kind

Location: `src/tools/vault-issues.ts` + `ListVaultIssuesParams.kind`.

- Third `kind`: `"broken_anchors"`. For each entry's `linkRefs`, consider only
  refs with a non-null, non-block anchor whose note target **resolves** to a note
  (`index.resolve(target)`), then a **self-anchor** (`target === ""`, i.e.
  `[[#heading]]`) resolves to the source note itself. If none of the resolved
  note's `headings` satisfies `headingMatchesAnchor`, the ref is broken.
- **Output row:** `{ source, targets: [{ target, anchor }] }` grouped by source
  note, mirroring `unresolved_links`. Truncation counts **groups** (source notes).
  New type `BrokenAnchorGroup` in `types.ts`.
- Unresolved *note* targets are deliberately out of scope here — those are already
  `unresolved_links`. `broken_anchors` is specifically "note resolves, heading
  doesn't".

## Section 4 — Surface, tests, docs

- **MCP:** register `rename_section` in `src/index.ts` (tool list + dispatch,
  writes-gated set) and add `broken_anchors` to the `list_vault_issues` `kind` enum
  + its result mapping.
- **Query CLI (`src/query-cli.ts`):** `rename-section <path> <from> <to>
  [--no-update-anchors]`; `vault-issues broken_anchors [--limit N]`.
- **Tests (`node:test` via tsx):**
  - `extractLinkRefs` retains anchors, aliases, block-ref flag, empty target for
    `[[#self]]`.
  - `headingMatchesAnchor` case-insensitive / trimmed; rejects mismatches.
  - `rename_section`: rewrites inbound anchors via full-path ref and basename ref;
    preserves `|alias` and `!embed`; case-insensitive anchor match; leaves
    non-matching anchors and body untouched; ambiguous `from` fails loud; missing
    `from` fails loud; block-ref anchor never rewritten; `update_anchors:false`
    renames only the local heading.
  - `broken_anchors`: finds a `[[note#gone]]`; ignores a valid anchor; ignores an
    unresolved-note link (that's `unresolved_links`); ignores block refs; groups by
    source; truncation counts groups.
- **Docs:** add `rename_section` and the `broken_anchors` kind to both `CLAUDE.md`
  and `README.md`, plus CLI examples.

## Non-goals

- Obsidian full slug normalization (`#My Heading` == `#my-heading`) — literal
  case-insensitive text only.
- Block-ref (`#^id`) validation or rewriting.
- Bare `[[#heading]]` self-links (empty note target) are out of scope for
  rewriting: they are not backlinks so the rewrite loop never sees them. They are
  still surfaced by `broken_anchors` (a self-anchor resolves to the source note).
  A full self-reference `[[thisnote#heading]]` *is* an inbound backlink and is
  rewritten normally.

## Development

Non-trivial: implement in a git worktree per the project's development-workflow
rule. Two natural commit seams: (1) index foundation + helpers, (2)
`rename_section`, (3) `broken_anchors`, (4) surface + docs.
