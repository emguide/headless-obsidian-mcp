# Notes MCP Server

This is an MCP (Model Context Protocol) server for interacting with Obsidian notes. It provides tools to search through and read notes from an Obsidian vault.

## Setup

1. Set the `OBSIDIAN_VAULT_PATH` environment variable to point to your Obsidian vault directory
2. Ensure `ripgrep` (`rg`) is installed on your system
3. Install dependencies and build: `npm install && npm run build`
4. Run with: `npm start` or `mise run start` (if using mise)

## Tools

### search_notes
- **Purpose**: Search through markdown files in the vault using ripgrep
- **Input**: 
  - `pattern` (required): Search pattern for ripgrep (max 1000 chars)
  - `case_sensitive` (optional): Case sensitive search (default: false)
  - `whole_word` (optional): Match whole words only
  - `multiline` (optional): Enable multiline matching
  - `context_lines` (optional): Number of context lines to show (default: 5, max: 100)
- **Output**: Array of search results with file paths (without .md suffix) and context lines
- **Security**: Protected against flag injection and regex DoS attacks

### read_notes  
- **Purpose**: Read and parse one or more notes
- **Input**: `paths` - Array of relative note paths (with or without .md extension, max 50 notes)
- **Output**: Array of note objects with:
  - `name`: Relative path without .md suffix
  - `contents`: Markdown content without frontmatter and Obsidian tags
  - `metadata`: Parsed frontmatter as JSON object
  - `tags`: Array of extracted Obsidian tags
- **Security**: Protected against path traversal attacks, with file size limits (10MB per note)

### list_notes
- **Purpose**: Discover what exists in the vault. Returns lightweight note headers (no full contents), so an agent can orient itself before searching or reading.
- **Input**:
  - `folder` (optional): Restrict to notes under this folder (relative to the vault root)
  - `limit` (optional): Maximum number of notes to return
- **Output**: Array of note headers with `path`, `title` (frontmatter title or basename), `tags`, `headline` (first markdown heading), `size`, and `modified` (ISO timestamp)

### get_links
- **Purpose**: Resolve the Obsidian link graph for a note, turning the flat vault into a navigable graph.
- **Input**: `path` (required) - Relative note path (with or without .md extension)
- **Output**: Object with:
  - `note`: The canonical path of the inspected note
  - `outbound_links`: Resolved `[[wikilinks]]` (each with the raw `target` and resolved `path`)
  - `unresolved_links`: Wikilink targets that do not resolve to any note
  - `backlinks`: Notes elsewhere in the vault that link to this one
- **Notes**: Handles `[[note]]`, `[[note|alias]]`, `[[note#heading]]`, and `![[embeds]]`. Links resolve by full relative path or by basename (Obsidian's default).
- **Security**: Path traversal protected via the same guard as read_notes.

### list_tags
- **Purpose**: Show the vault's topic index. Returns every tag with the number of notes using it, sorted by frequency.
- **Input**: none
- **Output**: Array of `{ tag, count }`. Unifies inline `#tags` (including nested `#parent/child`) and frontmatter `tags:`.

### find_by_tag
- **Purpose**: High-precision retrieval by human curation.
- **Input**:
  - `tags` (required): Array of tags to match (with or without leading `#`)
  - `match` (optional): `"any"` (default) or `"all"`
  - `limit` (optional): Maximum number of notes to return
- **Output**: Array of note headers (same shape as `list_notes`)

### list_recent_notes
- **Purpose**: Find current material. Returns notes ordered by recency (newest first).
- **Input**:
  - `limit` (optional): Maximum number of notes to return (default: 20)
  - `since` (optional): Only include notes on or after this ISO date
  - `date_field` (optional): Frontmatter field to sort by instead of filesystem mtime (e.g. `updated`)
  - `where` (optional): Frontmatter equality filters, e.g. `{ "status": "active" }` (matches array members too)
- **Output**: Array of note headers (same shape as `list_notes`)

## Dependencies

- Node.js runtime (18+)
- ripgrep (`rg`) command-line tool
- @modelcontextprotocol/sdk
- gray-matter (frontmatter parsing)
- commander (query CLI argument parsing)
- Node's built-in `node:path`, `node:fs/promises`, and `node:child_process`

## Development

- `npm run dev` or `mise run dev` - Run in watch mode (via tsx, no build step)
- `npm run build` or `mise run build` - Compile TypeScript to `dist/`
- `npm start` or `mise run start` - Run the compiled server (`dist/index.js`)
- `npm test` - Run the test suite (Node's built-in `node:test` runner via tsx, no extra deps)

### Vault index

The knowledge-base tools (`list_notes`, `get_links`, `list_tags`, `find_by_tag`,
`list_recent_notes`) share an in-memory index (`src/tools/vault-index.ts`) that
parses each note once (frontmatter, tags, wikilinks, headings) and caches the
result. Each tool call refreshes the index by walking the vault and re-reading
only files whose size or mtime changed, so repeated calls are map lookups rather
than full-vault scans. Backlinks are precomputed during refresh.

The project includes a `mise.toml` file for simplified task management with mise.
The build output is written to `dist/`; the compiled entry point is `dist/index.js`.

## Testing

Use the included query CLI tool for testing (runs from source via tsx):

```bash
# Search examples
npm run query -- search "productivity"                  # Case-insensitive search
npm run query -- search "TODO" --case-sensitive        # Case-sensitive search
npm run query -- search "test" --whole-word             # Whole words only
npm run query -- search "pattern" --context 10         # Custom context lines

# Read examples
npm run query -- read "note1" "folder/note2"           # Read multiple notes
npm run query -- --verbose search "pattern"            # Verbose mode

# Knowledge-base examples
npm run query -- list                                   # List all notes (headers)
npm run query -- list --folder projects --limit 20     # Scope to a folder
npm run query -- links "projects/alpha"                # Outbound links + backlinks
npm run query -- tags                                   # All tags with counts
npm run query -- find-by-tag productivity project --all # Notes with all tags
npm run query -- recent --limit 10                     # Most recently modified
npm run query -- recent --date-field updated --since 2026-07-01
```

(With mise: `mise run query -- search "productivity"`, etc.)

## Documentation Updates

**Important**: When updating functionality mentioned in this file or README.md, always update both documentation files accordingly. Only skip documentation updates when testing experimental features that aren't ready for users.