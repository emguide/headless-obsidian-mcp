---
name: obsidian-vault
description: Working in an Obsidian vault through the headless-obsidian-mcp server — which of its 49 tools answers which intent, and the multi-step recipes (fix broken links, process the daily note, bulk-retag a folder, restructure without breaking the graph). Use when the connected MCP server exposes tools like search_notes_ranked, get_links, list_vault_issues, or bulk_edit.
---

# Working an Obsidian vault

The server states its own shared conventions in the MCP `instructions` it sends
at initialize — pagination (`offset`/`limit`/`truncated`), the shared
`folder`/`tags`/`where` filter vocabulary, link-integrity reporting on writes,
opt-in `include_context`, did-you-mean suggestions, git-sync behavior, and tool
exposure. Read those; this skill does not repeat them.

What it adds is the part conventions can't carry: **which tool answers which
intent**, and **how the tools compose into flows**.

## Routing: intent → tool

Reading:

| Intent | Tool |
|---|---|
| "Find something about X" (topical) | `search_notes_ranked` — BM25, best notes first |
| Literal string or regex, every hit | `search_notes` |
| User named a note in prose ("the Alpha Project note") | `resolve_note` — title/alias/basename → path |
| "today's note", a date, "yesterday" | `resolve_daily_note` |
| "What's in this vault?" | `list_folders`, then `list_tags`, then `list_notes` |
| Read a whole note | `read_notes` (batches up to 50) |
| Read *part* of a note | `get_outline`, then `read_section` |
| "What links here / what does this reference?" | `get_links` |
| "I'm looking at X — what else matters?" | `get_related_notes` |
| Notes with a frontmatter condition | `query_notes` |
| Notes carrying a tag | `find_by_tag` |
| "What have I touched lately?" | `list_recent_notes` |
| Outstanding checkboxes | `list_tasks` |
| Vault health | `get_vault_stats`, drill down with `list_vault_issues` |
| "Why is tool X missing?" | `get_config` (always exposed) |

Writing (present only when the operator's `OBSIDIAN_TOOLS` policy exposes them):

| Intent | Tool |
|---|---|
| New note | `write_note`, or `apply_template` for a templated one |
| Add to the end / start | `append_note` / `prepend_note` |
| Add or rewrite one section | `add_section` / `append_to_section` / `replace_section` |
| Change a specific string | `patch_note` |
| Tick or un-tick a checkbox | `set_task_state` |
| Tags | `add_tag` / `remove_tag` |
| Frontmatter | `set_frontmatter`, `add_property_values` / `remove_property_values`, `rename_property` |
| Rename or relocate a note | `move_note` (rewrites inbound wikilinks) |
| Rename a heading | `rename_section` (rewrites inbound `#anchors`) |
| The same change across many notes | `bulk_edit` |
| Remove a note | `delete_note` (trash-safe by default) |
| Create a folder | `create_folder` (invisible to `list_folders` until it holds a note) |
| Rename or relocate a folder | `move_folder` (rewrites inbound folder-qualified links) |
| Remove a folder | `delete_folder` (trash-safe; `recursive:true` if not empty) |

### Anti-patterns

Each of these has a purpose-built tool; reaching for the generic one costs
context or breaks the link graph.

- **Don't** `read_notes` a whole note to change one line. `get_outline` →
  `read_section` → `replace_section` touches a fraction of the tokens.
- **Don't** `search_notes` for `- [ ]`. That's `list_tasks`, which returns
  parsed rows with status, section, and a body-relative line you can hand
  straight to `set_task_state`.
- **Don't** fetch broadly and filter in your head. Every note-selecting tool
  takes `folder`/`tags`/`where` — push the filter into the call.
- **Don't** loop a single-note frontmatter write over 30 notes. That's
  `bulk_edit`: one call, one git snapshot, per-note results.
- **Don't** rename a heading with `patch_note` — it orphans every inbound
  `[[note#heading]]`. Use `rename_section`.
- **Don't** move a note with `move_file` — it rewrites no wikilinks. `move_file`
  is for attachments; `move_note` is for notes.
- **Don't** empty a folder note-by-note to get rid of it. `delete_folder
  recursive:true` takes the subtree in one trash-safe call and reports the
  outside backlinks it dangled; a `delete_note` loop leaves the directory
  behind and gives you N separate reports to reconcile.
- **Don't** reach for `move_file` to relocate a folder's contents. `move_folder`
  moves the whole subtree and rewrites the folder-qualified `[[links]]` into it.
- **Don't** guess a path from a search hit when the user gave you a name.
  `resolve_note` answers exactly, and returns `null` rather than guessing when
  the name is ambiguous.

## Recipes

### Orient in an unfamiliar vault

```
get_vault_stats          → size, tag count, orphans, link health
list_folders depth:1     → the top-level shape
list_tags                → the topic index, by frequency
```

Three calls, no note bodies. Only then `list_notes` scoped to the folder that
actually matters. Reach for `list_notes` unscoped last, not first.

### Find the note the user means

```
resolve_note query:"Alpha Project"
```

- `resolved` set → use it, done.
- `matches` has several → ask which, or disambiguate from their `path`s. The
  tool never picks for you.
- Empty → the name isn't a title, alias, or basename. Fall back to
  `search_notes_ranked` and confirm the top hit before acting on it.

### Fix broken links across the vault

```
list_vault_issues kind:"unresolved_links" include_context:true
```

`include_context` returns the offending line verbatim, grouped by source note —
enough to fix without re-reading anything. Then, per link, decide:

- **Typo'd target** → `patch_note` with the context line's `text` as `find`.
- **Note was renamed by hand** → `resolve_note` on the target to find where it
  went, then `patch_note`.
- **Target never existed** → `write_note` to create the stub, or delete the link.

Run `kind:"broken_anchors"` next: the note resolves but the heading doesn't.
`get_outline` on the *target* shows the real headings; `patch_note` the anchor,
or `rename_section` if the heading is what's wrong.

### Log into the daily note

```
resolve_daily_note                    → { date, path, exists, template }
```

- `exists: true` → `append_to_section` under the right heading, or
  `append_note` if the note has no structure.
- `exists: false` and `template` non-null → `apply_template` with that exact
  `template` value (it is directly consumable), then append.
- `exists: false` and no template → `write_note`.

Note the caveat the server documents: `{{date}}`/`{{time}}` expand with the
current moment, so creating a *past* day's note from a template dates it today.

### Bulk-retag or restage a folder

```
bulk_edit select:{folder:"projects", where:{status:"draft"}} \
          operations:[...] dry_run:true
```

Always `dry_run` first — it shows the match set with zero writes and no git
snapshot. Check the count, then re-run with `dry_run:false` **and**
`expected_count` set to what the preview showed, so a filter that drifted in
between aborts instead of hitting the wrong notes.

Operations apply in order per note, so "rename the key, then set the new one"
is a single call. Per-note failures are isolated and reported; they don't sink
the batch.

### Edit one section safely

```
get_outline path:"projects/alpha"     → headings with full " > " paths
read_section path:… section:…         → current content
replace_section / append_to_section
```

Use the **full heading-path** from the outline (`Projects > Log`) whenever
`ambiguous: true` on the entry. A bare repeated heading fails loud rather than
editing the wrong section — that error is the tool working correctly, so retry
with the qualified path instead of forcing it.

### Work the task list

```
list_tasks status:["open","in_progress"] folder:"projects"
set_task_state path:… text:… status:"done"
```

Address by `text` when it's unique; add `line` when the same text repeats. Both
together is the safe form — the text must match the task found at that line, or
the call errors rather than ticking the wrong box.

### Restructure without breaking the graph

Use the link-aware tool for each structural change, in this order:

1. `move_note` for the file itself — inbound wikilinks are rewritten.
2. `rename_section` for headings — inbound `#anchors` are rewritten.
3. Verify with `list_vault_issues kind:"unresolved_links"` and
   `kind:"broken_anchors"`.

Before a `delete_note`, check `get_links` for backlinks. The delete reports
`dangled_backlinks` but does **not** repair them — that's your follow-up work,
and `include_context:true` gives you the lines to patch.

### Restructure folders safely

Folder operations are the one place where a single call can move or delete an
arbitrary subtree, so they report their git posture rather than assuming it:

```
get_config sync                          → is a git mode actually active?
move_folder from:"projects" to:"archive/projects"
delete_folder path:"archive/2025" recursive:true
```

Read `git_warning` on the result. Non-null means `OBSIDIAN_GIT_SYNC` is off and
there is **no snapshot to roll back to** — the operation still happened. When
that is unacceptable, pass `require_git:true` and the call is refused *before*
touching the filesystem instead.

Two behaviours worth knowing before you plan a restructure. `move_folder`
rewrites only *folder-qualified* links (`[[projects/alpha]]`); bare `[[alpha]]`
links need no rewrite because the basename survives the move. And
`delete_folder`'s `dangled_backlinks`, like `delete_note`'s, is a report — the
linking notes are never repaired for you.

## When something fails

The server is deliberately fail-loud. These errors are informative, not
obstacles:

- **"Ambiguous note name: log. Candidates: …"** — a bare basename shared by
  several notes, on a *write*. Pass the full path. (Readers resolve to the
  shortest-path note instead; writes refuse, since a wrong-note write mutates
  the wrong file.)
- **"Note not found: … Did you mean: …?"** — the suggestion is advisory and
  exact-match only, never fuzzy. A pure typo gets no suggestion; `resolve_note`
  or `search_notes_ranked` is the fallback.
- **Ambiguous heading, with candidates listed** — retry with the `" > "` path.
- **`patch_note`: "occurs N times"** — narrow `find` until unique, or pass
  `all:true` deliberately.
- **A tool you expected isn't in the list** — `get_config section:"tools"`
  reports the active policy and exactly which tools it excludes. This is an
  operator choice; you can't widen it, so tell the user what to set.
- **A write is refused mentioning git** — git sync is enabled and the vault
  isn't a usable repository. Fail-closed by design: nothing was written. This
  needs the operator, not a retry.
