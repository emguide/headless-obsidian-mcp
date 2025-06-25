# Notes MCP Server

This is an MCP (Model Context Protocol) server for interacting with Obsidian notes. It provides tools to search through and read notes from an Obsidian vault.

## Setup

1. Set the `OBSIDIAN_VAULT_PATH` environment variable to point to your Obsidian vault directory
2. Ensure `ripgrep` (`rg`) is installed on your system
3. Run with: `deno task start` or `mise run start` (if using mise)

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

## Dependencies

- Deno runtime
- ripgrep (`rg`) command-line tool
- @modelcontextprotocol/sdk
- gray-matter (frontmatter parsing)
- @std/path (cross-platform path utilities)

## Development

- `deno task dev` or `mise run dev` - Run in watch mode
- `deno task start` or `mise run start` - Run normally

The project includes a `mise.toml` file for simplified task management with mise.

## Testing

Use the included query CLI tool for testing:

```bash
# Search examples
mise run query search "productivity"                    # Case-insensitive search
mise run query search "TODO" --case-sensitive          # Case-sensitive search  
mise run query search "test" --whole-word               # Whole words only
mise run query search "pattern" --context 10           # Custom context lines

# Read examples
mise run query read "note1" "folder/note2"             # Read multiple notes
mise run query -v search "pattern"                     # Verbose mode
```

## Documentation Updates

**Important**: When updating functionality mentioned in this file or README.md, always update both documentation files accordingly. Only skip documentation updates when testing experimental features that aren't ready for users.