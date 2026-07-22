# Read-side structure tools: `get_outline` + `read_section`

**Date:** 2026-07-22
**Status:** Approved — ready for implementation planning

## Problem

The write side of this MCP server understands note structure; the read side does
not. There is no way to get a note's outline (note headers carry only the *first*
heading via `headline`), and no way to read a single section. So the common flow
— "check what sections exist, then append to the right one" — forces reading the
whole note, which is exactly the token cost the section write tools
(`append_to_section`, `replace_section`, `add_section`) exist to avoid.

Section addressing by bare heading text is also ambiguous when a heading repeats
under different parents (two `Log` subheadings under different sections).

This design adds two additive read tools — `get_outline` and `read_section` —
that close the loop, reusing the section-parsing logic the write side already
has.

## Goals

- An agent can retrieve a note's heading structure without reading its body.
- An agent can read one section's text without reading the whole note.
- Both flows are first-class: the editing loop (outline → locate → write) and
  cheap section-level reading of large notes.
- Section addressing is unambiguous even when heading text repeats.
- `get_outline` and the write tools agree exactly on what a note's sections are.

## Non-goals (YAGNI)

- No line-range or char-offset reading — section addressing only.
- No changes to write behavior. The shared-parser lift is refactor-only and must
  be byte-for-byte equivalent for existing writes.
- No gating: these are read tools, always exposed regardless of
  `OBSIDIAN_ALLOW_WRITES`.

## Shared foundation: one fence-aware heading parser

Today two heading parsers coexist and can disagree:

- The index (`src/tools/vault.ts` → `allHeadings`) matches heading lines with a
  plain regex — it does **not** skip fenced code blocks, so a `#` line inside a
  ```` ``` ```` block is wrongly counted as a heading.
- The write side (`src/tools/note-document.ts` → `findHeadings`) is fence-aware
  and carries heading levels.

**Action:** lift the write side's fence-aware `findHeadings` into `vault.ts`
(alongside the existing `firstHeading`/`allHeadings` helpers, which it replaces)
so the index, the write tools, and the new read tools all import one parser.
`note-document.ts` and `vault-index.ts` both call it. This removes the latent
disagreement by construction. `allHeadings` is removed; any remaining caller
uses the new structured parser (mapping to `.text` where only text is needed).

`IndexEntry` (`src/tools/vault-index.ts`) gains a structured field:

```ts
headings: { text: string; level: number }[]
```

computed once per note on refresh via the shared parser. The existing
`headline` (first heading) and the BM25 heading-boost tokens derive from this
same parse rather than from a separate regex. The first index refresh after this
change re-reads notes to populate the field; this is one-time and self-healing
(the index already re-reads on parse-shape changes / mtime changes).

## Tool: `get_outline`

Index-backed, pure lookup — **no file read** at call time.

- **Input:**
  - `path` (required) — relative note path, with or without `.md`.
- **Output:** `{ path, outline }` where `outline` is a flat array; each entry:
  - `heading` (string) — the heading text.
  - `level` (number) — 1–6.
  - `path` (string) — the full `>`-joined heading-path, e.g. `Projects > Log`,
    derived by walking the level stack. This is the disambiguating address the
    agent copies verbatim into `read_section` and the section write tools.
  - `line` (number) — 1-based line number of the heading within the note body.
  - `ambiguous` (boolean) — `true` when the bare `heading` text is non-unique
    within this note, signalling that the `path` form is required to address it.
- Nesting is implied by `level`; the array is in document order.
- **Security:** path-traversal protected via the same guard as `read_notes`.
- **Empty note / no headings:** returns `{ path, outline: [] }`.

### Heading-path derivation

Maintain a stack of the current ancestor heading at each level as the flat list
is walked in document order. For a heading at level L, pop the stack to
depth < L, then the path is the ancestors' texts plus this heading's text joined
by ` > `. Headings that skip levels (e.g. an `h4` directly under an `h2`) attach
to the nearest shallower ancestor present on the stack.

### Ambiguity

A heading is `ambiguous` when another heading in the same note has identical
bare `text`. Its full `path` is always unique within a well-formed note; when
even the full path collides (identical heading text under an identical ancestor
chain), the collision is still surfaced via `ambiguous: true` and `read_section`
resolves such a case by erroring (see below).

## Tool: `read_section`

Reads the note file at call time — the index deliberately does not retain body
text, so this tool always reads on demand (path-guarded, same guard and 10MB
size limit as `read_notes`) and parses with the shared fence-aware parser.

- **Input:**
  - `path` (required) — relative note path, with or without `.md`.
  - `section` (required) — a bare heading (`Log`) or a `>`-path
    (`Projects > Log`).
  - `include_subsections` (optional, default `false`).
- **Addressing (bare + path fallback):**
  - Bare heading → resolves when it is unique in the note.
  - Ambiguous bare heading → **errors loudly**, listing the candidate full paths
    (e.g. `Projects > Log`, `Personal > Log`) so the agent retries with the
    exact one. Mirrors `patch_note`'s fail-loud-on-stale-match behavior.
  - `>`-path → resolves the exact section. If even the full path is non-unique
    (identical heading text under an identical ancestor chain), this also errors
    loudly rather than silently picking the first match — there is no positional
    fallback by design.
  - Section not found → errors.
- **Section boundary:** heading line + body down to the next heading of
  **same-or-higher level** — the section's *own* body, **excluding** nested
  subsections. This is exactly how `locateSection` bounds a section on the write
  side, keeping read and write symmetric. With `include_subsections: true`, the
  returned slice extends to the next same-or-higher heading, i.e. the full
  subtree including all descendants.
- **Output:** `{ path, section, level, content }`:
  - `section` — the resolved full heading-path (so the caller learns the
    canonical address even when it passed a bare heading).
  - `level` — the resolved heading's level.
  - `content` — the verbatim heading line + body slice. Frontmatter is never
    included.
- **Security:** path-traversal protected via the same guard as `read_notes`.

## CLI

Add two subcommands to the query CLI (`src/query.ts` or equivalent), consistent
with the existing subcommand style:

```bash
npm run query -- outline "projects/alpha"
npm run query -- read-section "projects/alpha" "Log"
npm run query -- read-section "projects/alpha" "Projects > Log" --include-subsections
```

## Documentation

Per the project's documentation rule, update **both** `CLAUDE.md` and
`README.md`:

- Add `get_outline` and `read_section` to the read-tools section.
- Add the two CLI subcommands to the Testing section.
- Add `get_outline` to the list of index-backed knowledge-base tools in the
  "Vault index" section, and note that `IndexEntry` now stores structured
  headings.

## Testing

Shared parser:
- Skips ATX headings inside fenced code blocks (both ``` ``` ``` and `~~~`).
- Correct level extraction.
- Heading-path derivation, including level skips.

`get_outline`:
- Nested structure produces correct `level` and `path`.
- Repeated bare headings are flagged `ambiguous: true`, with distinct `path`s.
- Headings inside code fences are excluded.
- Note with no headings → empty outline.
- Path traversal rejected.

`read_section`:
- Bare unique heading → correct heading + body, subsections excluded.
- Ambiguous bare heading → error listing candidate full paths.
- `>`-path → resolves the exact section.
- Missing section → error.
- `include_subsections: true` → includes descendants; boundary correct.
- Frontmatter never included in `content`.
- Path traversal rejected.

Index / refactor:
- `IndexEntry.headings` is populated and fence-aware.
- `headline` (first heading) still correct after deriving from the shared parser.
- Existing write-tool tests still pass (byte-for-byte equivalent).

## Affected files

- `src/tools/vault.ts` — home of the lifted shared fence-aware heading parser
  (replaces `firstHeading`/`allHeadings`).
- `src/tools/note-document.ts` — `findHeadings` re-expressed in terms of the
  shared parser (write behavior unchanged).
- `src/tools/vault-index.ts` — `IndexEntry.headings`; derive `headline` and BM25
  boost from it.
- New tool handlers for `get_outline` and `read_section` (following the existing
  per-tool file convention under `src/tools/`).
- Tool registration / `list_tools`.
- Query CLI.
- `CLAUDE.md`, `README.md`.
- Tests.
