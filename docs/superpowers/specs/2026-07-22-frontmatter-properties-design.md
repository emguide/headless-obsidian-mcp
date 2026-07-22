# Frontmatter property search, CRUD & validation — design

**Date:** 2026-07-22
**Status:** Approved, ready for implementation planning

## Goal

Make a note's frontmatter a first-class, queryable, and safely-editable data
surface. Today frontmatter is parsed and cached in the shared `VaultIndex`, but
the agent-facing tools only expose whole-field reads (`get_frontmatter`),
whole-field set/unset (`set_frontmatter`), tag helpers (`add_tag`/`remove_tag`),
and a single-purpose equality `where` filter buried inside `list_recent_notes`.

This adds:

1. **Search** — discover the property schema, query notes by property condition,
   read one property, and facet the distinct values of a property.
2. **CRUD** — element-level array edits (add/remove individual values) and
   key rename, alongside the existing whole-field `set_frontmatter`.
3. **Validation** — reject writes that would introduce nested objects, arrays of
   non-scalars, or markdown syntax inside string values.

## Motivation

An agent that can query "all notes where `status = active` and `priority > 3`"
or "what values does `project` take across the vault" can navigate a vault by its
structured metadata, not just its prose. Element-level array edits let it curate
list-valued properties (`aliases`, `authors`, `related`) the way `add_tag`
already curates `tags`. Validation keeps properties as clean, machine-readable
data — Obsidian's Properties UI assumes scalar/array values and renders markdown
markup literally, so a nested map or a `[[wikilink]]` inside a property is a
latent corruption.

All of it builds on the existing `VaultIndex` (frontmatter already parsed and
cached) and the existing `commitWrite` funnel (path guard + git snapshot) and
`NoteDocument` structure-aware core (touches only the YAML block, body preserved
byte-for-byte).

## Decisions (from brainstorming)

| Decision | Choice |
|----------|--------|
| Tool shape | **Focused single-purpose tools**, mirroring `list_tags`/`add_tag`. 4 read + 3 write. |
| Read tools | `list_properties`, `get_property_values`, `query_notes`, `get_property`. |
| Write tools | `add_property_values`, `remove_property_values`, `rename_property`. |
| Rename scope | **Single note only** (path + from + to), consistent with all other write tools. |
| `query_notes` operators | **Full set**: `eq, ne, gt, gte, lt, lte, exists, contains`; bare scalar = equality/array-membership. Type-aware (number, ISO date, string). No regex. |
| Array add on scalar key | **Promote to array** (`alias: foo` + `bar` → `alias: [foo, bar]`), mirroring `add_tag`. |
| Validation surface | **Enforce on write only.** No separate lint/scan tool. |
| Validation scope | **Only the keys the write adds or modifies** — a pre-existing violation on an untouched key never blocks an unrelated edit. |
| Rules enforced | Reject (1) objects/maps at any level, (2) arrays containing non-scalars, (3) markdown syntax in string values / string array elements. |
| Bare URLs | **Allowed** — only real markdown markup is rejected, not plain text that happens to contain a URL. |
| Null values | **Allowed** — `null` is a legitimate frontmatter value. |
| `where` matcher | **Extracted into a shared helper**, used by both `query_notes` and (upgraded) `list_recent_notes`. |

## Architecture

### New module: `src/tools/properties.ts` (read side)

All four read tools read from the shared `VaultIndex` — no extra file I/O.
`get_property`/`get_property_values` inspect cached `entry.frontmatter`;
`list_properties` and `query_notes` iterate `index.getEntries()`.

**`list_properties`** — the vault's frontmatter schema.
- Input: `{ include_tags?: boolean }` (default `true`; set `false` to omit the
  `tags` key already covered by `list_tags`).
- Output: `Array<{ key, count, types }>` — `count` = notes using the key,
  `types` = sorted distinct value types observed across notes
  (`"string" | "number" | "boolean" | "array" | "null" | "date"`). Sorted by
  `count` desc, then `key` asc. Mirrors `list_tags`.

**`get_property_values`** — faceted distinct values for one key.
- Input: `{ key: string, limit?: number }`.
- Output: `{ key, values: Array<{ value, count }> }`. For an array-valued key,
  each element is counted once per note that contains it. Scalars counted once
  per note. Values are keyed by their stringified form for counting. Sorted by
  `count` desc, then stringified value asc. `limit` truncates.

**`query_notes`** — find notes by property condition (generalizes the inline
`where` filter).
- Input: `{ where: Record<string, Condition>, match?: "all" | "any", limit?: number }`.
  `match` defaults to `"all"`.
  - A `Condition` is **either** a bare scalar (string/number/boolean) — meaning
    equality, or array-membership when the note's value is an array — **or** an
    operator object with one or more of:
    `{ eq?, ne?, gt?, gte?, lt?, lte?, exists?: boolean, contains? }`.
  - `exists` tests key presence. `contains` tests array membership (or substring
    for a string value). `gt/gte/lt/lte` are **type-aware**: both operands
    numeric → numeric compare; both parse as ISO dates → chronological; else
    lexical string compare.
- Output: `NoteHeader[]` (same shape as `list_notes`), so results compose with
  every other tool. `limit` truncates the sorted (by path) result.

**`get_property`** — one key's value from one note.
- Input: `{ path: string, key: string }`.
- Output: `{ path, key, value, present }` — `present` distinguishes an absent
  key from a key explicitly set to `null`. Path-traversal guarded like
  `get_frontmatter` (reads through the index entry / resolveNotePath).

### Shared matcher: `src/tools/property-match.ts`

Extract the condition-evaluation logic into `matchesWhere(frontmatter, where, match)`
and a `compareValues`/`evaluateCondition` core. `query_notes` uses it directly.
`list_recent_notes`'s existing `where` option is rewired to call it, upgrading
that filter from equality-only to the full operator set for free. The existing
`recent` behavior (bare scalar = equality, matches array members) is preserved as
the shorthand path, so this is backward-compatible.

### Extended core: `src/tools/note-document.ts` (write side)

New pure functions on `NoteDocument`, following the `addTags`/`removeTags`/
`setFrontmatter` pattern (mutate `doc.data`, call `markFrontmatterDirty()`,
return the result or `null` when nothing changed):

- **`addPropertyValues(doc, key, values): unknown[] | null`** — append values to
  the array at `key` (idempotent, no dupes). Creates the array if the key is
  absent; if the key holds a scalar, promotes it to `[oldValue, ...new]`. Each
  added value is validated (see below). Returns the resulting array.
- **`removePropertyValues(doc, key, values): unknown[] | null`** — remove values
  from the array at `key`. An emptied array drops the key (matching
  `removeTags`). Returns the resulting array, or `null` if nothing matched.
- **`renameProperty(doc, from, to): boolean`** — rename key `from` → `to`,
  preserving the value and (best-effort) key order. Throws if `from` is absent or
  `to` already exists. No value re-validation (value is unchanged).

### Validation: `validateFrontmatterValue(key, value)` in `note-document.ts`

A pure guard invoked by every frontmatter-mutating helper on **the value(s) it
writes**. Throws an `Error` naming the key and reason; the throw propagates out
before `commitWrite`, so no file or git snapshot is touched on a rejected write.

Rules:
1. **No nested objects** — a value that is a non-array object (map) is rejected,
   at the top level or nested inside an array.
2. **No arrays of non-scalars** — array elements must be scalars
   (string/number/boolean/null); an element that is itself an array or object is
   rejected.
3. **No markdown in strings** — a string value or string array element matching
   any markdown-markup pattern is rejected: `[[wikilink]]`, `![[embed]]`,
   `[text](url)`, `**bold**`/`__bold__`, `` `code` ``, a leading `#` ATX heading,
   or a leading `- `/`* `/`+ ` list bullet. **Bare URLs and plain text are
   allowed** — only genuine markup is rejected.

Allowed: scalars, `null`, and flat arrays of scalars.

Wired into the helpers that introduce/modify values:
`addTags` (already normalizes; add the guard), `setFrontmatter` (validate each
`set` value), `addPropertyValues` (validate each added value). `removePropertyValues`,
`renameProperty`, and `remove_tag` write no new values, so they need no value
validation. This realizes "validate only what this write changes."

### Thin wrappers: `src/tools/write.ts`

Add `addNotePropertyValues`, `removeNotePropertyValues`, `renameNoteProperty`
following the existing `addTag`/`setNoteFrontmatter` shape: parse the note into a
`NoteDocument`, call the core function, and if it reports a change,
`commitWrite` the serialized result. Register the three new tool names in
`WRITE_TOOL_NAMES` so they are gated behind `OBSIDIAN_ALLOW_WRITES`.

### MCP registration: `src/index.ts`

Register the 4 read tools unconditionally. The 3 write tools are exposed only
when writes are enabled (via `WRITE_TOOL_NAMES`), like every other writer.

### Query CLI: `src/query-cli.ts`

New subcommands (the CLI is the operator's tool — not gated by
`OBSIDIAN_ALLOW_WRITES`):

```
properties [--no-tags]
property-values <key> [--limit N]
query --where '<json>' [--match all|any] [--limit N]
get-property <path> <key>
add-property-values <path> <key> <value...>
remove-property-values <path> <key> <value...>
rename-property <path> <from> <to>
```

`query --where` accepts a JSON object; values beginning with `-` handled via the
existing stdin/`--file` convention already used for section content.

### Types: `src/types.ts`

Param + result interfaces for each new tool
(`ListPropertiesParams`, `PropertyValuesParams`, `QueryNotesParams`,
`GetPropertyParams`, `PropertyValuesEditParams`, `RenamePropertyParams`, and the
`Condition` type), plus the `where` type shared with `recent`.

## Error handling

- Read tools: invalid input (missing `key`/`path`, non-object `where`, bad
  `limit`) throws a descriptive `Error`, matching existing tool validation.
- `get_property`/edit tools: note-not-found and path traversal handled by the
  same guards as `get_frontmatter`/`read_notes`.
- Write validation failures throw before `commitWrite` — nothing is written and,
  when the git guard is on, no snapshot is taken.
- `rename_property` errors loudly on absent `from` or colliding `to` (no silent
  clobber), matching the fail-loud stance of `patch_note`.

## Testing

`node:test` via tsx, mirroring existing test style (temp-vault fixtures).

- **Validation core** — a case per rejection rule (nested map top-level and
  inside array, array-of-array, array-of-object, each markdown pattern) and per
  allowed case (scalar, null, flat scalar array, bare URL, plain string).
- **Array edits** — add (new key, existing array, dedupe, scalar→array promote),
  remove (partial, emptied → key dropped, no-match → null).
- **Rename** — success, absent `from` throws, colliding `to` throws, value +
  order preserved.
- **Shared matcher** — each operator, type-aware number/date/string comparison,
  `match: all` vs `any`, bare-scalar shorthand, array-membership.
- **Read tools** — `list_properties` types/counts, `get_property_values`
  faceting incl. array element counting, `query_notes` end-to-end,
  `get_property` present-vs-null.
- **Backward-compat** — `list_recent_notes`'s existing `where` still behaves
  after rewiring to the shared matcher.
- **Validate-only-changed edge case** — editing a note that has a legacy
  violation on an untouched key succeeds; touching the violating key fails.

## Documentation

Per the repo's dual-doc rule, update **both** `CLAUDE.md` and `README.md`:
new entries for the 4 read tools (read section) and 3 write tools (Writing tools
section), the validation rules, and the new CLI examples.

## Out of scope (YAGNI)

- Vault-wide rename (single-note only per decision).
- A separate lint/scan or auto-fix tool (enforce-on-write only).
- Regex/glob property matching.
- Retroactive whole-note validation on write.
