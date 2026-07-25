# Query CLI

A command-line front end to the same tools the MCP server exposes. It calls them directly and prints the raw JSON responses, which makes it the fastest way to try something, debug a vault, or check a tool's actual output shape without wiring up an MCP client.

Runs from the TypeScript sources via `tsx` — **no build step needed**.

```bash
export OBSIDIAN_VAULT_PATH="/path/to/your/vault"
npm run query -- <command> [args]
```

With [mise](https://mise.jdx.dev/), `mise run query -- <command>` is equivalent. Add `--verbose` before the command to print the request being sent:

```bash
npm run query -- --verbose search "pattern"
```

> **The CLI is not gated by `OBSIDIAN_TOOLS`.** That policy protects the agent-facing MCP surface; the CLI is the operator's own tool, so every command below works regardless of the policy — including the write commands.

## Contents

- [Searching](#searching) · [Reading](#reading) · [Browsing](#browsing) · [Links](#links) · [Metadata](#metadata) · [Tasks](#tasks) · [Vault health](#vault-health) · [Config](#config)
- [Writing](#writing)

---

## Searching

```bash
# Literal / regex search (case-insensitive by default)
npm run query -- search "productivity"
npm run query -- search "TODO" --case-sensitive
npm run query -- search "test" --whole-word
npm run query -- search "pattern.*spans.*lines" --multiline
npm run query -- search "pattern" --context 10          # context lines (default 5)
npm run query -- search "productivity" --limit 20 --max-matches 20
npm run query -- search "needle" --limit 20 --offset 20  # second page (files_skipped: 20)

# Scoped by folder, tags, or frontmatter
npm run query -- search "kubernetes" --tag work --match all
npm run query -- search "alpha" --where '{"status":"active"}'

# BM25 relevance-ranked (most relevant notes first)
npm run query -- search-ranked "kubernetes networking"
npm run query -- search-ranked "kubernetes networking" --limit 5
npm run query -- search-ranked "kubernetes" --limit 100 --offset 100   # hits 101-200

# Ranked, scoped
npm run query -- search-ranked "kubernetes" --folder work --tag active --match all
npm run query -- search-ranked "kubernetes" --where '{"status":"active"}'
```

## Reading

```bash
# Read one or more notes -> { notes, errors }; one bad path won't fail the batch
npm run query -- read "daily-notes/2024-01-15"
npm run query -- read "note1" "folder/note2"

# Heading outline, and a single section
npm run query -- outline "projects/alpha"
npm run query -- read-section "projects/alpha" "Log"
npm run query -- read-section "projects/alpha" "Projects > Log" --include-subsections
```

## Browsing

```bash
# Note headers (no contents)
npm run query -- list
npm run query -- list --folder projects --limit 20
npm run query -- list --tag work --match all --where '{"status":"active"}'
npm run query -- list --limit 20 --offset 20             # second page

# Folder tree with note counts
npm run query -- folders
npm run query -- folders --folder projects --depth 1

# Non-markdown files (attachments, images)
npm run query -- files --folder assets --extension png

# Most recently modified, or by a frontmatter date field
npm run query -- recent --limit 10
npm run query -- recent --date-field updated --since 2026-07-01
npm run query -- recent --folder work --tag active --where '{"status":"active"}'

# Tags with counts, and notes by tag
npm run query -- tags
npm run query -- find-by-tag productivity
npm run query -- find-by-tag productivity project --all   # requires every tag
npm run query -- find-by-tag work --folder projects --where '{"status":"active"}'

# Resolve a human name or a date to a note path
npm run query -- resolve "Alpha Project"
npm run query -- daily                    # today
npm run query -- daily yesterday
npm run query -- daily 2026-07-01

# Templates in the configured template folder
npm run query -- templates
```

## Links

```bash
# Outbound links, unresolved links, and backlinks
npm run query -- links "projects/alpha"
npm run query -- links "projects/alpha" --include-context   # with the linking lines

# Notes most related to a given one (ranked, with reasons)
npm run query -- related "projects/alpha"
npm run query -- related "projects/alpha" --limit 5
npm run query -- related "projects/alpha" --folder work --tag active
```

## Metadata

```bash
# Frontmatter of one note, or one property
npm run query -- frontmatter "projects/alpha"
npm run query -- get-property "projects/alpha" status

# The vault's frontmatter schema, and one key's distinct values
npm run query -- properties
npm run query -- property-values status

# Query by frontmatter condition
npm run query -- query --where '{"status":"active","priority":{"gt":3}}'
npm run query -- query --where '{"status":"active"}' --folder projects --tag work
```

## Tasks

```bash
npm run query -- tasks
npm run query -- tasks --folder projects --status open
npm run query -- tasks --tag work --status open in_progress
```

## Vault health

```bash
# Whole-vault statistics
npm run query -- stats

# Drill down from a stat into the actual rows
npm run query -- vault-issues orphans
npm run query -- vault-issues unresolved_links --limit 50
npm run query -- vault-issues unresolved_links --include-context
npm run query -- vault-issues broken_anchors --limit 50
npm run query -- vault-issues conflicts
```

## Config

```bash
npm run query -- config             # everything
npm run query -- config template    # template folder + date/time formats
npm run query -- config daily       # Daily Notes folder/format/template
npm run query -- config tools       # active tool policy: exposed/excluded
npm run query -- config sync        # git-sync mode/interval/remote/last_sync/last_error
npm run query -- config vault       # configured vault path
npm run query -- config writes      # writes_enabled + git_sync mode
```

---

## Writing

```bash
# Create a note (inline, from a file, or from stdin)
npm run query -- write "inbox/idea" "# Idea\n\nbody"
npm run query -- write "inbox/idea" --file draft.md --overwrite

# Append / prepend (prepend inserts after any frontmatter)
npm run query -- append "daily/2026-07-22" "one more thing"
npm run query -- prepend "daily/2026-07-22" "> top banner"

# Tags and frontmatter — no whole-note rewrite
npm run query -- add-tag "projects/alpha" project active
npm run query -- remove-tag "projects/alpha" stale
npm run query -- set-frontmatter "projects/alpha" --set status=done --unset draft
npm run query -- add-property-values "projects/alpha" aliases a2 a3
npm run query -- remove-property-values "projects/alpha" aliases a3
npm run query -- rename-property "projects/alpha" author authors

# Sections
npm run query -- add-section "projects/alpha" "Next steps" "- ship it"
npm run query -- append-to-section "projects/alpha" "Log" "did a thing"
npm run query -- replace-section "projects/alpha" "Summary" "new summary"
npm run query -- rename-section "projects/alpha" "Old Heading" "New Heading"
npm run query -- rename-section "projects/alpha" "Old" "New" --no-update-anchors

# Literal find/replace
npm run query -- patch "projects/alpha" "old text" "new text"
npm run query -- patch "projects/alpha" "TODO" "DONE" --all

# Checkbox task state (by text and/or line)
npm run query -- set-task-state "projects/alpha" --text "ship it" --status done
npm run query -- set-task-state "projects/alpha" --line 12 --status in_progress

# Move / rename a note (rewrites the wikilinks pointing to it)
npm run query -- move "projects/alpha" "archive/alpha"
npm run query -- move "projects/alpha" "archive/alpha" --no-update-links

# Move an attachment; no link rewriting
npm run query -- move-file "assets/old.png" "assets/new.png"

# Templates
npm run query -- template-apply "Daily" "journal/2026-07-23"
npm run query -- template-insert "Meeting" "journal/2026-07-23" \
  --position section --section Notes --create-section

# Bulk frontmatter edit (one git snapshot for the batch)
npm run query -- bulk-edit --select '{"where":{"status":"draft"}}' \
  --operations '[{"op":"add_tag","tags":["review"]},{"op":"set_frontmatter","set":{"status":"active"}}]' \
  --dry-run

# Delete (trash-safe by default; recoverable from .trash)
npm run query -- delete "inbox/idea"
npm run query -- delete "inbox/idea" --permanent
npm run query -- delete "inbox/idea" --include-context
```

### Content that begins with `-`

Markdown lists would be parsed as flags. Pipe them via stdin, or use `--file`:

```bash
printf -- '- one\n- two' | npm run query -- add-section "projects/alpha" "Todo"
```

### Committing writes to git

Set the mode inline to snapshot a write (see [Git safety net](../README.md#git-safety-net-obsidian_git_sync)):

```bash
OBSIDIAN_GIT_SYNC=commit npm run query -- add-tag "projects/alpha" review
```

The legacy `OBSIDIAN_GIT_AUTOCOMMIT=1` still works, but warns and maps to `commit`.
