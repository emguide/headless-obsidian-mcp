# Notes MCP Server

An MCP (Model Context Protocol) server for interacting with Obsidian notes. This server provides tools to search through and read notes from your Obsidian vault, making your knowledge base accessible to AI assistants.

## Features

- **Search Notes**: Full-text search through your Obsidian vault using ripgrep
- **Read Notes**: Parse and extract content, metadata, and tags from notes
- **List Notes**: Discover the vault as lightweight headers — a table of contents for agents
- **Link Graph**: Resolve `[[wikilinks]]` and backlinks to traverse related notes
- **Tag Index**: Aggregate all tags with counts and retrieve notes by tag
- **Recency & Metadata**: Surface the most recent notes, filtered by frontmatter
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

## Testing

You can test the MCP server using the included query CLI tool. It runs directly from
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

// Retrieve by curation: notes tagged both #project and #active
await find_by_tag({ tags: ["project", "active"], match: "all" });

// Stay current: recent notes, active only
await list_recent_notes({ limit: 10, where: { status: "active" } });
```

## Configuration

The server requires the `OBSIDIAN_VAULT_PATH` environment variable to be set to your Obsidian vault directory.

## Claude Desktop Integration

To use this MCP server with Claude Desktop, first build the project (`npm install && npm run build`), then add it to your Claude configuration file:

**macOS/Linux**: `~/.config/claude/claude_desktop_config.json`
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "notes": {
      "command": "node",
      "args": ["/path/to/notes-mcp/dist/index.js"],
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
    "notes": {
      "command": "/path/to/notes-mcp/start-server.sh",
      "env": {
        "OBSIDIAN_VAULT_PATH": "/path/to/your/obsidian/vault"
      }
    }
  }
}
```

This uses the included `start-server.sh` script, which changes to the project directory, installs dependencies and builds if needed, then runs `node dist/index.js`.

Replace the paths with:
- `/path/to/notes-mcp`: The absolute path to this project directory
- `/path/to/your/obsidian/vault`: The absolute path to your Obsidian vault

After updating the configuration, restart Claude Desktop. The server will appear as "notes" and provide the `search_notes`, `read_notes`, `list_notes`, `get_links`, `list_tags`, `find_by_tag`, and `list_recent_notes` tools.
