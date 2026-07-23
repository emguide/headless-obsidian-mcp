# Headless Obsidian MCP

A headless MCP (Model Context Protocol) server for interacting with Obsidian vaults. It gives AI assistants Obsidian's power — full-text search, the link graph, tags, and structure-aware editing — without the GUI, making your knowledge base a first-class agent tool.

## Features

- **Search Notes**: Full-text search through your Obsidian vault using ripgrep
- **Ranked Search**: BM25-ranked full-text search — most relevant notes first, with a matched snippet
- **Read Notes**: Parse and extract content, metadata, and tags from notes
- **List Notes**: Discover the vault as lightweight headers — a table of contents for agents
- **List Files**: Discover non-markdown files (attachments, images, PDFs), filterable by folder and extension
- **Link Graph**: Resolve `[[wikilinks]]` and backlinks to traverse related notes
- **Tag Index**: Aggregate all tags with counts and retrieve notes by tag
- **Related Notes**: Associative recall — rank the notes most related to a given one (shared tags + link graph), no embeddings required
- **Recency & Metadata**: Surface the most recent notes, filtered by frontmatter; read a note's frontmatter alone or get whole-vault stats
- **Vault Hygiene**: Drill down from whole-vault stats into the actual orphaned notes and broken wikilinks
- **Property Search**: Discover the vault's frontmatter schema, list a property's distinct values, and query notes by frontmatter condition (`eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `exists`, `contains`)
- **Write & Edit** (opt-in): Create, overwrite, append, prepend, and delete notes — disabled by default, enabled with `OBSIDIAN_ALLOW_WRITES`
- **Structure-aware edits**: Add/remove tags, set frontmatter, add/remove/rename frontmatter properties, add/append/replace sections, and literal find/replace patches without rewriting the whole note — saving agent tokens
- **Frontmatter validation**: Writes reject nested objects, arrays of non-scalars, and markdown syntax in string values, keeping properties queryable and flat
- **Move & rename**: Move notes (rewriting the wikilinks that point to them) or arbitrary attachment files
- **Trash-safe delete**: Deletes move to the vault's `.trash` by default, so they're recoverable
- **Git safety net**: Optionally snapshot the vault into a commit before every write (`OBSIDIAN_GIT_AUTOCOMMIT`)
- **Cross-platform**: Works on Windows, macOS, and Linux
- **Frontmatter Support**: Extracts YAML frontmatter as structured metadata
- **Tag Extraction**: Automatically identifies and extracts Obsidian tags

## Prerequisites

- [Node.js](https://nodejs.org/) 18 or newer
- [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg` command)
- An Obsidian vault with markdown files

## Setup

1. Clone or download this project
2. Install dependencies:
   ```bash
   npm install
   ```
3. Build the TypeScript sources:
   ```bash
   npm run build
   ```
4. Set the `OBSIDIAN_VAULT_PATH` environment variable:
   ```bash
   export OBSIDIAN_VAULT_PATH="/path/to/your/obsidian/vault"
   ```
5. Run the server:
   ```bash
   # Using npm
   npm start

   # Using mise (if you have mise installed)
   mise run start
   ```

## Development

For development with file watching (uses [tsx](https://github.com/privatenumber/tsx), no build step required):

```bash
# Using npm
npm run dev

# Using mise
mise run dev
```

## Tests

Run the automated test suite (Node's built-in `node:test` runner via tsx — no
extra dependencies):

```bash
npm test
```

The tests build a throwaway fixture vault in a temp directory and cover link
resolution and backlinks, tag aggregation and filtering, listing and recency,
index cache invalidation, and the security guards (path traversal, pattern
limits).

## Manual testing

You can also exercise the MCP server using the included query CLI tool. It runs directly from
the TypeScript sources via `tsx`, so no build step is required:

```bash
# Search for notes containing a pattern (case-insensitive by default)
npm run query -- search "productivity"

# Case-sensitive search
npm run query -- search "TODO" --case-sensitive

# Search for whole words only
npm run query -- search "test" --whole-word

# Multiline search
npm run query -- search "pattern.*spans.*lines" --multiline

# Search with custom context lines (default: 5)
npm run query -- search "pattern" --context 10

# Search scoped to a folder, tags, or frontmatter condition
npm run query -- search "kubernetes" --tag work --match all
npm run query -- search "alpha" --where '{"status":"active"}'

# BM25-ranked full-text search (most relevant notes first)
npm run query -- search-ranked "kubernetes networking"
npm run query -- search-ranked "kubernetes networking" --limit 5

# BM25-ranked search scoped to a folder, tags, or frontmatter condition
npm run query -- search-ranked "kubernetes" --folder work --tag active --match all
npm run query -- search-ranked "kubernetes" --where '{"status":"active"}'

# Read specific notes (returns { notes, errors } — one bad path won't fail the batch)
npm run query -- read "daily-notes/2024-01-15"
npm run query -- read "note1" "folder/note2"

# List notes as lightweight headers (optionally scoped/limited)
npm run query -- list
npm run query -- list --folder projects --limit 20

# Show outbound links, unresolved links, and backlinks for a note
npm run query -- links "projects/alpha"

# List all tags with note counts
npm run query -- tags

# Find notes by tag (default: any; --all requires every tag)
npm run query -- find-by-tag productivity
npm run query -- find-by-tag productivity project --all

# List the most recent notes (by mtime, or a frontmatter date field)
npm run query -- recent --limit 10
npm run query -- recent --date-field updated --since 2024-01-01

# Find the notes most related to a given one (ranked, with reasons)
npm run query -- related "projects/alpha"
npm run query -- related "projects/alpha" --limit 5

# Read just a note's frontmatter, or summarize the whole vault
npm run query -- frontmatter "projects/alpha"
npm run query -- stats

# Resolve a human name (title/alias/basename) to a note path
npm run query -- resolve "Alpha Project"

# Vault hygiene: orphaned notes, broken wikilinks, and dead heading anchors (drill-down from stats)
npm run query -- vault-issues orphans
npm run query -- vault-issues unresolved_links --limit 50
npm run query -- vault-issues broken_anchors --limit 50

# List non-markdown files (attachments/images), optionally scoped/filtered
npm run query -- files --folder assets --extension png

# Folder tree with note counts, optionally scoped/depth-limited
npm run query -- folders
npm run query -- folders --folder projects --depth 1

# Frontmatter schema, distinct values, and condition queries
npm run query -- properties
npm run query -- property-values status
npm run query -- query --where '{"status":"active","priority":{"gt":3}}'
npm run query -- get-property "projects/alpha" status

# Heading outline, and read a single section (index-backed outline; section reads the file)
npm run query -- outline "projects/alpha"
npm run query -- read-section "projects/alpha" "Log"
npm run query -- read-section "projects/alpha" "Projects > Log" --include-subsections

# --- Writing ---

# Create a note (inline, from a --file, or from stdin)
npm run query -- write "inbox/idea" "# Idea\n\nbody"
npm run query -- write "inbox/idea" --file draft.md --overwrite

# Append or prepend text to a note (prepend inserts after any frontmatter)
npm run query -- append "daily/2026-07-22" "one more thing"
npm run query -- prepend "daily/2026-07-22" "> top banner"

# Tags and frontmatter (no whole-note rewrite)
npm run query -- add-tag "projects/alpha" project active
npm run query -- remove-tag "projects/alpha" stale
npm run query -- set-frontmatter "projects/alpha" --set status=done --unset draft
npm run query -- add-property-values "projects/alpha" aliases a2 a3
npm run query -- remove-property-values "projects/alpha" aliases a3
npm run query -- rename-property "projects/alpha" author authors

# Bulk frontmatter edit across many notes (one git snapshot for the batch)
npm run query -- bulk-edit --select '{"where":{"status":"draft"}}' \
  --operations '[{"op":"add_tag","tags":["review"]},{"op":"set_frontmatter","set":{"status":"active"}}]' --dry-run

# Sections (heading-scoped edits)
npm run query -- add-section "projects/alpha" "Next steps" "- ship it"
npm run query -- append-to-section "projects/alpha" "Log" "did a thing"
npm run query -- replace-section "projects/alpha" "Summary" "new summary"
npm run query -- rename-section "projects/alpha" "Old Heading" "New Heading"
npm run query -- rename-section "projects/alpha" "Old" "New" --no-update-anchors

# Move / rename a note (rewrites wikilinks that point to it)
npm run query -- move "projects/alpha" "archive/alpha"
npm run query -- move "projects/alpha" "archive/alpha" --no-update-links

# Move an arbitrary file (attachment/image); no link rewriting
npm run query -- move-file "assets/old.png" "assets/new.png"

# Literal find/replace patch on a note
npm run query -- patch "projects/alpha" "old text" "new text"
npm run query -- patch "projects/alpha" "TODO" "DONE" --all

# Delete a note (trash-safe by default; recoverable from .trash)
npm run query -- delete "inbox/idea"
npm run query -- delete "inbox/idea" --permanent

# For content that begins with "-" (markdown lists), pipe it via stdin or --file:
printf -- '- one\n- two' | npm run query -- add-section "projects/alpha" "Todo"

# Snapshot the vault into a git commit before the write (see Configuration)
OBSIDIAN_GIT_AUTOCOMMIT=1 npm run query -- add-tag "projects/alpha" review

# Use verbose mode to see the request being sent
npm run query -- --verbose search "pattern"
npm run query -- --verbose read "note1"
```

If you use mise, the equivalent commands are `mise run query -- search "productivity"`, etc.

The query tool calls the MCP server tools directly and returns the raw JSON responses, making it useful for testing and debugging.

## Tools

### search_notes

Search through markdown files in your vault using ripgrep patterns.

**Parameters:**
- `pattern` (string, required): Search pattern for ripgrep (max 1000 chars)
- `case_sensitive` (boolean, optional): Case sensitive search (default: false)
- `whole_word` (boolean, optional): Match whole words only
- `multiline` (boolean, optional): Enable multiline matching
- `context_lines` (number, optional): Number of context lines to show (default: 5, max: 100)
- `limit` (number, optional): Maximum number of files to return (default: 20, 0 = unlimited — no hard maximum)
- `max_matches_per_file` (number, optional): Maximum matches to return per file (default: 20, 0 = unlimited)
- `folder` (string, optional): Restrict to notes under this folder (relative to the vault root)
- `tags` (array, optional): Restrict to notes carrying these tags (leading `#` optional)
- `match` (string, optional): Semantics of `tags` — `"any"` (default) or `"all"`
- `where` (object, optional): Restrict to notes whose frontmatter satisfies these conditions (same syntax as `query_notes`)

**Returns:** An object bounding the result set:
- `results`: Array of search results, each with `path` (relative, without .md) and `matches` (line numbers + context)
- `truncated`: `true` if any cap dropped results
- `files_returned`: number of files in `results`
- `files_omitted`: matching files seen beyond `limit` and not returned
- `matches_capped_in`: paths of files whose matches were capped

When `folder`/`tags`/`where` are given, the candidate notes are resolved from the shared index first and ripgrep runs only over those files (chunked for large vaults); a filter matching zero notes returns empty without invoking ripgrep.

### search_notes_ranked

Full-text search ranked by BM25 relevance — the most relevant notes first, rather than every literal match. Complements `search_notes` (literal/regex, unranked); it doesn't replace it.

**Parameters:**
- `query` (string, required): Free-text query (max 1000 chars)
- `limit` (number, optional): Maximum number of results (default 100; `limit: 0` = unbounded; a positive limit is capped at 100)
- `folder` (string, optional): Restrict to notes under this folder (relative to the vault root)
- `tags` (array, optional): Restrict to notes carrying these tags (leading `#` optional)
- `match` (string, optional): Semantics of `tags` — `"any"` (default) or `"all"`
- `where` (object, optional): Restrict to notes whose frontmatter satisfies these conditions (same syntax as `query_notes`)

**Returns:** `{ results, returned, omitted, truncated }` — `results` is an array of note headers (same shape as `list_notes`) extended with:
- `score`: BM25 relevance score (higher = more relevant)
- `snippet`: A short matched excerpt

`returned`/`omitted`/`truncated` report how many rows came back vs. were dropped by the limit, so a truncated result isn't mistaken for a complete one.

Note: tokenization is ASCII/English-oriented (lowercased, split on non-alphanumeric, stemmed), so non-Latin scripts (e.g. CJK) and accented characters aren't well indexed here — use `search_notes` for literal non-ASCII matching.

Scopes to a candidate set via the same `folder`/`tags`/`where`/`match` filters as `search_notes` (resolved from the shared index first, then ranked over just those notes), so "the most relevant note about X among my work notes" is expressible.

### read_notes

Read and parse one or more notes from your vault.

**Parameters:**
- `paths` (array, required): Array of relative note paths (with or without .md extension, max 50)

**Returns:** `{ notes, errors }`
- `notes`: Array of note objects for every path read successfully, each with:
  - `path`: Relative path without .md extension (same identity field as the header tools)
  - `contents`: Markdown body verbatim (frontmatter removed; inline `#tags` in the body are preserved)
  - `frontmatter`: Parsed frontmatter as JSON object (same field name as `get_frontmatter`)
  - `tags`: The note's full tag set — frontmatter `tags:` unified with inline `#tags`
- `errors`: `[{ path, error }]` for paths that couldn't be read (missing or too large) — one bad path no longer fails the whole batch

A path-traversal attempt still errors the entire call; only missing/oversized files are reported per-path in `errors`.

### list_notes

List notes in the vault as lightweight headers, without full contents. Use it to discover what exists before searching or reading.

**Parameters:**
- `folder` (string, optional): Restrict to notes under this folder (relative to the vault root)
- `limit` (number, optional): Maximum number of notes to return (default `100`; pass `0` for unbounded — no cap)

**Returns:** `{ results, returned, omitted, truncated }`. `results` is the array of note headers (`path`, `title` (frontmatter title or basename), `tags`, `headline` (first markdown heading), `size`, `modified` (ISO timestamp)), bounded by `limit` (default `100`). `returned` is `results.length`, `omitted` is the number of notes dropped by the limit, and `truncated` is `true` when `omitted > 0`.

### get_links

Resolve the Obsidian link graph for a note.

**Parameters:**
- `path` (string, required): Relative note path (with or without .md extension)

**Returns:** An object with:
- `note`: Canonical path of the inspected note
- `outbound_links`: Resolved `[[wikilinks]]`, each with the raw `target` and resolved `path`
- `unresolved_links`: Wikilink targets that resolve to no note
- `backlinks`: Notes elsewhere in the vault that link to this one

Handles `[[note]]`, `[[note|alias]]`, `[[note#heading]]`, and `![[embeds]]`; links resolve by full relative path or basename.

### get_outline

A note's heading structure without its body — the outline. Closes the "check what sections exist, then edit the right one" loop without reading the whole note. Index-backed (no file read); headings inside fenced code blocks are excluded.

**Parameters:**
- `path` (string, required): Relative note path (with or without `.md`)

**Returns:** `{ path, outline }` where each outline entry is `{ heading, level, path, line, ambiguous }`. `path` is the full `" > "`-joined heading-path (e.g. `Projects > Log`) — the disambiguating address; `line` is 1-based; `ambiguous` is `true` when the bare heading text repeats in the note.

### read_section

Read a single section of a note without loading the whole note — the read-side complement of `append_to_section`/`replace_section`. Reads the file at call time (the index does not retain body text).

**Parameters:**
- `path` (string, required): Relative note path (with or without `.md`)
- `section` (string, required): A bare heading, or a `" > "`-joined heading-path like `Projects > Log`
- `include_subsections` (boolean, optional): Include nested subsections in the returned content (default: false)

**Returns:** `{ path, section, level, content }`. `section` is the resolved full heading-path; `content` is the heading line plus its own body (nested subsections excluded unless `include_subsections` is set). Frontmatter is never included.

A bare heading resolves when unique; an ambiguous bare heading errors loudly, listing the candidate full paths so you can retry with the exact one (mirrors `patch_note`'s fail-loud behavior).

### list_tags

Aggregate every tag across the vault, unifying inline `#tags` (including nested `#parent/child`) and frontmatter `tags:`.

**Parameters:** none

**Returns:** `{ results, returned, omitted, truncated }` — `results` is the array of `{ tag, count }` sorted by frequency. There is no `limit`, so the full set is always returned: `truncated` is always `false` and `omitted` is always `0`.

### find_by_tag

Find notes matching one or more tags.

**Parameters:**
- `tags` (array, required): Tags to match (with or without leading `#`)
- `match` (string, optional): `"any"` (default) or `"all"`
- `limit` (number, optional): Maximum number of notes to return (default 100; `limit: 0` = unbounded)

**Returns:** `{ results, returned, omitted, truncated }` — `results` is the array of note headers (same shape as `list_notes`), bounded by `limit` (default `100`). `returned` is `results.length`, `omitted` is the number of notes dropped by the limit, and `truncated` is `true` when `omitted > 0`.

### list_recent_notes

List notes ordered by recency, newest first.

**Parameters:**
- `limit` (number, optional): Maximum number of notes to return (default `100`; pass `0` for unbounded — no cap)
- `since` (string, optional): Only include notes on or after this ISO date
- `date_field` (string, optional): Frontmatter field to sort by instead of filesystem mtime (e.g. `updated`)
- `where` (object, optional): Frontmatter filters, e.g. `{ "status": "active" }` or `{ "priority": { "gt": 3 } }` (same condition syntax as `query_notes`)

**Returns:** `{ results, returned, omitted, truncated }`. `results` is the array of note headers (same shape as `list_notes`), bounded by `limit` (default `100`). `returned` is `results.length`, `omitted` is the number of notes dropped by the limit, and `truncated` is `true` when `omitted > 0`.

### get_related_notes

Find the notes most related to a given note and rank them — associative recall over the vault, computed entirely from the shared index with no embeddings or model. Relatedness is a transparent weighted blend of four signals: a **direct link** in either direction (weight 4), each **shared tag** (weight 3), each **shared out-link** (a note both link to — co-reference, weight 2), and each **shared backlink** (a note that links to both — co-citation, weight 2). Notes with no connecting signal are omitted.

**Parameters:**
- `path` (string, required): Relative note path (with or without `.md`)
- `limit` (number, optional): Maximum number of related notes to return (default `100`; pass `0` for unbounded — no cap)

**Returns:** `{ results, returned, omitted, truncated }`. `results` is the array of note headers (same shape as `list_notes`) extended with `score`, `reasons` (why each note surfaced), `shared_tags`, `shared_links`, `shared_backlinks`, and `linked`, bounded by `limit` (default `100`). `returned` is `results.length`, `omitted` is the number of related notes (notes with at least one connecting signal) dropped by the limit, and `truncated` is `true` when `omitted > 0`.

### get_frontmatter

Read just a note's parsed frontmatter (YAML metadata), without its body — a cheap way to inspect status, aliases, dates, or custom fields before reading or editing the whole note.

**Parameters:**
- `path` (string, required): Relative note path (with or without `.md`)

**Returns:** `{ path, frontmatter }` where `frontmatter` is the parsed YAML as an object (empty when the note has none).

### get_vault_stats

Summarize the whole vault in a single call, derived entirely from the shared index.

**Parameters:** none

**Returns:** `{ notes, total_size_bytes, distinct_tags, tag_assignments, tagged_notes, untagged_notes, resolved_links, unresolved_links, notes_with_links, orphan_notes, last_modified, first_modified }`. `orphan_notes` counts notes with neither inbound nor outbound resolved links; the time bounds are ISO timestamps (`null` for an empty vault).

### list_vault_issues

Vault-hygiene findings the index already knows about but that `get_vault_stats` only counts — the drill-down from a stat to the actual rows.

**Parameters:**
- `kind` (string, required): `"orphans"`, `"unresolved_links"`, or `"broken_anchors"`
- `limit` (number, optional): Cap on the number of returned rows/groups (default `100`; pass `0` for unbounded — no cap)

**Returns:** `{ results, returned, omitted, truncated }`. `results`' shape depends on `kind`:
- `"orphans"`: Array of note headers (same shape as `list_notes`) — notes with no inbound and no outbound resolved links (the same predicate behind `get_vault_stats`'s `orphan_notes`)
- `"unresolved_links"`: Array of `{ source, targets }` grouped by source note — `targets` is the raw wikilink targets in that note that resolve to nothing. `returned`/`omitted`/`truncated` for this kind count **groups (source notes), not individual targets**.
- `"broken_anchors"`: `[[note#heading]]` links whose target note resolves but whose heading anchor matches no heading in that note — the complement of `unresolved_links` ("note resolves, heading doesn't"). Array of `{ source, targets: [{ target, anchor }] }` grouped by source note; `returned`/`omitted`/`truncated` count groups (source notes), not individual anchors, same as `unresolved_links`. Block-ref anchors (`#^id`) and links to unresolved notes are excluded.

`returned` is `results.length`, `omitted` is the number of rows/groups dropped by the limit, and `truncated` is `true` when `omitted > 0`. For the full/unbounded result (`limit: 0`, or the default when the row/group count is ≤ 100), the `orphans` `results.length` equals `get_vault_stats`'s `orphan_notes`; the sum of every `targets` length under `unresolved_links`'s `results` equals `get_vault_stats`'s `unresolved_links` count — a group-limited result naturally shows fewer. Index-backed.

### list_files

List non-markdown files in the vault (attachments, images, PDFs) — the counterpart to `list_notes` for everything it deliberately excludes.

**Parameters:**
- `folder` (string, optional): Restrict to files under this folder (relative to the vault root)
- `extension` (string, optional): Filter by extension, leading dot optional and case-insensitive (e.g. `png` or `.PNG`)
- `limit` (number, optional): Maximum number of files to return (default `100`; pass `0` for unbounded — no cap)

**Returns:** `{ results, returned, omitted, truncated }`. `results` is the array of file entries (`path`, `size`, `modified`, `extension`) — `path` is vault-relative with the extension preserved, `modified` is an ISO timestamp, `extension` is lowercased without the dot — bounded by `limit` (default `100`). `returned` is `results.length`, `omitted` is the number of files dropped by the limit, and `truncated` is `true` when `omitted > 0`. Markdown files are never returned; does not touch the vault index.

### list_folders

Enumerate the vault's folders so an agent can see the shape of the vault before searching or reading — the folder-level counterpart to `list_notes` (notes) and `list_files` (attachments).

**Parameters:**
- `folder` (string, optional): Restrict to folders under this folder (relative to the vault root)
- `depth` (number, optional): Relative depth cap — `1` = immediate children of the scope (top-level folders when no `folder` is given)
- `limit` (number, optional): Maximum number of folders to return (default `100`; pass `0` for unbounded — no cap)

**Returns:** `{ results, returned, omitted, truncated }`. `results` is the array of `{ path, notes, total_notes, subfolders }` sorted by `path` — `notes` counts notes directly in the folder, `total_notes` counts notes recursively under it, `subfolders` counts direct child folders — bounded by `limit` (default `100`). `returned` is `results.length`, `omitted` is the number of folders dropped by the limit, and `truncated` is `true` when `omitted > 0`. Notes-only: a folder containing only attachments does not appear (use `list_files`). Root-level notes contribute no folder row. Index-backed.

### list_properties

The vault's frontmatter schema — every property key in use, with how many notes use it and what value types it takes. Like `list_tags` but for arbitrary properties.

**Parameters:**
- `include_tags` (boolean, optional): Include the `tags` key (default: true; set false since it's already covered by `list_tags`)

**Returns:** `{ results, returned, omitted, truncated }` — `results` is the array of `{ key, count, types }` where `types` is the distinct value types observed (`string`/`number`/`boolean`/`array`/`null`/`date`), sorted by `count` descending then `key`. There is no `limit`, so the full set is always returned: `truncated` is always `false` and `omitted` is always `0`.

### get_property_values

Distinct values of one frontmatter property, with per-note counts — a faceted breakdown of every value a key takes across the vault.

**Parameters:**
- `key` (string, required): The property key
- `limit` (number, optional): Maximum number of values to return (default `100`; pass `0` for unbounded — no cap)

**Returns:** `{ key, results, returned, omitted, truncated }`. `results` is `[{ value, count }]`, sorted by `count` descending, bounded by `limit` (default `100`). `returned` is `results.length`, `omitted` is the number of values dropped by the limit, and `truncated` is `true` when `omitted > 0`. Array-valued properties count each element once per note.

### query_notes

Find notes by frontmatter condition — generalizes the `where` filter in `list_recent_notes` into its own tool.

**Parameters:**
- `where` (object, required): `key -> condition` map. A condition is a bare scalar (equality / array-membership) or an operator object `{ eq, ne, gt, gte, lt, lte, exists, contains }`
- `match` (string, optional): `"all"` (default) or `"any"`
- `limit` (number, optional): Maximum number of notes to return (default `100`; pass `0` for unbounded — no cap)

Comparisons are type-aware: numeric when both sides parse as numbers, chronological when both parse as dates, otherwise case-insensitive string compare.

**Returns:** `{ results, returned, omitted, truncated }`. `results` is the array of note headers (same shape as `list_notes`), bounded by `limit` (default `100`). `returned` is `results.length`, `omitted` is the number of notes dropped by the limit, and `truncated` is `true` when `omitted > 0`.

### get_property

Read a single frontmatter property from one note — cheaper than reading the whole note or its full frontmatter when only one field is needed.

**Parameters:**
- `path` (string, required): Relative note path (with or without `.md`)
- `key` (string, required): The property key

**Returns:** `{ path, key, value, present }` where `present` distinguishes an absent key from a key explicitly set to `null`.

### resolve_note

Map a human-facing note name to its canonical path. Humans refer to notes by title or alias; every other tool addresses by path — this closes that gap directly, removing the search-then-guess round trip of running `search_notes_ranked` and eyeballing the top hit.

**Parameters:**
- `query` (string, required): The human-facing name (title, alias, or basename) to resolve

**Returns:** `{ query, matches, resolved }`. `matches` is an array of `{ path, title, matched_on }` sorted by path, where `matched_on` is `"title" | "alias" | "basename"`; a note matching on more than one field appears once, labeled with its strongest field (precedence `title > alias > basename`). `resolved` is the single path when exactly one note matches, else `null` (ambiguous or no match) — the tool never guesses among candidates.

Matching is exact and case-insensitive against frontmatter `title`, each frontmatter `aliases[]` entry (a single string or an array), and the file basename. No partial/substring/fuzzy matching — that is `search_notes_ranked`'s job. A no-match is a normal empty result, not an error. Index-backed.

### write_note

Create a note, or overwrite an existing one.

**Parameters:**
- `path` (string, required): Relative note path (with or without .md extension)
- `content` (string, required): Full note body (may include frontmatter)
- `overwrite` (boolean, optional): Allow replacing an existing note (default: false — refuses to clobber)

**Returns:** `{ path, created }`

### append_note

Append text to the end of a note.

**Parameters:**
- `path` (string, required): Relative note path
- `content` (string, required): Text to append
- `create` (boolean, optional): Create the note if it does not exist (default: false)

**Returns:** `{ path, created }`

### prepend_note

Prepend text to the start of a note's body. Any frontmatter block is preserved and the text is inserted after it (never before the YAML fence).

**Parameters:**
- `path` (string, required): Relative note path
- `content` (string, required): Text to prepend
- `create` (boolean, optional): Create the note if it does not exist (default: false)

**Returns:** `{ path, created }`

### delete_note

Delete a note. **Trash-safe by default:** the note is moved to the vault's `.trash` folder (Obsidian's convention, ignored by the index) so the deletion is recoverable; repeated trashings of the same name get a numeric suffix. Errors if the note does not exist.

**Parameters:**
- `path` (string, required): Relative note path
- `permanent` (boolean, optional): Unlink the file outright instead of trashing it (default: false)

**Returns:** `{ path, deleted, trashed, trash_path?, dangled_backlinks }` — `dangled_backlinks` lists the notes that linked to the deleted note and now have a broken `[[wikilink]]` (reported only; those notes are not modified).

### move_note

Move or rename a note. By default every `[[wikilink]]` elsewhere in the vault that pointed to the old location is rewritten to the new one — full-path links become the new full path, bare-basename links become the new basename, and aliases and `#anchors` are preserved — so the link graph is never broken.

**Parameters:**
- `from` (string, required): Current relative note path (with or without `.md`)
- `to` (string, required): New relative note path
- `overwrite` (boolean, optional): Allow replacing an existing note at the destination (default: false)
- `update_links` (boolean, optional): Rewrite wikilinks that point to this note (default: true)

**Returns:** `{ from, to, overwritten, updated_notes, updated_links }`

### move_file

Move or rename an arbitrary file (attachments, images, or notes referenced by literal path). Treats the path literally — no `.md` is appended and no wikilinks are rewritten.

**Parameters:**
- `from` (string, required): Current relative file path (with extension)
- `to` (string, required): New relative file path (with extension)
- `overwrite` (boolean, optional): Allow replacing an existing file at the destination (default: false)

**Returns:** `{ from, to, overwritten }`

### patch_note

Apply a literal find/replace patch to a note's raw text. The match is an exact string (never a regex — no injection or catastrophic-backtracking risk). Errors if the text to find is absent, so a stale patch fails loudly rather than silently doing nothing.

**Parameters:**
- `path` (string, required): Relative note path
- `find` (string, required): Exact literal text to find
- `replace` (string, required): Replacement text
- `all` (boolean, optional): Replace every occurrence instead of only the first (default: false)

With `all` false, a `find` that occurs more than once errors (reporting the count) rather than silently patching the first — set `all: true` to replace every occurrence, or narrow `find` until it is unique.

**Returns:** `{ path, replacements }`

### add_tag / remove_tag

Add or remove tags in a note's frontmatter without rewriting the note. Adds are idempotent; storage is normalized to a `tags:` array.

**Parameters:**
- `path` (string, required): Relative note path
- `tags` (array, required): Tags to add/remove (with or without leading `#`)

**Returns:** `{ path, tags }` — the resulting tag list.

### set_frontmatter

Set and/or unset frontmatter fields while leaving the body untouched.

**Parameters:**
- `path` (string, required): Relative note path
- `set` (object, optional): Fields to set, e.g. `{ "status": "done" }`
- `unset` (array, optional): Frontmatter keys to remove

**Returns:** `{ path, changed }`

### add_property_values / remove_property_values

Add or remove values from an array-valued frontmatter property without rewriting the whole note. Adding is idempotent (no duplicates); an absent key is created as a new array, and an existing scalar is promoted to `[old, ...new]`. Removing shrinks the array and drops the key entirely once it has no values left.

**Parameters:**
- `path` (string, required): Relative note path
- `key` (string, required): The property key
- `values` (array, required): Values to add/remove

**Returns:** `{ path, key, values }` — the resulting list.

### rename_property

Rename a frontmatter key in place, preserving its value and its position in the YAML. Errors if `from` is absent or `to` already exists.

**Parameters:**
- `path` (string, required): Relative note path
- `from` (string, required): Existing property key
- `to` (string, required): New property key

**Returns:** `{ path, from, to }`

### add_section

Insert a new heading + content. Appends at the end by default, or immediately after the section named by `after`. Errors on a duplicate heading at the same level.

**Parameters:**
- `path` (string, required): Relative note path
- `heading` (string, required): Heading text (without leading `#`)
- `content` (string, required): Body text for the new section
- `level` (number, optional): Heading level 1–6 (default: 2)
- `after` (string, optional): Insert after this section — a bare heading or a `" > "`-joined heading-path, resolved with the same fail-loud ambiguity behavior as `append_to_section`

**Returns:** `{ path, heading }`

### append_to_section

Append text under an existing heading (before the next heading), leaving the rest of the note untouched.

**Parameters:**
- `path` (string, required): Relative note path
- `heading` (string, required): Section to append to — a bare heading or a `" > "`-joined heading-path (e.g. `Projects > Log`)
- `content` (string, required): Text to append
- `create` (boolean, optional): Create the section if missing (default: false)

Addressing mirrors `read_section`'s fail-loud scheme: an ambiguous bare `heading` (one that repeats in the note) errors, listing the candidate full heading-paths so you can retry with the exact one and edit the right section. `create` only recovers a *missing* section; an ambiguous one is never silently created.

**Returns:** `{ path, heading }`

### replace_section

Replace the body under an existing heading (the heading line is kept). Errors if the section is missing.

**Parameters:**
- `path` (string, required): Relative note path
- `heading` (string, required): Section to replace — a bare heading or a `" > "`-joined heading-path, resolved with the same fail-loud ambiguity behavior as `append_to_section`
- `content` (string, required): New body text

**Returns:** `{ path, heading }`

### rename_section

Rename a heading in a note and rewrite every inbound `[[note#heading]]` anchor across the vault to the new heading — the heading-level analogue of `move_note`, closing the last structural edit that could silently break the link graph.

**Parameters:**
- `path` (string, required): Relative note path
- `from` (string, required): Heading to rename — a bare heading or a `" > "`-joined heading-path, resolved with the same fail-loud ambiguity behavior as `read_section`/`replace_section`
- `to` (string, required): New heading text
- `update_anchors` (boolean, optional): Rewrite inbound `[[note#heading]]` anchors elsewhere in the vault (default: true)

**Returns:** `{ path, from, to, updated_notes, updated_links }` — `from`/`to` are the resolved old/new heading; `updated_notes` counts OTHER notes touched (the renamed note itself is always touched, so it's excluded); `updated_links` counts every anchor rewritten, including the renamed note's own self-references (`[[#Old]]`/`[[thisnote#Old]]`) alongside inbound anchors elsewhere.

Anchor matching is literal, case-insensitive (trimmed) text — not Obsidian's slug normalization. Block-ref anchors (`#^id`) are never rewritten. An ambiguous or missing `from` fails loud.

If the renamed heading's leaf text is duplicated elsewhere in the same note (e.g. the same heading under a different parent), inbound anchors meant for the OTHER occurrence may also get rewritten — Obsidian anchors carry no parent context, so matching is by literal heading text alone.

### bulk_edit

Apply one or more frontmatter mutations to many notes in a single call, under a single git snapshot, with per-note result reporting. Turns "tag these 30 notes" from 30 round trips (and 30 auto-snapshot commits) into one.

**Parameters:**
- `select` (object, required): either `paths` (array of explicit note paths) **or** a filter — `where` (query_notes-style condition object) and/or `tags` (find_by_tag-style), optionally scoped by `folder` and combined via `match` (`"all"` default or `"any"`), plus an optional `limit`. Exactly one of `paths` or the filter form must be given — providing both errors, and providing neither errors.
- `operations` (array, required): ordered, non-empty list of frontmatter-only mutations applied in turn to each matched note (e.g. `rename_property` then `set_frontmatter` on the new key, in one pass). Supported ops: `add_tag`, `remove_tag`, `set_frontmatter`, `add_property_values`, `remove_property_values`, `rename_property` — same shapes as the single-note tools. No section/body ops.
- `dry_run` (boolean, optional): preview the matched notes and operations with zero writes and no git snapshot. This previews the selection and operation shape only — it does not parse notes or predict per-note apply outcomes, so a note that will fail on commit (e.g. `rename_property` onto an existing key) still shows in the dry-run match set.
- `expected_count` (number, optional): abort before any snapshot or write if the resolved match count differs — guards a filter that drifted between an agent's preview and its commit.

**Returns:** `{ dry_run, matched_count, applied_count, failed_count, results }`, where each `results` entry is `{ path, ok: true, changed }` or `{ path, ok: false, error }`. A per-note failure is isolated and reported; it never sinks the rest of the batch. `changed: false` marks a note whose operations were all no-ops. One git snapshot covers the whole batch, not one per note.

> **Body vs. frontmatter fidelity:** section edits preserve the frontmatter block byte-for-byte; frontmatter edits (tags, fields) re-serialize the YAML in canonical form (block-style lists) but leave the body untouched. Headings inside fenced code blocks are ignored. All writes are path-traversal protected.

> **Validation:** every frontmatter write rejects nested objects/maps, arrays containing non-scalar elements, and markdown syntax in string values (bare URLs are allowed). Validation runs only on the keys a given write actually touches, so a pre-existing violation on an untouched key never blocks an unrelated edit.

## Example Usage

Once connected to an MCP client, you can:

```javascript
// Search for notes containing "productivity" (bounded: 20 files, 20 matches/file by default)
await search_notes({
  pattern: "productivity",
  case_sensitive: false,
  limit: 20,             // 0 for unlimited
  max_matches_per_file: 20
});

// Read specific notes
await read_notes({
  paths: ["daily-notes/2024-01-15", "projects/my-project"]
});

// Orient: list notes under a folder
await list_notes({ folder: "projects", limit: 20 });

// Traverse: follow the link graph
await get_links({ path: "projects/my-project" });

// Recall: what else is relevant to this note?
await get_related_notes({ path: "projects/my-project", limit: 5 });

// Retrieve by curation: notes tagged both #project and #active
await find_by_tag({ tags: ["project", "active"], match: "all" });

// Stay current: recent notes, active only
await list_recent_notes({ limit: 10, where: { status: "active" } });

// Create a note (won't clobber unless overwrite: true)
await write_note({ path: "inbox/idea", content: "# Idea\n\nbody" });

// Surgical edits — no whole-note rewrite
await add_tag({ path: "projects/alpha", tags: ["review"] });
await set_frontmatter({ path: "projects/alpha", set: { status: "done" } });
await append_to_section({ path: "projects/alpha", heading: "Log", content: "shipped" });

// Bulk frontmatter edit across many notes, one git snapshot
await bulk_edit({
  select: { where: { status: "draft" } },
  operations: [
    { op: "add_tag", tags: ["review"] },
    { op: "set_frontmatter", set: { status: "active" } }
  ],
  dry_run: true
});
```

## Configuration

The server requires the `OBSIDIAN_VAULT_PATH` environment variable to be set to your Obsidian vault directory.

### Enabling writes (`OBSIDIAN_ALLOW_WRITES`)

The write tools are **off by default** — out of the box the server is read-only.
Set `OBSIDIAN_ALLOW_WRITES` to a truthy value (`1`, `true`, `yes`, `on`) to
expose them:

```bash
export OBSIDIAN_ALLOW_WRITES=1
```

When disabled, the eighteen write tools (`write_note`, `append_note`,
`prepend_note`, `delete_note`, `move_note`, `move_file`, `patch_note`,
`add_tag`, `remove_tag`, `set_frontmatter`, `add_property_values`,
`remove_property_values`, `rename_property`, `add_section`,
`append_to_section`, `replace_section`, `rename_section`, `bulk_edit`) are
hidden from the tool list and any call to one is rejected, so an agent only
ever sees the read tools. The flag gates the MCP server; the query CLI is the
operator's own tool and is not affected by it.

### Git safety net (`OBSIDIAN_GIT_AUTOCOMMIT`)

Set `OBSIDIAN_GIT_AUTOCOMMIT` to a truthy value (`1`, `true`, `yes`, `on`) to
snapshot the vault into a git commit **before every write**. The pre-existing
state is committed (`git add -A && git commit`) so the agent's change lands as
an isolated, revertible diff — the agent's own write is left **uncommitted** for
you to review. A clean working tree is a no-op (nothing to snapshot).

The guard is **fail-closed**: when the flag is on but the snapshot can't be made
(git isn't installed, the vault isn't a git repository, or the commit fails),
the write is refused rather than proceeding without the safety net. Leave the
variable unset to disable it entirely (writes then require no git).

## Claude Desktop Integration

To use this MCP server with Claude Desktop, first build the project (`npm install && npm run build`), then add it to your Claude configuration file:

**macOS/Linux**: `~/.config/claude/claude_desktop_config.json`
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "node",
      "args": ["/path/to/headless-obsidian-mcp/dist/index.js"],
      "env": {
        "OBSIDIAN_VAULT_PATH": "/path/to/your/obsidian/vault"
      }
    }
  }
}
```

**Using the start script (installs and builds automatically on first run):**
```json
{
  "mcpServers": {
    "obsidian": {
      "command": "/path/to/headless-obsidian-mcp/start-server.sh",
      "env": {
        "OBSIDIAN_VAULT_PATH": "/path/to/your/obsidian/vault"
      }
    }
  }
}
```

This uses the included `start-server.sh` script, which changes to the project directory, installs dependencies and builds if needed, then runs `node dist/index.js`.

Replace the paths with:
- `/path/to/headless-obsidian-mcp`: The absolute path to this project directory
- `/path/to/your/obsidian/vault`: The absolute path to your Obsidian vault

To allow the agent to modify your vault, add `"OBSIDIAN_ALLOW_WRITES": "1"` to the `env` block above (writes are off by default). To also snapshot the vault into a git commit before every write, add `"OBSIDIAN_GIT_AUTOCOMMIT": "1"`.

After updating the configuration, restart Claude Desktop. The server will appear as "obsidian" and provide the read tools (`search_notes`, `search_notes_ranked`, `read_notes`, `list_notes`, `get_links`, `get_outline`, `read_section`, `list_tags`, `find_by_tag`, `list_recent_notes`, `get_related_notes`, `get_frontmatter`, `get_vault_stats`, `list_vault_issues`, `list_files`, `list_folders`, `list_properties`, `get_property_values`, `query_notes`, `get_property`, `resolve_note`). With `OBSIDIAN_ALLOW_WRITES` enabled it also provides the write tools (`write_note`, `append_note`, `prepend_note`, `delete_note`, `move_note`, `move_file`, `patch_note`, `add_tag`, `remove_tag`, `set_frontmatter`, `add_property_values`, `remove_property_values`, `rename_property`, `add_section`, `append_to_section`, `replace_section`, `rename_section`, `bulk_edit`).

## Acknowledgments

This project began as a Node.js port of [notes-mcp](https://github.com/boazy/notes-mcp) by Boaz Yaniv, and has since been substantially extended with knowledge-base, structure-aware editing, and vault-management tools. The original is MIT licensed; that license and copyright are retained in [LICENSE](LICENSE).

Thanks also to [mcpvault](https://github.com/bitbonsai/mcpvault) by bitbonsai, whose Obsidian MCP server was a useful reference while shaping this project's tool surface.

## License

Released under the [MIT License](LICENSE).
