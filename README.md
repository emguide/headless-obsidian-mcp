# Headless Obsidian MCP

A headless MCP (Model Context Protocol) server for interacting with Obsidian vaults. It gives AI assistants Obsidian's power — full-text search, the link graph, tags, and structure-aware editing — without the GUI, making your knowledge base a first-class agent tool.

## Features

- **Search Notes**: Full-text search through your Obsidian vault using ripgrep
- **Ranked Search**: BM25-ranked full-text search — most relevant notes first, with a matched snippet
- **Read Notes**: Parse and extract content, metadata, and tags from notes
- **List Notes**: Discover the vault as lightweight headers — a table of contents for agents
- **Link Graph**: Resolve `[[wikilinks]]` and backlinks to traverse related notes
- **Tag Index**: Aggregate all tags with counts and retrieve notes by tag
- **Related Notes**: Associative recall — rank the notes most related to a given one (shared tags + link graph), no embeddings required
- **Recency & Metadata**: Surface the most recent notes, filtered by frontmatter; read a note's frontmatter alone or get whole-vault stats
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

# BM25-ranked full-text search (most relevant notes first)
npm run query -- search-ranked "kubernetes networking"
npm run query -- search-ranked "kubernetes networking" --limit 5

# Read specific notes
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

# Frontmatter schema, distinct values, and condition queries
npm run query -- properties
npm run query -- property-values status
npm run query -- query --where '{"status":"active","priority":{"gt":3}}'
npm run query -- get-property "projects/alpha" status

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

# Sections (heading-scoped edits)
npm run query -- add-section "projects/alpha" "Next steps" "- ship it"
npm run query -- append-to-section "projects/alpha" "Log" "did a thing"
npm run query -- replace-section "projects/alpha" "Summary" "new summary"

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

**Returns:** Array of search results with:
- `path`: Relative note path (without .md extension)
- `matches`: Array of matches with line numbers and context

### search_notes_ranked

Full-text search ranked by BM25 relevance — the most relevant notes first, rather than every literal match. Complements `search_notes` (literal/regex, unranked); it doesn't replace it.

**Parameters:**
- `query` (string, required): Free-text query (max 1000 chars)
- `limit` (number, optional): Maximum number of results (default: 10, max: 100)

**Returns:** Array of note headers (same shape as `list_notes`) extended with:
- `score`: BM25 relevance score (higher = more relevant)
- `snippet`: A short matched excerpt

Note: tokenization is ASCII/English-oriented (lowercased, split on non-alphanumeric, stemmed), so non-Latin scripts (e.g. CJK) and accented characters aren't well indexed here — use `search_notes` for literal non-ASCII matching.

### read_notes

Read and parse one or more notes from your vault.

**Parameters:**
- `paths` (array, required): Array of relative note paths (with or without .md extension, max 50)

**Returns:** Array of note objects with:
- `name`: Note name (relative path without .md extension)
- `contents`: Markdown content (without frontmatter and tags)
- `metadata`: Parsed frontmatter as JSON object
- `tags`: Array of extracted Obsidian tags

### list_notes

List notes in the vault as lightweight headers, without full contents. Use it to discover what exists before searching or reading.

**Parameters:**
- `folder` (string, optional): Restrict to notes under this folder (relative to the vault root)
- `limit` (number, optional): Maximum number of notes to return

**Returns:** Array of note headers with `path`, `title` (frontmatter title or basename), `tags`, `headline` (first markdown heading), `size`, and `modified` (ISO timestamp).

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

### list_tags

Aggregate every tag across the vault, unifying inline `#tags` (including nested `#parent/child`) and frontmatter `tags:`.

**Parameters:** none

**Returns:** Array of `{ tag, count }` sorted by frequency.

### find_by_tag

Find notes matching one or more tags.

**Parameters:**
- `tags` (array, required): Tags to match (with or without leading `#`)
- `match` (string, optional): `"any"` (default) or `"all"`
- `limit` (number, optional): Maximum number of notes to return

**Returns:** Array of note headers (same shape as `list_notes`).

### list_recent_notes

List notes ordered by recency, newest first.

**Parameters:**
- `limit` (number, optional): Maximum number of notes to return (default: 20)
- `since` (string, optional): Only include notes on or after this ISO date
- `date_field` (string, optional): Frontmatter field to sort by instead of filesystem mtime (e.g. `updated`)
- `where` (object, optional): Frontmatter equality filters, e.g. `{ "status": "active" }`

**Returns:** Array of note headers (same shape as `list_notes`).

### get_related_notes

Find the notes most related to a given note and rank them — associative recall over the vault, computed entirely from the shared index with no embeddings or model. Relatedness is a transparent weighted blend of four signals: a **direct link** in either direction (weight 4), each **shared tag** (weight 3), each **shared out-link** (a note both link to — co-reference, weight 2), and each **shared backlink** (a note that links to both — co-citation, weight 2). Notes with no connecting signal are omitted.

**Parameters:**
- `path` (string, required): Relative note path (with or without `.md`)
- `limit` (number, optional): Maximum number of related notes to return (default: 10)

**Returns:** Array of note headers (same shape as `list_notes`) extended with `score`, `reasons` (why each note surfaced), `shared_tags`, `shared_links`, `shared_backlinks`, and `linked`.

### get_frontmatter

Read just a note's parsed frontmatter (YAML metadata), without its body — a cheap way to inspect status, aliases, dates, or custom fields before reading or editing the whole note.

**Parameters:**
- `path` (string, required): Relative note path (with or without `.md`)

**Returns:** `{ path, frontmatter }` where `frontmatter` is the parsed YAML as an object (empty when the note has none).

### get_vault_stats

Summarize the whole vault in a single call, derived entirely from the shared index.

**Parameters:** none

**Returns:** `{ notes, total_size_bytes, distinct_tags, tag_assignments, tagged_notes, untagged_notes, resolved_links, unresolved_links, notes_with_links, orphan_notes, last_modified, first_modified }`. `orphan_notes` counts notes with neither inbound nor outbound resolved links; the time bounds are ISO timestamps (`null` for an empty vault).

### list_properties

The vault's frontmatter schema — every property key in use, with how many notes use it and what value types it takes. Like `list_tags` but for arbitrary properties.

**Parameters:**
- `include_tags` (boolean, optional): Include the `tags` key (default: true; set false since it's already covered by `list_tags`)

**Returns:** Array of `{ key, count, types }` where `types` is the distinct value types observed (`string`/`number`/`boolean`/`array`/`null`/`date`), sorted by `count` descending then `key`.

### get_property_values

Distinct values of one frontmatter property, with per-note counts — a faceted breakdown of every value a key takes across the vault.

**Parameters:**
- `key` (string, required): The property key
- `limit` (number, optional): Maximum number of values to return

**Returns:** `{ key, values: [{ value, count }] }`, sorted by `count` descending. Array-valued properties count each element once per note.

### query_notes

Find notes by frontmatter condition — generalizes the `where` filter in `list_recent_notes` into its own tool.

**Parameters:**
- `where` (object, required): `key -> condition` map. A condition is a bare scalar (equality / array-membership) or an operator object `{ eq, ne, gt, gte, lt, lte, exists, contains }`
- `match` (string, optional): `"all"` (default) or `"any"`
- `limit` (number, optional): Maximum number of notes to return

Comparisons are type-aware: numeric when both sides parse as numbers, chronological when both parse as dates, otherwise case-insensitive string compare.

**Returns:** Array of note headers (same shape as `list_notes`).

### get_property

Read a single frontmatter property from one note — cheaper than reading the whole note or its full frontmatter when only one field is needed.

**Parameters:**
- `path` (string, required): Relative note path (with or without `.md`)
- `key` (string, required): The property key

**Returns:** `{ path, key, value, present }` where `present` distinguishes an absent key from a key explicitly set to `null`.

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

**Returns:** `{ path, deleted, trashed, trash_path? }`

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
- `after` (string, optional): Insert after the section with this heading

**Returns:** `{ path, heading }`

### append_to_section

Append text under an existing heading (before the next heading), leaving the rest of the note untouched.

**Parameters:**
- `path` (string, required): Relative note path
- `heading` (string, required): Heading of the section to append to
- `content` (string, required): Text to append
- `create` (boolean, optional): Create the section if missing (default: false)

**Returns:** `{ path, heading }`

### replace_section

Replace the body under an existing heading (the heading line is kept). Errors if the section is missing.

**Parameters:**
- `path` (string, required): Relative note path
- `heading` (string, required): Heading of the section to replace
- `content` (string, required): New body text

**Returns:** `{ path, heading }`

> **Body vs. frontmatter fidelity:** section edits preserve the frontmatter block byte-for-byte; frontmatter edits (tags, fields) re-serialize the YAML in canonical form (block-style lists) but leave the body untouched. Headings inside fenced code blocks are ignored. All writes are path-traversal protected.

> **Validation:** every frontmatter write rejects nested objects/maps, arrays containing non-scalar elements, and markdown syntax in string values (bare URLs are allowed). Validation runs only on the keys a given write actually touches, so a pre-existing violation on an untouched key never blocks an unrelated edit.

## Example Usage

Once connected to an MCP client, you can:

```javascript
// Search for notes containing "productivity"
await search_notes({
  pattern: "productivity",
  case_sensitive: false
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

When disabled, the sixteen write tools (`write_note`, `append_note`,
`prepend_note`, `delete_note`, `move_note`, `move_file`, `patch_note`,
`add_tag`, `remove_tag`, `set_frontmatter`, `add_property_values`,
`remove_property_values`, `rename_property`, `add_section`,
`append_to_section`, `replace_section`) are hidden from the tool list and any
call to one is rejected, so an agent only ever sees the read tools. The flag
gates the MCP server; the query CLI is the operator's own tool and is not
affected by it.

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

After updating the configuration, restart Claude Desktop. The server will appear as "obsidian" and provide the read tools (`search_notes`, `search_notes_ranked`, `read_notes`, `list_notes`, `get_links`, `list_tags`, `find_by_tag`, `list_recent_notes`, `get_related_notes`, `get_frontmatter`, `get_vault_stats`, `list_properties`, `get_property_values`, `query_notes`, `get_property`). With `OBSIDIAN_ALLOW_WRITES` enabled it also provides the write tools (`write_note`, `append_note`, `prepend_note`, `delete_note`, `move_note`, `move_file`, `patch_note`, `add_tag`, `remove_tag`, `set_frontmatter`, `add_property_values`, `remove_property_values`, `rename_property`, `add_section`, `append_to_section`, `replace_section`).

## Acknowledgments

This project began as a Node.js port of [notes-mcp](https://github.com/boazy/notes-mcp) by Boaz Yaniv, and has since been substantially extended with knowledge-base, structure-aware editing, and vault-management tools. The original is MIT licensed; that license and copyright are retained in [LICENSE](LICENSE).

Thanks also to [mcpvault](https://github.com/bitbonsai/mcpvault) by bitbonsai, whose Obsidian MCP server was a useful reference while shaping this project's tool surface.

## License

Released under the [MIT License](LICENSE).
