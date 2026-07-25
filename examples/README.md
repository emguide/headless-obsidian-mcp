# MCP client configuration examples

Copy-paste starting points for wiring this server into an MCP client. Every
path in them is a placeholder — replace both absolute paths before use.

These are examples, deliberately **not** live configuration. In particular
there is no `.mcp.json` at the repository root: Claude Code auto-loads a
project-scope `.mcp.json` for anyone who opens the directory, so a checked-in
one would silently attach a server pointing at a vault path that isn't theirs
to everybody working *on* this project. Copy the file to where your client
expects it instead.

| File | Client | Where it goes |
|---|---|---|
| [`mcp.json`](mcp.json) | Claude Code | `.mcp.json` in your own project, or `~/.claude.json` for user scope |
| [`mcp.docker.json`](mcp.docker.json) | Claude Code, via the Docker image | same as above |
| [`claude_desktop_config.json`](claude_desktop_config.json) | Claude Desktop | `~/.config/claude/claude_desktop_config.json` (macOS/Linux), `%APPDATA%\Claude\claude_desktop_config.json` (Windows) |

Build first (`npm install && npm run build`) — the configs point at compiled
output in `dist/`. To skip that step, point `command` at the repository's
`start-server.sh`, which installs and builds on first run, and drop `args`.

## Read-only vs. writes

`mcp.json` and `mcp.docker.json` leave `OBSIDIAN_TOOLS` unset, which is the
read-only default: the write tools are hidden from `list_tools` entirely, so
they cost no context and cannot be called. That is the right starting point.

`claude_desktop_config.json` shows the other end — `OBSIDIAN_TOOLS: "all"`
plus `OBSIDIAN_GIT_SYNC: "commit"`, so every write to the vault lands as a
reviewable, revertable git commit. Enabling writes without git sync is
supported but leaves you no undo beyond `.trash` (which only covers
`delete_note`).

Any selector policy works in that `env` block — `"reads,tasks.write"` for an
agent that can read everything but only tick checkboxes, `"all,-bulk,-delete_note"`
for everything minus the destructive ones. See
[Tool policy](../README.md#tool-policy-obsidian_tools) for the grammar, and
[`.env.example`](../.env.example) for every variable the server reads.

## Docker notes

`mcp.docker.json` assumes you have built the image (`docker build -t
headless-obsidian-mcp .`). The flags are load-bearing:

- `-i` keeps stdin open. This is a stdio server; without it the transport
  never comes up.
- `--rm` cleans up, since the client spawns a fresh container per session.
- `:ro` on the mount matches the read-only default. Drop it when you enable
  write tools, and add `--user "$(id -u):$(id -g)"` so files land owned by you
  rather than by the image's `node` user.

There is no `docker-compose.yml` and no exposed port on purpose — an MCP stdio
server is spawned by its client, not supervised as a service.
