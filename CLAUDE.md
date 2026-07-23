# Headless Obsidian MCP

This is a headless MCP (Model Context Protocol) server for interacting with Obsidian vaults. It provides tools to search, read, navigate the link graph, and edit notes in an Obsidian vault — without the Obsidian GUI.

## Development workflow

Anything beyond trivial work (a single-line fix or a pure question) should be done in a git worktree, so parallel development tasks stay isolated from each other and from the main checkout. Trivial changes may be made in place.

## Setup

1. Set the `OBSIDIAN_VAULT_PATH` environment variable to point to your Obsidian vault directory
2. Ensure `ripgrep` (`rg`) is installed on your system
3. Install dependencies and build: `npm install && npm run build`
4. Run with: `npm start` or `mise run start` (if using mise)

## Tools

### Naming conventions

Tool names follow a fixed verb taxonomy. A new tool reuses an existing verb; it does not coin a synonym. The verb encodes the tool's scope and addressing so an agent can predict behavior from the name alone.

- **`get_`** — return one addressed thing: a note by path (`get_links`, `get_outline`, `get_frontmatter`, `get_property`, `get_related_notes`), or the vault as a single object (`get_vault_stats`). A collection-valued return is fine when it is *about* one addressed note (`get_related_notes`); it is not `get_` when it enumerates a vault-wide collection — that is `list_`.
- **`list_`** — enumerate a vault-wide collection, optionally scoped or parameterized: `list_notes`, `list_files`, `list_folders`, `list_tags`, `list_properties`, `list_property_values`, `list_recent_notes`, `list_vault_issues`. A required argument does not demote it to `get_` (`list_property_values(key)`, `list_vault_issues(kind)`).
- **`search_`** — text query over content (`search_notes`, `search_notes_ranked`). **`read_`** — return body text from disk (`read_notes`, `read_section`). **`resolve_`** — map a human name to a canonical path (`resolve_note`).
- **`find_by_X`** — retrieval by one named criterion (`find_by_tag`). **`query_`** — retrieval by a condition object (`query_notes`); `where` is the single condition language, anchored by `query_notes`, and reused verbatim by every tool that filters notes.
- **Writes** name the mutation: `write/append/prepend/delete/move`, `add/remove_tag`, `set_frontmatter`, `add/remove_property_values`, `rename_property`, `add/append_to/replace_section`, `patch_note`, `bulk_edit`. The `_property_values` noun is per-note when prefixed `add_`/`remove_` (writes) and vault-wide when prefixed `list_` (read) — the verb, not the noun, carries the scope.

**No merges.** `list_notes` / `find_by_tag` / `query_notes` / `list_recent_notes` are distinct intents, not one query tool: `find_by_tag` matches the unified inline-plus-frontmatter tag set while `query_notes` sees frontmatter only, and `list_recent_notes` carries ordering semantics (`date_field`, mtime) that `query_notes` has no vocabulary for. The separation is structural.

**Extending the surface.** A new note-selecting tool reuses the `folder` / `tags` / `where` / `match` filter vocabulary rather than inventing its own. A new vault-hygiene finding becomes a `kind` of `list_vault_issues`, not a new tool.

**Filter vocabulary (shared).** Every note-selecting tool — `search_notes`,
`search_notes_ranked`, `list_notes`, `list_recent_notes`, `find_by_tag`,
`query_notes`, `get_related_notes`, and `bulk_edit.select` — accepts the same
optional candidate filters, resolved from the shared index by
`resolveCandidates` (`src/tools/candidate-filter.ts`): `folder` (path prefix),
`tags` (with `match` `"any"` default / `"all"`), and `where` (frontmatter
conditions, `query_notes` syntax). An absent filter imposes no constraint, so
adding them is additive. On a tool whose *primary* filter is already tags
(`find_by_tag`) or where (`query_notes`), `match` governs that primary filter
and the added secondary filter applies with its own default (tags: `any`,
where: `all`) — mirroring `search_notes`. This keeps a scoped question ("active
notes in `projects/` tagged `#work`") a single call instead of a
fetch-wide-then-filter-in-context join. Each tool preserves its distinct core
(unified tag set, ordering, frontmatter conditions, relatedness scoring); they
differ only in intent, not in what they can be scoped by. To keep the tool list
small, this convention is stated once in the server's MCP `instructions`
(`src/index.ts`); tool descriptions note only their deviations.

**Link-integrity on writes (shared).** Every content-writing tool —
`write_note`, `append_note`, `prepend_note`, `patch_note`, `add_section`,
`append_to_section`, `replace_section` — returns, alongside its normal fields,
`unresolved_links` (wikilink targets in the *resulting* note that resolve to no
vault note) and `broken_anchors` (`[[note#heading]]` links whose note resolves
but whose heading anchor matches nothing, as `{ target, anchor }`). Both are
computed from the exact content just written via `linkHealthOf`
(`src/tools/link-health.ts`), reusing the same predicates as
`list_vault_issues`' `unresolved_links` / `broken_anchors` kinds. **Report-only**
(same philosophy as `delete_note`'s `dangled_backlinks`): the write is never
blocked or modified — the agent simply learns immediately when it introduces a
broken `[[wikilink]]` instead of discovering it later via `list_vault_issues`.
The report covers the whole resulting note (not just the changed span), and
empty arrays mean the write left the graph intact. Stated once in the server's
MCP `instructions`; write-tool descriptions carry only a short pointer.

**Pagination (`offset`).** Every envelope-returning tool (all the list-style
tools plus `search_notes` and `search_notes_ranked`) accepts an optional
`offset` (default `0`): the rows are a window `[offset, offset + limit)` over the
full result set. The envelope reports both edges of what was dropped —
`skipped` (rows before the window, the effect of `offset`) and `omitted` (rows
after it, the effect of `limit`) — so `total = skipped + returned + omitted` and
`truncated` (`omitted > 0`) still answers "is there a next page?". An `offset`
past the end is not an error (empty `results`, `skipped = total`). `offset` must
be a non-negative integer. `search_notes` uses the parallel field names
`files_skipped` / `files_omitted` over files. `search_notes_ranked` keeps its
100-row cap on a single `limit`, but `offset` pages past it — `offset: 100,
limit: 100` returns ranked hits 101–200 without re-fetching via `limit: 0`.
To keep the agent-facing tool list small, this convention is stated once in the
server's MCP `instructions` (sent to clients at initialize, `src/index.ts`);
individual tool descriptions state only their deviations from it.

### search_notes
- **Purpose**: Search through markdown files in the vault using ripgrep
- **Input**: 
  - `pattern` (required): Search pattern for ripgrep (max 1000 chars)
  - `case_sensitive` (optional): Case sensitive search (default: false)
  - `whole_word` (optional): Match whole words only
  - `multiline` (optional): Enable multiline matching
  - `context_lines` (optional): Number of context lines to show (default: 5, max: 100)
  - `limit` (optional): Max number of files to return (default: 20, `0` = unlimited — no hard maximum)
  - `max_matches_per_file` (optional): Max matches per file (default: 20, `0` = unlimited)
  - `offset` (optional): Matching files to skip before the window, for pagination (default `0`; reported as `files_skipped`)
  - `folder` (optional): Restrict to notes under this folder (relative to the vault root)
  - `tags` (optional): Restrict to notes carrying these tags (leading `#` optional)
  - `match` (optional): Semantics of `tags` — `"any"` (default) or `"all"`
  - `where` (optional): Restrict to notes whose frontmatter satisfies these conditions (same syntax as `query_notes`)
- **Output**: `{ results, truncated, files_returned, files_skipped, files_omitted, matches_capped_in }` — `results` is the array of matches (file paths without .md, plus context lines), bounded by the caps above; `files_skipped` is the number of matching files skipped before the window by `offset`, `files_omitted` the number dropped after it by `limit`; the fields report what was dropped so a truncated result isn't mistaken for a complete one (skipping forward via `offset` does not set `truncated`).
- **Filtering**: When `folder`/`tags`/`where` are given, the candidate note set is resolved from the shared index first, then ripgrep runs only over those files (chunked to stay under `ARG_MAX` on large vaults) instead of scanning the whole vault. A filter that matches zero notes short-circuits to an empty result without invoking ripgrep at all.
- **Security**: Protected against flag injection and regex DoS attacks

### search_notes_ranked
- **Purpose**: Full-text search ranked by BM25 relevance — the most relevant notes first, rather than every literal match. Complements `search_notes` (which is literal/regex and unranked).
- **Input**:
  - `query` (required): Free-text query (max 1000 chars). Multi-word queries are ranked by relevance.
  - `limit` (optional): Maximum number of results (default 100; `limit: 0` = unbounded; a positive limit is capped at 100)
  - `offset` (optional): Ranked hits to skip before the window, for pagination (default `0`). With the 100-row cap, `offset: 100` reaches hits 101–200 without `limit: 0`.
  - `folder` (optional): Restrict to notes under this folder (relative to the vault root)
  - `tags` (optional): Restrict to notes carrying these tags (leading `#` optional)
  - `match` (optional): Semantics of `tags` — `"any"` (default) or `"all"`
  - `where` (optional): Restrict to notes whose frontmatter satisfies these conditions (same syntax as `query_notes`)
- **Output**: `{ results, returned, skipped, omitted, truncated }` — `results` is the array of ranked note headers (same shape as `list_notes`) extended with `score` (BM25 relevance, higher = more relevant) and `snippet` (a short matched excerpt); the other fields report what was dropped so a truncated result isn't mistaken for a complete one.
- **Ranking**: Standard Okapi BM25 (`k1=1.2`, `b=0.75`) over a stemmed, stopword-filtered token stream. Title, heading, and tag terms are boosted (indexed at ×2 weight) so a title hit outranks a passing body mention. Built on the shared in-memory vault index — no per-query vault scan. Scopes to a candidate set via the same `folder`/`tags`/`where`/`match` filters as `search_notes` (resolved from the shared index first, then ranked over just those notes), so "the most relevant note about X among my work notes" is expressible.
- **Limitation**: Tokenization is ASCII/English-oriented (lowercased, split on non-alphanumeric, Porter-stemmed), so non-Latin scripts (e.g. CJK) and accented characters are not well indexed for ranked search. Use `search_notes` (ripgrep) for literal non-ASCII matching.

### read_notes  
- **Purpose**: Read and parse one or more notes
- **Input**: `paths` - Array of relative note paths (with or without .md extension, max 50 notes)
- **Output**: `{ notes, errors }`
  - `notes`: Array of note objects for every path that was read successfully, each with:
    - `path`: Relative path without .md suffix (same identity field as the header tools)
    - `contents`: Markdown body verbatim (frontmatter block removed, but body text — including inline `#tags` — is returned unmodified so `patch_note` can match against it)
    - `frontmatter`: Parsed frontmatter as JSON object (same field name as `get_frontmatter`)
    - `tags`: The note's full tag set — frontmatter `tags:` unified with inline `#tags` (same extraction as `list_tags`/`find_by_tag`)
  - `errors`: `[{ path, error }]` — one entry per requested path that could not be read (missing or too large), so one bad path in a batch no longer fails the whole call
- **Security**: Protected against path traversal attacks, with file size limits (10MB per note). A path-traversal attempt still errors the entire call (unlike a missing/oversized file, which is reported per-path in `errors`).

### list_notes
- **Purpose**: Discover what exists in the vault. Returns lightweight note headers (no full contents), so an agent can orient itself before searching or reading.
- **Input**:
  - `folder` (optional): Restrict to notes under this folder (relative to the vault root)
  - `tags` (optional): Restrict to notes carrying these tags (leading `#` optional)
  - `match` (optional): Semantics of `tags` — `"any"` (default) or `"all"`
  - `where` (optional): Restrict to notes whose frontmatter satisfies these conditions (same syntax as `query_notes`; all conditions apply)
  - `limit` (optional): Maximum number of notes to return (default `100`; pass `0` for unbounded — no cap)
  - `offset` (optional): Rows to skip before the window, for pagination (default `0`; skipping past the end returns an empty result, not an error)
- **Output**: `{ results, returned, skipped, omitted, truncated }` — `results` is the array of note headers (`path`, `title` (frontmatter title or basename), `tags`, `headline` (first markdown heading), `size`, `modified` (ISO timestamp)), bounded by `limit` (default `100`); `returned` is `results.length`, `omitted` is the number of notes dropped by the limit, and `truncated` is `true` when `omitted > 0` — so a capped first-orientation call isn't mistaken for a complete one.

### get_links
- **Purpose**: Resolve the Obsidian link graph for a note, turning the flat vault into a navigable graph.
- **Input**: `path` (required) - Relative note path (with or without .md extension)
- **Output**: Object with:
  - `note`: The canonical path of the inspected note
  - `outbound_links`: Resolved `[[wikilinks]]` (each with the raw `target` and resolved `path`)
  - `unresolved_links`: Wikilink targets that do not resolve to any note
  - `backlinks`: Notes elsewhere in the vault that link to this one
- **Notes**: Handles `[[note]]`, `[[note|alias]]`, `[[note#heading]]`, and `![[embeds]]`. Links resolve by full relative path or by basename (Obsidian's default). When a bare `[[basename]]` matches several notes, it resolves to the one closest to the vault root (fewest path segments), ties broken alphabetically — matching Obsidian's shortest-path rule, so a bare link points to the same note vault-wide regardless of where it appears.
- **Security**: Path traversal protected via the same guard as read_notes.

### get_outline
- **Purpose**: A note's heading structure without its body — the outline. Closes the "check what sections exist, then edit the right one" loop without reading the whole note.
- **Input**: `path` (required) - Relative note path (with or without `.md`)
- **Output**: `{ path, outline }` where each outline entry is `{ heading, level, path, line, ambiguous }`. `path` is the full `" > "`-joined heading-path (e.g. `Projects > Log`) — the disambiguating address; `line` is 1-based; `ambiguous` is `true` when the bare heading text repeats in the note. Index-backed (no file read); headings inside fenced code blocks are excluded.
- **Security**: Path traversal protected via the same guard as read_notes.

### read_section
- **Purpose**: Read a single section of a note without loading the whole note — the read-side complement of `append_to_section`/`replace_section`.
- **Input**: `path` (required), `section` (required — a bare heading, or a `" > "`-joined heading-path like `Projects > Log`), `include_subsections` (optional, default `false`)
- **Output**: `{ path, section, level, content }`. `section` is the resolved full heading-path; `content` is the heading line plus its own body (nested subsections excluded unless `include_subsections` is set). Frontmatter is never included.
- **Addressing**: A bare heading resolves when unique; an ambiguous bare heading errors loudly, listing the candidate full paths so you can retry with the exact one (mirrors `patch_note`'s fail-loud behavior). Reads the file at call time (the index does not retain body text).
- **Security**: Path traversal protected via the same guard as read_notes.

### list_tags
- **Purpose**: Show the vault's topic index. Returns every tag with the number of notes using it, sorted by frequency.
- **Input**:
  - `offset` (optional): Rows to skip before the window, for pagination (default `0`)
- **Output**: `{ results, returned, skipped, omitted, truncated }` — `results` is the array of `{ tag, count }`, unifying inline `#tags` (including nested `#parent/child`) and frontmatter `tags:`. There is no `limit`, so `truncated` is always `false` and `omitted` is always `0`; `offset`/`skipped` still let you page through the full set.

### find_by_tag
- **Purpose**: High-precision retrieval by human curation.
- **Input**:
  - `tags` (required): Array of tags to match (with or without leading `#`)
  - `match` (optional): `"any"` (default) or `"all"` — governs the tag set only
  - `folder` (optional): Restrict to notes under this folder (relative to the vault root)
  - `where` (optional): Additional frontmatter conditions (same syntax as `query_notes`); all must hold
  - `limit` (optional): Maximum number of notes to return (default 100; `limit: 0` = unbounded)
  - `offset` (optional): Rows to skip before the window, for pagination (default `0`; skipping past the end returns an empty result, not an error)
- **Output**: `{ results, returned, skipped, omitted, truncated }` — `results` is the array of note headers (same shape as `list_notes`), bounded by `limit` (default `100`). `returned` is `results.length`, `omitted` is the number of notes dropped by the limit, and `truncated` is `true` when `omitted > 0`.

### list_recent_notes
- **Purpose**: Find current material. Returns notes ordered by recency (newest first).
- **Input**:
  - `limit` (optional): Maximum number of notes to return (default 100; `limit: 0` = unbounded)
  - `offset` (optional): Rows to skip before the window, for pagination (default `0`; skipping past the end returns an empty result, not an error)
  - `since` (optional): Only include notes on or after this ISO date
  - `date_field` (optional): Frontmatter field to sort by instead of filesystem mtime (e.g. `updated`)
  - `folder` (optional): Restrict to notes under this folder (relative to the vault root)
  - `tags` (optional): Restrict to notes carrying these tags (leading `#` optional)
  - `match` (optional): Semantics of `tags` — `"any"` (default) or `"all"`
  - `where` (optional): Frontmatter filters, e.g. `{ "status": "active" }` or `{ "priority": { "gt": 3 } }` (same condition syntax as `query_notes`; matches array members too)
- **Output**: `{ results, returned, skipped, omitted, truncated }` — `results` is the array of note headers (same shape as `list_notes`), bounded by `limit` (default `100`). `returned` is `results.length`, `omitted` is the number of notes dropped by the limit, and `truncated` is `true` when `omitted > 0`.

### get_related_notes
- **Purpose**: Associative recall. Rank the notes most related to a given note, so an agent can ask "I'm looking at X — what else is relevant?" No embeddings or model: a transparent weighted blend of signals already held in the shared index.
- **Input**:
  - `path` (required): Relative note path (with or without `.md`)
  - `folder` (optional): Restrict the scored candidate pool to notes under this folder
  - `tags` (optional): Restrict candidates to notes carrying these tags (leading `#` optional)
  - `match` (optional): Semantics of `tags` — `"any"` (default) or `"all"`
  - `where` (optional): Restrict candidates to notes whose frontmatter satisfies these conditions (same syntax as `query_notes`)
  - `limit` (optional): Maximum number of related notes to return (default 100; `limit: 0` = unbounded)
  - `offset` (optional): Rows to skip before the window, for pagination (default `0`; skipping past the end returns an empty result, not an error)
- **Scoring**: direct link either direction (weight 4), each shared tag (3), each shared out-link / co-reference (2), each shared backlink / co-citation (2). Notes with no connecting signal are omitted; ties break by path. The `folder`/`tags`/`where`/`match` filters scope the candidate pool that gets scored (the source note is never itself a candidate), so "what work notes relate to X?" is one call.
- **Output**: `{ results, returned, skipped, omitted, truncated }` — `results` is the array of note headers (same shape as `list_notes`) extended with `score`, `reasons`, `shared_tags`, `shared_links`, `shared_backlinks`, and `linked`, bounded by `limit` (default `100`). `returned` is `results.length`, `omitted` is the number of related notes (those with a connecting signal) dropped by the limit, and `truncated` is `true` when `omitted > 0`.
- **Security**: Path traversal protected via the same guard as read_notes.

### get_frontmatter
- **Purpose**: Read just a note's parsed frontmatter (YAML metadata), without its body — a cheap way to inspect a note's status, aliases, dates, or custom fields before reading or editing the whole note.
- **Input**: `path` (required) - Relative note path (with or without `.md`)
- **Output**: `{ path, frontmatter }` where `frontmatter` is the parsed YAML as a JSON object (empty when the note has none).
- **Security**: Path traversal protected via the same guard as read_notes.

### get_vault_stats
- **Purpose**: Summarize the whole vault in one call. Derived entirely from the shared index (no extra file reads).
- **Input**: none
- **Output**: `{ notes, total_size_bytes, distinct_tags, tag_assignments, tagged_notes, untagged_notes, resolved_links, unresolved_links, notes_with_links, orphan_notes, last_modified, first_modified }`. `orphan_notes` counts notes with no inbound and no outbound resolved links; the modification bounds are ISO timestamps (`null` for an empty vault).

### list_vault_issues
- **Purpose**: Vault-hygiene findings the index already knows about but that `get_vault_stats` only counts — the drill-down from a stat to the actual rows.
- **Input**: `kind` (required): `"orphans"`, `"unresolved_links"`, or `"broken_anchors"`. `limit` (optional): Cap on the number of returned rows/groups (default `100`; pass `0` for unbounded — no cap). `offset` (optional): Rows/groups to skip before the window, for pagination (default `0`).
- **Output**: `{ results, returned, skipped, omitted, truncated }`. `results`' shape depends on `kind`:
  - `"orphans"`: Array of note headers (same shape as `list_notes`) for notes with no inbound and no outbound resolved links — the exact predicate `get_vault_stats` uses for `orphan_notes`.
  - `"unresolved_links"`: Array of `{ source, targets }` grouped by source note — `source` is the note path, `targets` is the raw wikilink targets in that note that resolve to nothing. `returned`/`omitted`/`truncated` for this kind count **groups (source notes), not individual targets**.
  - `"broken_anchors"`: `[[note#heading]]` links whose target note resolves but whose heading anchor matches no heading in that note — the complement of `unresolved_links` ("note resolves, heading doesn't"). Array of `{ source, targets: [{ target, anchor }] }` grouped by source note, same truncation semantics as `unresolved_links` (counts groups, not individual anchors). Block-ref anchors (`#^id`) and links to unresolved notes are excluded.
  `returned` is `results.length`, `omitted` is the number of rows/groups dropped by the limit, and `truncated` is `true` when `omitted > 0`.
- **Count relationship**: for the full/unbounded result (`limit: 0`, or the default when the row/group count is ≤ 100), `orphans`' `results.length` equals `get_vault_stats`'s `orphan_notes`; the sum of every `targets` array length under `unresolved_links`'s `results` equals `get_vault_stats`'s `unresolved_links` count. A group-limited result naturally shows fewer.
- **Notes**: Index-backed (no file read).

### list_files
- **Purpose**: List non-markdown files in the vault (attachments, images, PDFs) — the counterpart to `list_notes` for everything `list_notes` deliberately excludes.
- **Input**: `folder` (optional): Restrict to files under this folder (relative to the vault root). `extension` (optional): Filter by extension, leading dot optional and case-insensitive (e.g. `png` or `.PNG`). `limit` (optional): Maximum number of files to return (default `100`; pass `0` for unbounded — no cap). `offset` (optional): Rows to skip before the window, for pagination (default `0`).
- **Output**: `{ results, returned, skipped, omitted, truncated }` — `results` is the array of file entries (`path`, `size`, `modified`, `extension`), bounded by `limit` (default `100`); `path` is vault-relative with the extension preserved (unlike note paths, `.md` is never stripped here because these aren't notes), `modified` is an ISO timestamp, `extension` is lowercased without the dot. `returned` is `results.length`, `omitted` is the number of files dropped by the limit, and `truncated` is `true` when `omitted > 0`.
- **Notes**: Markdown files are never returned. Reuses the same directory walk and ignore rules as the vault index, but does not read from or write to the index itself.

### list_folders
- **Purpose**: Enumerate the vault's folders so an agent can see the shape of the vault before searching or reading — the folder-level counterpart to `list_notes` (notes) and `list_files` (attachments). Closes the folder-discovery gap that otherwise forces an unbounded `list_notes`.
- **Input**:
  - `folder` (optional): Restrict to folders under this folder (relative to the vault root).
  - `depth` (optional): Relative depth cap — `1` = immediate children of the scope (top-level folders when no `folder` is given).
  - `limit` (optional): Maximum number of folders to return (default `100`; pass `0` for unbounded).
  - `offset` (optional): Rows to skip before the window, for pagination (default `0`; skipping past the end returns an empty result, not an error)
- **Output**: `{ results, returned, skipped, omitted, truncated }` — `results` is the array of `{ path, notes, total_notes, subfolders }` sorted by `path`. `notes` counts notes directly in the folder; `total_notes` counts notes recursively under it (including subfolders); `subfolders` counts direct child folders. `returned`/`omitted`/`truncated` report what the `limit` dropped.
- **Notes**: Index-backed (no extra file read); notes-only, so a folder containing only attachments does not appear (use `list_files`). Root-level notes contribute no folder row.

### list_properties
- **Purpose**: The vault's frontmatter schema — every property key in use, with how many notes use it and what value types it takes. Like `list_tags` but for arbitrary properties.
- **Input**: `include_tags` (optional, default `true` — set `false` to omit the `tags` key, already covered by `list_tags`). `offset` (optional): Rows to skip before the window, for pagination (default `0`).
- **Output**: `{ results, returned, skipped, omitted, truncated }` — `results` is the array of `{ key, count, types }` where `types` is the distinct value types observed for that key (`string`/`number`/`boolean`/`array`/`null`/`date`), sorted by `count` descending then `key`. There is no `limit`, so `truncated` is always `false` and `omitted` is always `0`; `offset`/`skipped` still let you page through the full set. Index-backed.

### list_property_values
- **Purpose**: Distinct values of one frontmatter property with per-note counts — a faceted breakdown, e.g. to see every `status` value in use.
- **Input**: `key` (required), `limit` (optional, default 100; `limit: 0` = unbounded), `offset` (optional, default `0` — rows to skip before the window, for pagination)
- **Output**: `{ key, results, returned, skipped, omitted, truncated }` — `results` is `[{ value, count }]`, sorted by `count` descending then value, bounded by `limit`. Array-valued properties count each element once per note. Index-backed.

### query_notes
- **Purpose**: Find notes by frontmatter condition — generalizes the `where` filter in `list_recent_notes` into its own tool.
- **Input**:
  - `where` (required): Object of `key -> condition`. A condition is either a bare scalar (equality, or array-membership when the note's value is an array) or an operator object `{ eq, ne, gt, gte, lt, lte, exists, contains }`.
  - `match` (optional): `"all"` (default — every condition must hold) or `"any"` (at least one) — governs the `where` conditions only
  - `folder` (optional): Restrict to notes under this folder (relative to the vault root)
  - `tags` (optional): Additionally restrict to notes carrying these tags (leading `#` optional); any of them
  - `limit` (optional): Maximum number of notes to return (default `100`; pass `0` for unbounded — no cap)
  - `offset` (optional): Rows to skip before the window, for pagination (default `0`; skipping past the end returns an empty result, not an error)
- **Comparisons**: Type-aware — numeric when both sides parse as numbers, chronological when both parse as dates, else case-insensitive string compare.
- **Output**: `{ results, returned, skipped, omitted, truncated }` — `results` is the array of note headers (same shape as `list_notes`), bounded by `limit` (default `100`); `returned` is `results.length`, `omitted` is the number of notes dropped by the limit, and `truncated` is `true` when `omitted > 0`. Index-backed.

### get_property
- **Purpose**: Read a single frontmatter property from one note — cheaper than reading the whole note or its full frontmatter when only one field is needed.
- **Input**: `path` (required), `key` (required)
- **Output**: `{ path, key, value, present }` where `present` distinguishes an absent key from a key explicitly set to `null`. Index-backed.
- **Security**: Path traversal protected via the same guard as read_notes.

### resolve_note
- **Purpose**: Map a human-facing note name to its canonical path. Humans refer to notes by title or alias; every other tool addresses by path — this closes that gap directly, removing the search-then-guess round trip of running `search_notes_ranked` and eyeballing the top hit.
- **Input**: `query` (required) — the human-facing name (title, alias, or basename) to resolve.
- **Output**: `{ query, matches, resolved }`:
  - `matches`: array of `{ path, title, matched_on }`, sorted by path. `matched_on` is `"title" | "alias" | "basename"`. A note matching on more than one field appears **once**, labeled with its strongest field (precedence `title > alias > basename`).
  - `resolved`: the single path when exactly one note matches, else `null` (ambiguous or no match). The tool **never guesses** among candidates.
- **Matching**: Exact, case-insensitive equality against frontmatter `title`, each frontmatter `aliases[]` entry (a single string or an array), and the file basename. No partial/substring/fuzzy matching — that is `search_notes_ranked`'s job. A no-match is a normal empty result, not an error.
- **Index-backed**: A single map lookup over the shared index (the index now also records each note's `aliases`); no per-call vault scan.

## Writing tools

**The write tools are off by default.** The server is read-only unless
`OBSIDIAN_ALLOW_WRITES` is set to a truthy value (`1`, `true`, `yes`, `on`).
When disabled, the eighteen write tools are hidden from `list_tools` and any call
to one is rejected — so an agent only ever sees the read tools. When enabled, all
tools are exposed. The flag gates the MCP server (the agent-facing surface); the
query CLI is the operator's own tool and is not gated. Flag helpers live in
`src/tools/env-flags.ts`.

The server can also mutate the vault. All writes funnel through a single guarded
path (`src/tools/write.ts` → `commitWrite`) that resolves + path-guards the
target, runs the git guard (see below), then writes. The structure-aware tools
are built on a shared note-document core (`src/tools/note-document.ts`) that
parses frontmatter + body once and applies surgical edits, so an agent can
change a tag or a section without reading and rewriting the whole note.

### write_note
- **Purpose**: Create a note, or overwrite an existing one.
- **Input**: `path` (required), `content` (required), `overwrite` (optional, default `false` — refuses to clobber an existing note), `frontmatter` (optional object — structured frontmatter, validated and serialized canonically; when given, `content` is the body only). Frontmatter may be supplied via the `frontmatter` param **or** inline in `content` (both are validated on the same rules as every other frontmatter write) — supplying both is an error.
- **Output**: `{ path, created, unresolved_links, broken_anchors }` — the two link-health fields report the resulting note's graph integrity (see the shared link-integrity convention above); report-only.

### append_note
- **Purpose**: Append text to the end of a note (with a separating newline). When the call creates the note (`create:true` on a missing note), a leading frontmatter block in `content` is validated on the same rules as every other frontmatter write; appending to an existing note treats a leading `---` as body text.
- **Input**: `path` (required), `content` (required), `create` (optional — create the note if missing)
- **Output**: `{ path, created, unresolved_links, broken_anchors }` — link-health for the resulting note (see the shared link-integrity convention above); report-only.

### prepend_note
- **Purpose**: Prepend text to the start of a note's body. Any frontmatter block is preserved and the text is inserted after it (never before the YAML fence). When the call creates the note (`create:true` on a missing note), a leading frontmatter block in `content` is validated; when prepending to an existing note the text is inserted after the frontmatter, so it is never treated as frontmatter.
- **Input**: `path` (required), `content` (required), `create` (optional — create the note if missing)
- **Output**: `{ path, created, unresolved_links, broken_anchors }` — link-health for the resulting note (see the shared link-integrity convention above); report-only.

### delete_note
- **Purpose**: Delete a note. **Trash-safe by default**: the note is moved to the vault's `.trash` folder (Obsidian's convention, ignored by the index) so the deletion is recoverable. Repeated trashings of the same name are disambiguated with a numeric suffix. Errors if the note does not exist.
- **Input**: `path` (required), `permanent` (optional — unlink outright instead of trashing)
- **Output**: `{ path, deleted, trashed, trash_path?, dangled_backlinks }` — `dangled_backlinks` lists the paths of notes elsewhere in the vault that linked to the deleted note and now have a broken `[[wikilink]]`. Reported only; those notes are not modified.

### move_note
- **Purpose**: Move or rename a note. By default every `[[wikilink]]` elsewhere in the vault that pointed to the old location is rewritten to the new one (full-path links become the new full path; bare-basename links become the new basename; aliases and `#anchors` are preserved), so the link graph is never broken.
- **Input**: `from` (required), `to` (required), `overwrite` (optional, default `false`), `update_links` (optional, default `true`)
- **Output**: `{ from, to, overwritten, updated_notes, updated_links }`
- **Security**: Path traversal protected on both endpoints.

### move_file
- **Purpose**: Move or rename an arbitrary file (attachments, images, or notes referenced by literal path). Treats the path literally — no `.md` is appended and no wikilinks are rewritten.
- **Input**: `from` (required), `to` (required), `overwrite` (optional, default `false`)
- **Output**: `{ from, to, overwritten }`
- **Security**: Path traversal protected on both endpoints via `resolveVaultFile`.

### patch_note
- **Purpose**: Apply a literal find/replace patch to a note's raw text. The match is an exact string (never a regex — no injection or catastrophic-backtracking risk). Errors if the text to find is absent, so a stale patch fails loudly.
- **Input**: `path` (required), `find` (required), `replace` (required), `all` (optional — replace every occurrence instead of only the first)
- **Output**: `{ path, replacements, unresolved_links, broken_anchors }` — link-health for the resulting note (see the shared link-integrity convention above); report-only. A patch that swaps a wikilink target for a typo surfaces it here immediately.
- **Ambiguity**: With `all` false, a `find` that occurs more than once errors (reporting the count) rather than silently patching the first — set `all: true` to replace every occurrence, or narrow `find` until it is unique.

### add_tag / remove_tag
- **Purpose**: Add or remove tags in a note's frontmatter without rewriting it. Adds are idempotent; storage is normalized to a `tags:` array.
- **Input**: `path` (required), `tags` (required array, with or without leading `#`)
- **Output**: `{ path, tags }` (the resulting tag list)

### set_frontmatter
- **Purpose**: Set and/or unset frontmatter fields (e.g. `status`, `updated`) while leaving the body untouched.
- **Input**: `path` (required), `set` (optional object of fields), `unset` (optional array of keys)
- **Output**: `{ path, changed }`

### add_property_values / remove_property_values
- **Purpose**: Add or remove values from an array-valued frontmatter property without rewriting the whole note. Adding is idempotent (no duplicates); an absent key is created as a new array; an existing scalar is promoted to `[old, ...new]`. Removing empties the array down and drops the key entirely once it has no values left.
- **Input**: `path` (required), `key` (required), `values` (required array)
- **Output**: `{ path, key, values }` (the resulting list)

### rename_property
- **Purpose**: Rename a frontmatter key in place, preserving its value and its position in the YAML. Errors if `from` is absent or `to` already exists.
- **Input**: `path` (required), `from` (required), `to` (required)
- **Output**: `{ path, from, to }`

### add_section
- **Purpose**: Insert a new heading + content. Appends at the end by default, or immediately after the section named by `after`. Errors on a duplicate heading at the same level.
- **Input**: `path` (required), `heading` (required), `content` (required), `level` (optional 1–6, default 2), `after` (optional — a bare heading or a `" > "`-joined heading-path, resolved with the same fail-loud ambiguity behavior as `append_to_section`/`replace_section`)
- **Output**: `{ path, heading, unresolved_links, broken_anchors }` — link-health for the resulting note (see the shared link-integrity convention above); report-only.

### append_to_section
- **Purpose**: Append text under an existing heading (before the next heading), leaving the rest of the note untouched. `create: true` creates the section if missing.
- **Input**: `path` (required), `heading` (required — a bare heading or a `" > "`-joined heading-path), `content` (required), `create` (optional)
- **Output**: `{ path, heading, unresolved_links, broken_anchors }` — link-health for the resulting note (see the shared link-integrity convention above); report-only.
- **Addressing**: Same fail-loud scheme as `read_section` — an ambiguous bare `heading` (repeated in the note) errors, listing the candidate full heading-paths so you can retry with the exact one (`Projects > Log`) and edit the right section. `create` only recovers a *missing* section; an ambiguous one is never silently created.

### replace_section
- **Purpose**: Replace the body under an existing heading (the heading line is kept). Errors if the section is missing.
- **Input**: `path` (required), `heading` (required — a bare heading or a `" > "`-joined heading-path, resolved with the same fail-loud ambiguity behavior as `append_to_section`), `content` (required)
- **Output**: `{ path, heading, unresolved_links, broken_anchors }` — link-health for the resulting note (see the shared link-integrity convention above); report-only.

### rename_section
- **Purpose**: Rename a heading in a note and rewrite every inbound `[[note#heading]]` anchor across the vault to the new heading — the heading-level analogue of `move_note`, closing the last structural edit that could silently break the link graph.
- **Input**: `path` (required), `from` (required — a bare heading or a `" > "`-joined heading-path, resolved with the same fail-loud ambiguity behavior as `read_section`/`replace_section`), `to` (required — new heading text), `update_anchors` (optional, default `true` — rewrite inbound anchors elsewhere in the vault).
- **Output**: `{ path, from, to, updated_notes, updated_links }` — `from`/`to` are the resolved old/new heading; `updated_notes` counts OTHER notes touched (the renamed note itself is always touched, so it's excluded); `updated_links` counts every anchor rewritten, including the renamed note's own self-references (`[[#Old]]`/`[[thisnote#Old]]`) alongside inbound anchors elsewhere.
- **Anchor matching**: Literal case-insensitive (trimmed) text — NOT Obsidian slug normalization. Block-ref anchors (`#^id`) are never rewritten. An ambiguous or missing `from` fails loud.
- **Duplicate-leaf caveat**: If the renamed heading's leaf text is duplicated elsewhere in the same note (e.g. the same heading under a different parent), inbound anchors meant for the OTHER occurrence may also get rewritten — Obsidian anchors carry no parent context, so matching is by literal heading text alone.

### bulk_edit
- **Purpose**: Apply one or more frontmatter mutations to many notes in a single call, under a single git snapshot, with per-note result reporting. Turns "tag these 30 notes" from 30 round trips (and 30 auto-snapshot commits) into one.
- **Input**:
  - `select` (required): either `paths` (explicit array of note paths) **or** a filter — `where` (query_notes-style condition object) and/or `tags` (find_by_tag-style), optionally scoped by `folder` and combined via `match` (`"all"` default or `"any"`), plus an optional `limit`. Exactly one of `paths` or the filter form must be given — providing both errors, and providing neither errors.
  - `operations` (required): an ordered, non-empty array of frontmatter-only mutations, applied in order to each matched note (e.g. rename then set the new key in one pass). Supported ops: `add_tag`, `remove_tag`, `set_frontmatter`, `add_property_values`, `remove_property_values`, `rename_property` — same shapes as the single-note tools of the same name. No section/body ops.
  - `dry_run` (optional): preview the matched notes and parsed operations with **zero writes and no git snapshot**. This previews the selection and operation shape only — it does not parse notes or predict per-note apply outcomes, so a note that will fail on commit (e.g. `rename_property` onto an existing key) still shows in the dry-run match set.
  - `expected_count` (optional): abort before any snapshot or write if the resolved match count differs — guards a filter that drifted between an agent's preview and its commit.
- **Output**: `{ dry_run, matched_count, applied_count, failed_count, results }` where each `results` entry is `{ path, ok: true, changed }` or `{ path, ok: false, error }`. A per-note failure (missing note, frontmatter validation error, write error) is isolated and reported — it does not sink the rest of the batch. `changed: false` marks a note whose operations were all no-ops (e.g. a tag already present).
- **Git**: One `snapshotBeforeWrite` call for the whole batch, not one per note — the pre-existing state is committed once, then every note in the batch is written uncommitted, so a partial batch still reviews and reverts as a single diff.
- **Security**: Path traversal protected via the same guard as read_notes.

**Structure notes**: Body-only edits (sections) preserve the frontmatter block
byte-for-byte; frontmatter edits (tags, fields) re-serialize the YAML block in
canonical form (block-style lists) but leave the body untouched. Headings inside
fenced code blocks are ignored when locating sections. All writes are
path-traversal protected via the same guard as read_notes.

**Validation**: Every frontmatter write rejects (1) nested objects/maps, (2)
arrays containing non-scalar elements, and (3) markdown syntax in string values
(bare URLs are allowed). Validation runs only on the keys a given write actually
touches, so a pre-existing violation on an untouched key never blocks an
unrelated edit. The content-writing tools (`write_note`, and the create path of
`append_note`/`prepend_note`) validate any hand-written leading frontmatter
block on these same rules, so an agent creating a note by hand cannot bypass
frontmatter integrity; malformed YAML in that block is rejected loudly rather
than landing in the vault.

### Git guard (`OBSIDIAN_GIT_AUTOCOMMIT`)

Set `OBSIDIAN_GIT_AUTOCOMMIT` to a truthy value (`1`, `true`, `yes`, `on`) to
snapshot the vault into a git commit **before every write**, so the agent's
change lands as an isolated, revertible diff. The pre-existing state is
committed (`git add -A && git commit`); the agent's own write is left
**uncommitted** for review. A clean working tree is not an error (nothing to
snapshot). The guard is **fail-closed**: when enabled but the snapshot cannot be
taken (git missing, vault not a repo, or the commit fails), the write is
refused rather than proceeding without the safety net. Implemented in
`src/tools/git-guard.ts`.

## Dependencies

- Node.js runtime (18+)
- ripgrep (`rg`) command-line tool
- git (only required when `OBSIDIAN_GIT_AUTOCOMMIT` is enabled)
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
`list_recent_notes`, `get_related_notes`, `get_vault_stats`, `search_notes_ranked`,
`query_notes`, `list_properties`, `list_property_values`, `get_outline`,
`list_vault_issues`, `resolve_note`) share an
in-memory index (`src/tools/vault-index.ts`) that parses each note once
(frontmatter, tags, wikilinks, headings, aliases) and caches the result. Each tool call
refreshes the index by walking the vault and re-reading only files whose size
or mtime changed, so repeated calls are map lookups rather than full-vault
scans. Both the backlink graph and the resolved outbound-link graph are
precomputed during refresh, so `get_related_notes` scores candidates from
lookups rather than re-resolving links on every call. The index now also
stores each note's structured headings (level, text, line, fence-aware),
which backs `get_outline` directly; `read_section` still reads the file at
call time since the index does not retain body text.

The index also builds a BM25 full-text index (`src/tools/text/bm25.ts`) from a
stemmed token stream per note (`src/tools/text/tokenize.ts`), rebuilt from cached
per-note tokens on each refresh so only changed files are re-tokenized. This
backs `search_notes_ranked`.

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
npm run query -- search-ranked "kubernetes networking" --limit 5   # BM25 ranked
npm run query -- search-ranked "kubernetes" --limit 100 --offset 100  # ranked hits 101-200 (page past the cap)
npm run query -- search "needle" --limit 20 --offset 20   # second page of matching files (files_skipped: 20)
npm run query -- search-ranked "kubernetes" --folder work --tag active --match all   # scoped ranked
npm run query -- search-ranked "kubernetes" --where '{"status":"active"}'            # scoped by frontmatter
npm run query -- search "productivity" --limit 20 --max-matches 20   # Bounded literal search
npm run query -- search "kubernetes" --tag work --match all   # Filtered to notes tagged #work
npm run query -- search "alpha" --where '{"status":"active"}' # Filtered by frontmatter

# Read examples
npm run query -- read "note1" "folder/note2"           # Read multiple notes ({ notes, errors })
npm run query -- --verbose search "pattern"            # Verbose mode

# Knowledge-base examples
npm run query -- list                                   # List all notes (headers)
npm run query -- list --folder projects --limit 20     # Scope to a folder
npm run query -- list --tag work --match all --where '{"status":"active"}'  # Scope by tags/frontmatter
npm run query -- list --limit 20 --offset 20            # Second page (skipped: 20)
npm run query -- links "projects/alpha"                # Outbound links + backlinks
npm run query -- tags                                   # All tags with counts
npm run query -- find-by-tag productivity project --all # Notes with all tags
npm run query -- find-by-tag work --folder projects --where '{"status":"active"}'  # Narrow a tag query
npm run query -- recent --limit 10                     # Most recently modified
npm run query -- recent --date-field updated --since 2026-07-01
npm run query -- recent --folder work --tag active --where '{"status":"active"}'  # Scoped recency
npm run query -- related "projects/alpha"              # Notes related to alpha
npm run query -- related "projects/alpha" --limit 5    # Top 5 related notes
npm run query -- related "projects/alpha" --folder work --tag active  # Scope the candidate pool
npm run query -- frontmatter "projects/alpha"          # Just the frontmatter
npm run query -- resolve "Alpha Project"                # title/alias/basename -> path
npm run query -- stats                                  # Whole-vault statistics
npm run query -- vault-issues orphans                    # Notes with no in/outbound links
npm run query -- vault-issues unresolved_links --limit 50  # Broken wikilink targets, by source
npm run query -- vault-issues broken_anchors --limit 50    # Resolved-note, dead-heading anchors, by source
npm run query -- files --folder assets --extension png  # Non-markdown files (attachments)
npm run query -- folders                                 # Folder tree with note counts
npm run query -- folders --folder projects --depth 1     # Immediate subfolders of projects/
npm run query -- properties                             # Frontmatter schema
npm run query -- property-values status                 # Distinct values of a key
npm run query -- query --where '{"status":"active","priority":{"gt":3}}'
npm run query -- query --where '{"status":"active"}' --folder projects --tag work  # Scope a frontmatter query
npm run query -- get-property "projects/alpha" status
npm run query -- outline "projects/alpha"                # Heading outline
npm run query -- read-section "projects/alpha" "Log"     # One section
npm run query -- read-section "projects/alpha" "Projects > Log" --include-subsections

# Write examples (the query CLI is not gated by OBSIDIAN_ALLOW_WRITES)
npm run query -- write "inbox/idea" "# Idea\n\nbody"    # Create a note
npm run query -- write "inbox/idea" --file draft.md -o  # Overwrite from a file
npm run query -- append "daily/2026-07-22" "more text"  # Append to a note
npm run query -- prepend "daily/2026-07-22" "> banner"  # Prepend to the body
npm run query -- add-tag "projects/alpha" project active
npm run query -- remove-tag "projects/alpha" stale
npm run query -- set-frontmatter "projects/alpha" --set status=done --unset draft
npm run query -- add-property-values "projects/alpha" aliases a2 a3
npm run query -- remove-property-values "projects/alpha" aliases a3
npm run query -- rename-property "projects/alpha" author authors
npm run query -- add-section "projects/alpha" "Next steps" "- ship it"
npm run query -- append-to-section "projects/alpha" "Log" "did a thing"
npm run query -- replace-section "projects/alpha" "Summary" "new summary"
npm run query -- rename-section "projects/alpha" "Old Heading" "New Heading"
npm run query -- rename-section "projects/alpha" "Old" "New" --no-update-anchors
npm run query -- move "projects/alpha" "archive/alpha"  # Rename + rewrite links
npm run query -- move-file "assets/old.png" "assets/new.png"
npm run query -- patch "projects/alpha" "old text" "new text" --all
npm run query -- delete "inbox/idea"                    # Trash-safe (recoverable)
npm run query -- delete "inbox/idea" --permanent        # Unlink outright
npm run query -- bulk-edit --select '{"where":{"status":"draft"}}' \
  --operations '[{"op":"add_tag","tags":["review"]},{"op":"set_frontmatter","set":{"status":"active"}}]' --dry-run

# Content beginning with "-" (e.g. markdown lists) via stdin or --file:
printf -- '- one\n- two' | npm run query -- add-section "projects/alpha" "Todo"
```

Enable the git safety net for any write by exporting the flag first:

```bash
OBSIDIAN_GIT_AUTOCOMMIT=1 npm run query -- add-tag "projects/alpha" review
```

(With mise: `mise run query -- search "productivity"`, etc.)

## Documentation Updates

**Important**: When updating functionality mentioned in this file or README.md, always update both documentation files accordingly. Only skip documentation updates when testing experimental features that aren't ready for users.