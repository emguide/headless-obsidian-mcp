# Notes MCP Server

An MCP (Model Context Protocol) server for interacting with Obsidian notes. This server provides tools to search through and read notes from your Obsidian vault, making your knowledge base accessible to AI assistants.

## Features

- **Search Notes**: Full-text search through your Obsidian vault using ripgrep
- **Read Notes**: Parse and extract content, metadata, and tags from notes
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

After updating the configuration, restart Claude Desktop. The server will appear as "notes" and provide the `search_notes` and `read_notes` tools.
