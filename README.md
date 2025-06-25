# Notes MCP Server

An MCP (Model Context Protocol) server for interacting with Obsidian notes. This server provides tools to search through and read notes from your Obsidian vault, making your knowledge base accessible to AI assistants.

## Features

- **Search Notes**: Full-text search through your Obsidian vault using ripgrep
- **Read Notes**: Parse and extract content, metadata, and tags from notes
- **Cross-platform**: Works on Windows, macOS, and Linux
- **Frontmatter Support**: Extracts YAML frontmatter as structured metadata
- **Tag Extraction**: Automatically identifies and extracts Obsidian tags

## Prerequisites

- [Deno](https://deno.land/) runtime
- [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg` command)
- An Obsidian vault with markdown files

## Setup

1. Clone or download this project
2. Set the `OBSIDIAN_VAULT_PATH` environment variable:
   ```bash
   export OBSIDIAN_VAULT_PATH="/path/to/your/obsidian/vault"
   ```
3. Run the server:
   ```bash
   # Using Deno directly
   deno task start
   
   # Using mise (if you have mise installed)
   mise run start
   ```

## Development

For development with file watching:

```bash
# Using Deno
deno task dev

# Using mise
mise run dev
```

## Testing

You can test the MCP server using the included query CLI tool:

```bash
# Search for notes containing a pattern (case-insensitive by default)
mise run query search "productivity"

# Case-sensitive search
mise run query search "TODO" --case-sensitive

# Search for whole words only
mise run query search "test" --whole-word

# Multiline search
mise run query search "pattern.*spans.*lines" --multiline

# Search with custom context lines (default: 5)
mise run query search "pattern" --context 10

# Read specific notes
mise run query read "daily-notes/2024-01-15"
mise run query read "note1" "folder/note2"

# Use verbose mode to see the request being sent
mise run query -v search "pattern"
mise run query --verbose read "note1"
```

The query tool connects to the MCP server and returns the raw JSON responses, making it useful for testing and debugging.

## Tools

### search_notes

Search through markdown files in your vault using ripgrep patterns.

**Parameters:**
- `pattern` (string, required): Search pattern for ripgrep
- `flags` (array, optional): Additional ripgrep flags

**Returns:** Array of search results with:
- `path`: Relative note path (without .md extension)
- `matches`: Array of matches with line numbers and context

### read_notes

Read and parse one or more notes from your vault.

**Parameters:**
- `paths` (array, required): Array of relative note paths (with or without .md extension)

**Returns:** Array of note objects with:
- `name`: Note name (relative path without .md extension)
- `contents`: Markdown content (without frontmatter and tags)
- `metadata`: Parsed frontmatter as JSON object
- `tags`: Array of extracted Obsidian tags

## Example Usage

Once connected to an MCP client, you can:

```javascript
// Search for notes containing "productivity"
await search_notes({
  pattern: "productivity",
  flags: ["-i"] // case-insensitive
});

// Read specific notes
await read_notes({
  paths: ["daily-notes/2024-01-15", "projects/my-project"]
});
```

## Configuration

The server requires the `OBSIDIAN_VAULT_PATH` environment variable to be set to your Obsidian vault directory.

## Claude Desktop Integration

To use this MCP server with Claude Desktop, add it to your Claude configuration file:

**macOS/Linux**: `~/.config/claude/claude_desktop_config.json`
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "notes": {
      "command": "deno",
      "args": [
        "run",
        "--allow-read=/path/to/your/obsidian/vault",
        "--allow-run=rg",
        "--allow-env=OBSIDIAN_VAULT_PATH",
        "src/index.ts"
      ],
      "cwd": "/path/to/notes-mcp",
      "env": {
        "OBSIDIAN_VAULT_PATH": "/path/to/your/obsidian/vault"
      }
    }
  }
}
```

**Using mise (recommended if you have mise installed):**
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

This uses the included `start-server.sh` script which handles changing to the project directory and running `mise run start`.

Replace the paths with:
- `/path/to/notes-mcp`: The absolute path to this project directory
- `/path/to/your/obsidian/vault`: The absolute path to your Obsidian vault

After updating the configuration, restart Claude Desktop. The server will appear as "notes" and provide the `search_notes` and `read_notes` tools.

