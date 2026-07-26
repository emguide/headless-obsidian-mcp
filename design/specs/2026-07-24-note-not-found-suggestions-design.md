# Did-you-mean suggestions on "Note not found" errors

**Date:** 2026-07-24
**Status:** Approved (user-specified design; session ran autonomously, open calls documented below)

## Problem

Every missing-note error is bare (`Note not found: X`). The most common agent
failure is a near-miss path — wrong case, missing folder prefix, title instead
of basename — and recovery costs a full `resolve_note` or search round trip
every time. The index already holds everything needed to suggest the fix
inline.

## Design (as specified by the user)

Reuse `resolve_note`'s exact matching — case-insensitive equality against
frontmatter `title`, `aliases[]`, and file basename, via
`VaultIndex.resolveName` — in one shared error builder, and append up to 3
candidates to the error message:

```
Note not found: projects/alfa. Did you mean: projects/alpha?
```

- **No new fuzzy semantics.** Exact matching only. A pure spelling typo with no
  matching title/alias/basename gets no suggestion (the named near-miss
  classes — case, folder prefix, title-vs-basename — are all exact matches).
- **Errors stay errors.** Same `Error` type, message-only enrichment; the tool
  never resolves to a candidate silently. Fail-loud philosophy intact.
- **No candidates → message unchanged** (`Note not found: X`).

## Approach

Chosen: a small shared module `src/tools/not-found.ts` (precedent:
`link-health.ts`), with three layers:

1. `didYouMean(index, notePath): string[]` — pure candidate lookup, unit-testable.
   - Canonicalize the input (forward slashes, strip `.md`).
   - `index.resolveName(canonical)` — catches a title/alias/basename given
     verbatim as the "path".
   - When the input has a folder prefix, also `index.resolveName(lastSegment)`
     — catches wrong-case paths and wrong/missing folder prefixes.
   - Dedupe (full-input matches first, then basename matches; each already
     path-sorted by `resolveName`), drop a candidate identical to the input,
     cap at 3.
2. `noteNotFoundMessage(index, notePath, base = "Note not found")` — builds the
   full message; sites that already hold an index call this synchronously.
   `base` preserves each site's existing prefix ("Note not found or not
   readable").
3. `noteNotFoundError(vaultPath, notePath, base?)` (async) — fetches the index
   for sites that don't hold one (write.ts). **Never throws**: if the index
   can't be built, it degrades to the bare message. An error-path index fetch
   is an acceptable cost (cheap when warm; error-only).

Rejected: a method on `VaultIndex` plus inline formatting at each site (spreads
the format across 12 sites); a structured `NoteNotFoundError` class carrying
candidates (MCP surfaces only the message string — no consumer, YAGNI).

## Enriched sites (12)

- `write.ts`: `readRaw` (covers patch_note, set_task_state, and every
  `editNote` consumer: tags, frontmatter, properties, sections,
  rename_section), `appendNote` (!create), `prependNote` (!create),
  `deleteNote`, `moveNote` (`from`).
- Read side: `frontmatter.ts` (get_frontmatter), `properties.ts`
  (get_property), `outline.ts`, `links.ts`, `section.ts` (read_section),
  `related.ts`.
- `read.ts` (read_notes): per-path `errors[]` entries, enriched only on ENOENT
  (a too-large or unreadable file gets no suggestions); the index is fetched
  lazily once per batch.

`insert_template` and `bulk_edit` inherit enrichment by delegation
(`appendNote`/`editNote`). Out of scope: `move_file`'s "File not found"
(attachments aren't indexed) and non-path errors (ambiguous heading, missing
task — different failure class, already self-describing).

Error messages now always echo the canonical name (slashes normalized, `.md`
stripped); four sites previously echoed the raw input. Existing tests assert
`/not found/` loosely, so this is safe.

## Testing

- `tests/not-found.test.ts`: title match, alias match, basename with
  missing/wrong folder prefix, wrong case, no candidates → bare message, cap
  at 3, self-exclusion, ordering, custom base prefix.
- Integration: one write-path site (delete/patch), one index-backed read site
  (get_frontmatter or get_property), `read_notes` errors array.

## Docs

CLAUDE.md + README gain a short shared-convention paragraph; the server
`instructions` in `src/index.ts` gain one sentence so agents know suggestions
are exact-match (not fuzzy) and advisory.
