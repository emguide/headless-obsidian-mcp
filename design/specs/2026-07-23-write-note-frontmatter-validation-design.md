# write_note frontmatter validation — design

**Date:** 2026-07-23
**Status:** approved, ready for implementation plan

## Problem

`write_note`, `append_note`, and `prepend_note` are a frontmatter-validation
bypass. Every dedicated frontmatter tool (`set_frontmatter`, `add_tag`,
`add_property_values`, …) routes writes through `validateFrontmatterValue`
(`src/tools/note-document.ts`), which rejects three classes of invalid
frontmatter:

1. nested objects (maps) as values,
2. arrays containing non-scalar elements,
3. markdown markup inside string values.

But the content-writing tools pass their raw `content` straight to
`commitWrite` with no parsing:

- `writeNote` — `src/tools/write.ts:128-142`
- `appendNote` — `src/tools/write.ts:151-168`
- `prependNote` — `src/tools/write.ts:182-200`

So an agent hand-writing YAML frontmatter in `write_note` (the most obvious way
to create a note) skips every rule. Malformed YAML and schema-violating
frontmatter land in the vault unchecked. This is the sharpest contradiction of
the project's "agents shouldn't have to worry about integrity" guarantee.

## Goals

- Close the bypass: hand-written frontmatter is validated on the same rules as
  every other write path.
- Give agents a way to never hand-write YAML at all: an optional structured
  `frontmatter` object parameter on `write_note`, serialized canonically.
- Fail loud, never silently mangle: malformed YAML and rule violations produce
  clear errors; the write does not proceed.

## Non-goals

- No change to the frontmatter rules themselves (`validateFrontmatterValue` is
  the single source of truth and is reused as-is).
- No structured-frontmatter param on `append_note`/`prepend_note` — those are
  body operations where a frontmatter object has no natural meaning.
- No re-validation of pre-existing frontmatter on an existing note that a write
  does not touch (consistent with the "validate only the keys you write"
  principle already used by `setFrontmatter`).

## Design

### Layer 1 — validate hand-written frontmatter

A shared helper validates any leading frontmatter block in a content string
before it is written:

```
function validateContentFrontmatter(content: string): void
```

- Uses `NoteDocument.parse(content)` to detect and parse a leading frontmatter
  block. `parse` already delimits the block with its `FENCE` regex and hands the
  parsed object back as `doc.data`.
- If there is no leading block (`doc.data` empty and no fence matched), it is a
  no-op — plain-body content is untouched.
- For each key in `doc.data`, call `validateFrontmatterValue(key, value)`. Any
  violation throws the same descriptive error the dedicated tools produce.
- Malformed YAML: `gray-matter` throws inside `NoteDocument.parse`. The helper
  lets that surface, wrapped in a clean `Invalid frontmatter in content: <msg>`
  error so the failure is attributable rather than a raw YAML stack.

**Where it is called — only when the content becomes (part of) a note's
frontmatter, i.e. the file-creating paths:**

- `writeNote`: always (content is the whole file — new or overwrite).
- `appendNote`: only on the **create** branch (`!existed && create`), where
  `content` becomes the entire new file. When appending to an existing note, a
  leading `---` is body text, not frontmatter — left untouched.
- `prependNote`: only on the **create** branch, same reasoning. When prepending
  to an existing note, `prependNote` already inserts the text *after* any
  frontmatter block via `NoteDocument`, so the inserted text is never
  frontmatter and must not be validated as such.

Validation runs **before** `commitWrite` (and therefore before the git
snapshot), so a rejected write takes no snapshot and makes no filesystem change.

### Layer 2 — optional structured `frontmatter` param on `write_note`

Extend `WriteNoteParams`:

```
interface WriteNoteParams {
  path: string;
  content: string;
  overwrite?: boolean;
  frontmatter?: Record<string, unknown>;   // new
}
```

Behavior:

- When `frontmatter` is provided, each entry is validated with
  `validateFrontmatterValue`, then the note is serialized as
  `matter.stringify(content, frontmatter)` — canonical block-style YAML, the
  same serialization the frontmatter tools produce. `content` is then treated as
  the **body only**.
- When `frontmatter` is omitted, behavior is unchanged except for the Layer-1
  validation of any leading block in `content`.

**Conflict rule (ambiguous intent):** if `frontmatter` is provided **and**
`content` also begins with a frontmatter block, throw:
`Provide frontmatter either as the \`frontmatter\` parameter or inline in content, not both.`
This never guesses which wins.

`frontmatter: {}` (empty object) is treated as "no frontmatter param" for the
conflict check but still serializes to a note with no YAML block — i.e. an empty
object produces body-only output and does not conflict with an inline block.
(Rationale: an empty object carries no fields to lose, so there is nothing
ambiguous.)

### MCP schema (`src/index.ts`)

- `write_note` inputSchema gains
  `frontmatter: { type: "object", description: "Optional frontmatter fields, validated and serialized canonically. When given, content is the body only. Do not also put a frontmatter block in content." }`.
- `write_note` `content` description updated: "Full note content. May include a
  leading frontmatter block (validated), or pass frontmatter via the
  frontmatter parameter and give body-only content here."
- `append_note` / `prepend_note` descriptions note that a leading frontmatter
  block is validated when the call creates the note.

### Query CLI (`src/query-cli.ts`)

The CLI calls `writeNote`/`appendNote`/`prependNote` directly, so Layer-1
validation applies automatically. No new CLI flag for the structured param is
required for this change (the CLI's `write` already accepts inline content); the
param is primarily an agent-facing ergonomic. Leave the CLI surface unchanged.

## Error handling

| Case | Result |
|------|--------|
| Malformed YAML in a leading block | `Invalid frontmatter in content: <yaml error>`, no write |
| Rule violation in a leading block (nested map, non-scalar array, markdown) | the existing `validateFrontmatterValue` error, no write |
| Rule violation in `frontmatter` param | same error, no write |
| `frontmatter` param + inline block both present | ambiguity error, no write |
| Valid frontmatter (either form) | writes canonically |

All errors are thrown before `commitWrite`, so no git snapshot and no partial
write occurs.

## Testing

New tests in `tests/write.test.ts` (or a focused `tests/write-frontmatter.test.ts`):

1. `write_note` with a valid inline frontmatter block → succeeds, file has the block.
2. `write_note` with a nested-map inline block → rejects (`/nested object/i`), no file written.
3. `write_note` with markdown-in-string inline block → rejects (`/markdown/i`).
4. `write_note` with malformed YAML inline block → rejects (`/invalid frontmatter/i`).
5. `write_note` with `frontmatter` param (valid) + body content → succeeds, canonical YAML + body.
6. `write_note` with `frontmatter` param containing a violation → rejects.
7. `write_note` with both `frontmatter` param and inline block → ambiguity error.
8. `write_note` with `frontmatter: {}` and body-only content → body-only file, no error.
9. `append_note` create-path with a violating leading block → rejects.
10. `append_note` to an **existing** note whose appended content starts with `---` → succeeds (treated as body, not validated).
11. `prepend_note` create-path with a violating leading block → rejects.
12. `prepend_note` to an **existing** note with `---`-leading content → succeeds (inserted after frontmatter, not validated).
13. Rejected writes take no git snapshot / leave no file (assert absence).

## Documentation

Update both `CLAUDE.md` and `README.md` per the repo's documentation rule:

- `write_note`: document the new `frontmatter` param, that inline frontmatter is
  now validated, and the both-forms ambiguity error.
- `append_note` / `prepend_note`: note that a leading frontmatter block is
  validated on the create path.
- The "Validation" paragraph under Writing tools: note that content-writing
  tools now validate hand-written frontmatter too, closing the previous bypass.

## Files touched

- `src/tools/write.ts` — helper + call sites + `WriteNoteParams`.
- `src/index.ts` — MCP schema/descriptions for the three tools.
- `tests/write.test.ts` (or new file) — the cases above.
- `CLAUDE.md`, `README.md` — docs.
