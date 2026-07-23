# resolve_note — title/alias/basename → path resolution

## Problem

Humans refer to notes by title or alias; every tool in this server addresses
notes by path. Today an agent bridges that gap with `search_notes_ranked`, which
approximates the mapping but returns ranked *guesses*, forcing a search-then-guess
round trip: search, eyeball the top hit, hope it's the note the human meant. A
direct, exact resolver removes that whole class of round trips.

## Solution

A new read tool, `resolve_note`, that maps a human-facing name to a canonical
note path by **exact, case-insensitive** match against a note's identity fields:
frontmatter `title`, frontmatter `aliases[]`, and the file basename. Index-backed
(a single map lookup), never fuzzy — approximate matching remains
`search_notes_ranked`'s job.

### Signature

- **Input**: `query` (required, non-empty string) — the human name to resolve.
- **Output**:
  ```
  {
    query: string,                      // echo of input
    matches: Array<{                    // sorted by path
      path: string,                     // canonical note path (no .md)
      title: string,                    // note's display title
      matched_on: "title" | "alias" | "basename"
    }>,
    resolved: string | null             // the single path iff matches.length === 1, else null
  }
  ```

### Matching rules

- Match is **exact, case-insensitive** equality (no partial/substring/fuzzy).
- Three fields are compared: frontmatter `title`, each `aliases[]` entry,
  and the file basename (path's last segment, `.md` stripped).
- A note that matches on more than one field appears **once** in `matches`.
  Its `matched_on` reports the strongest tier present, in precedence order
  **title > alias > basename**.
- `matches` is sorted by `path` (flat, no precedence-based ordering — precedence
  only decides a single note's `matched_on` label).
- `resolved` is set to the path only when exactly one note matches; otherwise
  `null` (ambiguous or no match). The tool **never guesses** among candidates.
- No match → `matches: []`, `resolved: null`. This is a normal (non-error)
  result, not a thrown error.

### Index changes (`src/tools/vault-index.ts`)

Aliases are not indexed today. Two additions:

1. `IndexEntry` gains `aliases: string[]`. In `buildEntry`, parse frontmatter
   `aliases` — accept a single string or an array of strings; coerce non-strings
   away; trim and drop empties.
2. `rebuildDerived` builds `byName: Map<string, Array<{ path: string; field: "title" | "alias" | "basename" }>>`,
   keyed on the lowercased title / each alias / basename of every entry. A new
   method `resolveName(query): Array<{ path, title, matched_on }>` looks up the
   lowercased trimmed query, collapses per-note duplicates to the strongest
   `matched_on`, and returns candidates sorted by path.

Keying every identity string into one map keeps resolution O(1) on the query and
avoids re-scanning entries per call.

### Tool (`src/tools/resolve.ts`)

`resolveNote(vaultPath, query)`:
- `assertVaultPath`, validate `query` is a non-empty string (throw otherwise).
- Get the shared index, call `resolveName(query.trim())`.
- Build `resolved` = `matches.length === 1 ? matches[0].path : null`.
- Return `{ query, matches, resolved }`.

Read tool — **not** gated by `OBSIDIAN_ALLOW_WRITES`.

### Wiring

- MCP registration in `src/index.ts` (tool name `resolve_note`, alongside the
  other read tools).
- CLI subcommand `resolve <query>` in the query CLI.

## Testing

- Unique title match → `resolved` set, one candidate, `matched_on: "title"`.
- Unique basename match → `matched_on: "basename"`.
- Alias match (aliases as YAML array) → `matched_on: "alias"`.
- Alias as a single YAML string (not array) → still resolves.
- Ambiguity: two notes sharing a title → both listed, `resolved: null`, sorted by path.
- One note matching by both title and basename → appears once, `matched_on: "title"`.
- No match → empty `matches`, `resolved: null` (no throw).
- Case-insensitivity → mixed-case query resolves.
- Empty/whitespace query → throws.

## Non-goals

- Fuzzy / partial / substring matching (use `search_notes_ranked`).
- Resolving `#heading` or `^block` anchors (out of scope; this resolves notes).
- Full-path matching as an input form (basename + title + alias only, per design).
