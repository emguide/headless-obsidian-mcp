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
```

(With mise: `mise run query -- search "productivity"`, etc.)

## Documentation Updates

**Important**: When updating functionality mentioned in this file or README.md, always update both documentation files accordingly. Only skip documentation updates when testing experimental features that aren't ready for users.