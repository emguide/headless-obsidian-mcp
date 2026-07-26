<p align="center">
  <img src="logo.png" alt="Headless Obsidian MCP" width="140">
</p>

# Headless Obsidian MCP

An [MCP](https://modelcontextprotocol.io) server that gives AI assistants full access to an Obsidian vault — search, the link graph, tags, and structure-aware editing — without needing a running copy of Obsidian.  Ideal for a headless server running your Hermes or OpenClaw agents.

It reduces token cost and removes the need for your agent to understand Obsidian vault conventions, so your agent can read your vault as a knowledge base rather than a folder of text files: `[[wikilinks]]` resolve the way Obsidian resolves them, tags unify inline `#tags` with frontmatter, and edits are surgical (change one section or one tag without rewriting the note). 

**Read-only by default.** Out of the box the server exposes only read tools; writing is opt-in through a single environment variable.

## What it can do

| | |
|---|---|
| [**Find**](docs/TOOLS.md#search) | Literal/regex search via ripgrep ([`search_notes`](docs/TOOLS.md#search_notes)), plus BM25 relevance-ranked full-text search with snippets ([`search_notes_ranked`](docs/TOOLS.md#search_notes_ranked)). Resolve a human name ("Alpha Project") or a date ("yesterday") to a note path ([`resolve_note`](docs/TOOLS.md#resolve_note), [`resolve_daily_note`](docs/TOOLS.md#resolve_daily_note)). |
| [**Browse**](docs/TOOLS.md#notes) | List [notes](docs/TOOLS.md#list_notes), [folders](docs/TOOLS.md#list_folders), [attachments](docs/TOOLS.md#list_files), [tags](docs/TOOLS.md#list_tags), and [frontmatter properties](docs/TOOLS.md#list_properties). Read a note's [outline](docs/TOOLS.md#get_outline) or [one section](docs/TOOLS.md#read_section) without loading the whole thing. |
| [**Traverse**](docs/TOOLS.md#links) | Resolve `[[wikilinks]]` and backlinks ([`get_links`](docs/TOOLS.md#get_links)). Rank the notes most related to a given one — shared tags and link-graph structure, no embeddings ([`get_related_notes`](docs/TOOLS.md#get_related_notes)). |
| [**Query**](docs/TOOLS.md#query_notes) | Filter notes by [frontmatter conditions](docs/TOOLS.md#query_notes) (`eq`, `gt`, `contains`, …), by [tag](docs/TOOLS.md#find_by_tag), or by [recency](docs/TOOLS.md#list_recent_notes). Every note-selecting tool accepts the same [`folder` / `tags` / `where` filters](docs/TOOLS.md#filter-vocabulary). |
| [**Audit**](docs/TOOLS.md#vault) | [Whole-vault stats](docs/TOOLS.md#get_vault_stats), then [drill into](docs/TOOLS.md#list_vault_issues) the actual orphaned notes, broken wikilinks, and dead heading anchors. |
| [**Edit**](docs/TOOLS.md#write-tools) *(opt-in)* | [Create, append, prepend, move, and delete notes](docs/TOOLS.md#creating-and-replacing-notes). Change [a tag](docs/TOOLS.md#add_tag--remove_tag), [a frontmatter field](docs/TOOLS.md#frontmatter-edits), or [one section](docs/TOOLS.md#section-edits) without rewriting the note. [Bulk-edit](docs/TOOLS.md#bulk_edit) many notes in one call. Create, move, and delete [folders](docs/TOOLS.md#create_folder) too. See [Enabling writes](#enabling-writes). |
| [**Protect**](docs/TOOLS.md#guarantees-shared-by-every-write) | [Moving a note](docs/TOOLS.md#move_note) rewrites the wikilinks that point to it; [renaming a heading](docs/TOOLS.md#rename_section) rewrites inbound anchors. Every write [reports any broken links it introduced](docs/TOOLS.md#link-integrity-on-writes). [Deletes](docs/TOOLS.md#delete_note) go to `.trash`. |
| **Sync** *(opt-in)* | If the vault is a git repo, snapshot every write as a commit — optionally pulling and pushing a remote per write or on a background timer. Merge conflicts are resolved non-destructively: your version is always preserved. See [Git safety net](#git-safety-net-obsidian_git_sync). |

Templates from Obsidian's core [Templates plugin](docs/TOOLS.md#templates) are supported (`{{title}}`, `{{date:FORMAT}}`, …); Templater scripting is not.

**[→ Full tool reference](docs/TOOLS.md)** — all 49 tools with parameters and return shapes.

## Quick start

Requires [Node.js](https://nodejs.org/) 20+, [ripgrep](https://github.com/BurntSushi/ripgrep), and an Obsidian vault.

```bash
git clone <this-repo> && cd headless-obsidian-mcp
npm install && npm run build
export OBSIDIAN_VAULT_PATH="/path/to/your/vault"
npm start
```

Then point an MCP client at it. For **Claude Desktop** (`~/.config/claude/claude_desktop_config.json` on macOS/Linux, `%APPDATA%\Claude\claude_desktop_config.json` on Windows):

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "node",
      "args": ["/absolute/path/to/headless-obsidian-mcp/dist/index.js"],
      "env": {
        "OBSIDIAN_VAULT_PATH": "/absolute/path/to/your/vault"
      }
    }
  }
}
```

Restart the client and the server appears as `obsidian`. To let the agent edit the vault, add `"OBSIDIAN_TOOLS": "all"` to that `env` block — see [Enabling writes](#enabling-writes).

Ready-to-copy configs for Claude Desktop, Claude Code, and Docker are in [`examples/`](examples/).

## Configuration

Only `OBSIDIAN_VAULT_PATH` is required. [`.env.example`](.env.example) documents all eight variables the server reads.

> Nothing here loads a `.env` file — an MCP server inherits its environment from the client that spawns it. Set variables in your client's `env` block (or pass `--env-file` to Docker).

### Enabling writes

`OBSIDIAN_TOOLS` selects exactly which tools the server exposes. Unset, it means `reads`: the 24 write tools are hidden from the tool list, and calling one is rejected.

```bash
OBSIDIAN_TOOLS="all"                              # everything
OBSIDIAN_TOOLS="reads,tasks.write,sections.write" # read all; write only tasks and sections
OBSIDIAN_TOOLS="all,-bulk,-delete_note"           # everything except the destructive ones
OBSIDIAN_TOOLS="-templates,-tasks"                # reads, minus two groups
OBSIDIAN_TOOLS="search,notes.read"                # minimal search-and-read agent
```

Selectors are case-insensitive and applied left to right — a plain token adds, a `-` prefix subtracts. Valid tokens are the meta-groups `all` / `reads` / `writes`, a domain group, a mode slice like `notes.write`, or an individual tool name. Evaluation starts from nothing, *unless the first token subtracts*, in which case it starts from `reads` — so `-templates` trims the read surface and can never accidentally expose writes.

The eleven domain groups:

| Group | Read | Write |
|---|---|---|
| `search` | search_notes, search_notes_ranked | — |
| `notes` | read_notes, list_notes, list_recent_notes, resolve_note, resolve_daily_note | write_note, append_note, prepend_note, patch_note, delete_note, move_note |
| `sections` | get_outline, read_section | add_section, append_to_section, replace_section, rename_section |
| `links` | get_links, get_related_notes | — |
| `tags` | list_tags, find_by_tag | add_tag, remove_tag |
| `properties` | get_frontmatter, list_properties, list_property_values, query_notes, get_property | set_frontmatter, add_property_values, remove_property_values, rename_property |
| `tasks` | list_tasks | set_task_state |
| `templates` | list_templates | apply_template, insert_template |
| `files` | list_files, list_folders | move_file, create_folder, move_folder, delete_folder |
| `vault` | get_vault_stats, list_vault_issues | — |
| `bulk` | — | bulk_edit |

`get_config` sits in no group and is always exposed — its `tools` section reports the active policy, so an agent can discover why a tool is missing.

Excluding tools also saves tokens: an excluded tool is a schema the client never carries in context.

An unknown selector, or a policy that selects nothing, aborts startup with the valid vocabulary listed. The policy gates the MCP server only; the query CLI is the operator's own tool and ignores it.

### Git safety net (`OBSIDIAN_GIT_SYNC`)

If your vault is a git repository, the server can snapshot every write:

| Mode | Behavior |
|---|---|
| `off` *(default)* | No git involvement. |
| `commit` | Commits after every write, with a message naming the tool. No remote. |
| `every-write` | Commits, then pulls and pushes the remote after each write. |
| `timer` | Commits per write; pulls and pushes on a background interval instead. |

`OBSIDIAN_GIT_SYNC_INTERVAL` sets the `timer` cadence in seconds (default `300`); `OBSIDIAN_GIT_REMOTE` names the remote (default `origin`).

The guard is **fail-closed**: in any mode but `off`, a write is refused *before* touching disk if the vault isn't a usable git repo, and a failed post-write commit throws — a write never lands without its snapshot. The lone exception is the background timer tick, whose failures are recorded in `get_config`'s `sync.last_error` rather than thrown, since no write is in flight to fail.

**Conflicts are never blocking or destructive.** On a real merge conflict, per file: if both sides changed the note, your version is preserved as a `<note> (conflicted YYYY-MM-DD HHMMSS)` copy and the canonical path takes the remote's; if the remote deleted a note you'd modified, the same copy preserves your version; if you deleted a note the remote modified, the remote version is restored. Find unreconciled copies with `list_vault_issues kind:"conflicts"`.

## Docker

The [`Dockerfile`](Dockerfile) builds a multi-stage `node:20-alpine` image with ripgrep and git installed — both are hard runtime dependencies, not conveniences.

```bash
docker build -t headless-obsidian-mcp .
docker run -i --rm -v "$HOME/vault:/vault:ro" headless-obsidian-mcp
```

`-i` is load-bearing: this is a stdio server, and without an open stdin the transport never comes up. The vault mounts at `/vault` and the container runs as the unprivileged `node` user. For writes, drop `:ro` and add `--user "$(id -u):$(id -g)"` so new files land owned by you. Client config: [`examples/mcp.docker.json`](examples/mcp.docker.json).

There's no `docker-compose.yml` by design — an MCP stdio server is spawned per client, not supervised as a service.

## Development

```bash
npm run dev     # watch mode via tsx, no build step
npm run build   # compile to dist/
npm test        # node:test via tsx
npm run query   # query CLI — see docs/CLI.md
```

`mise run <task>` works for each if you use [mise](https://mise.jdx.dev/).

The [query CLI](docs/CLI.md) calls the tools directly and prints raw JSON, which makes it the fastest way to try something without wiring up a client.

Tests build a throwaway fixture vault in a temp directory and cover link resolution, tag aggregation, listing and recency, index cache invalidation, and the security guards (path traversal, symlink escapes, frontmatter hardening). [CI](.github/workflows/ci.yml) runs build and tests on Node 20 and 22 for every PR and push to `main`, installing real ripgrep and a git identity — the suite drives the actual `rg` binary and real repositories rather than stubs.

Design rationale, tool-naming taxonomy, and the invariants that keep the tool surface coherent live in [CLAUDE.md](CLAUDE.md).

## Agent skill

[`skills/obsidian-vault/SKILL.md`](skills/obsidian-vault/SKILL.md) is a copyable [Agent Skill](https://code.claude.com/docs/en/skills) — drop it in `~/.claude/skills/obsidian-vault/` to give an agent workflow guidance for this server: which tool answers which intent, anti-patterns worth avoiding, and multi-step recipes for fixing broken links, processing the daily note, and restructuring without breaking the graph.

## Acknowledgments

This project began as a Node.js port of [notes-mcp](https://github.com/boazy/notes-mcp) by Boaz Yaniv, and has since been substantially extended with knowledge-base, structure-aware editing, and vault-management tools. The original is MIT licensed; that license and copyright are retained in [LICENSE](LICENSE).

Thanks also to [mcpvault](https://github.com/bitbonsai/mcpvault) by bitbonsai, whose Obsidian MCP server was a useful reference while shaping this project's tool surface.

## License

Released under the [MIT License](LICENSE).
