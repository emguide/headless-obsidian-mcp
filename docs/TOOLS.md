# Tool reference

All 46 tools — 25 read, 21 write — with parameters and return shapes. See the [README](../README.md) for setup, and [CLAUDE.md](../CLAUDE.md) for design rationale.

Which tools are actually exposed depends on the `OBSIDIAN_TOOLS` policy; unset, the server is read-only. Call `get_config` with `section: "tools"` to see the active policy.

- [Shared conventions](#shared-conventions)
- [Search](#search) · [Notes](#notes) · [Sections](#sections) · [Tasks](#tasks) · [Links](#links) · [Tags](#tags) · [Properties](#properties) · [Vault](#vault) · [Files](#files) · [Templates](#templates) · [Config](#config)
- [Write tools](#write-tools)

---

## Shared conventions

These hold across whole families of tools, so they're stated once here rather than repeated per tool. The server also sends them to every MCP client in its `instructions` at initialize.

### Naming taxonomy

A new tool reuses an existing verb rather than coining a synonym, so the name predicts scope and addressing:

- **`get_`** — one addressed thing: a note by path (`get_links`, `get_outline`, `get_frontmatter`, `get_property`, `get_related_notes`) or the vault as one object (`get_vault_stats`).
- **`list_`** — enumerate a vault-wide collection, optionally scoped. A required argument doesn't demote it to `get_` (`list_property_values(key)`).
- **`search_`** text-queries content; **`read_`** returns body text; **`resolve_`** maps a human name to a path.
- **`find_by_X`** retrieves by one named criterion; **`query_`** retrieves by a condition object, whose `where` is the single condition language every note-filtering tool reuses.
- **Writes** name the mutation. `_property_values` is per-note under `add_`/`remove_` and vault-wide under `list_` — the verb, not the noun, carries the scope.

`list_notes`, `find_by_tag`, `query_notes`, and `list_recent_notes` stay separate deliberately: they match different data (unified tags vs. frontmatter-only) and carry different semantics (recency ordering). They differ in intent, not in what they can be scoped by.

### Pagination

Every envelope-returning tool (all list-style tools, plus `search_notes` and `search_notes_ranked`) accepts `offset` (default `0`) and returns:

```
{ results, returned, skipped, omitted, truncated }
```

The rows are a window `[offset, offset + limit)` over the full set. Both edges of what was dropped are reported — `skipped` (before the window, from `offset`) and `omitted` (after it, from `limit`) — so `total = skipped + returned + omitted`, and `truncated` (`omitted > 0`) answers "is there a next page?".

An `offset` past the end is an empty result, not an error. `offset` must be a non-negative integer. Where a tool has no `limit` (`list_tags`, `list_properties`), `truncated` is always `false`.

Two deviations: `search_notes` uses `files_skipped` / `files_omitted` over files, and `search_notes_ranked` caps a positive `limit` at 100 rows but lets `offset` page past it (`offset: 100, limit: 100` returns hits 101–200).

### Filter vocabulary

Every note-selecting tool — `search_notes`, `search_notes_ranked`, `list_notes`, `list_recent_notes`, `list_tasks`, `find_by_tag`, `query_notes`, `get_related_notes`, and `bulk_edit`'s `select` — accepts the same optional filters:

| Filter | Meaning |
|---|---|
| `folder` | Restrict to notes under this path prefix |
| `tags` | Restrict to notes carrying these tags (leading `#` optional) |
| `match` | `"any"` (default) or `"all"` — semantics of `tags` |
| `where` | Frontmatter conditions, `query_notes` syntax |

An absent filter imposes no constraint, so "active notes in `projects/` tagged `#work`" is one call rather than a fetch-wide-then-filter join. On a tool whose *primary* filter is already tags (`find_by_tag`) or where (`query_notes`), `match` governs that primary filter and the secondary one applies with its own default (tags: `any`, where: `all`).

Each tool keeps its distinct core — unified tag set, ordering, frontmatter conditions, relatedness scoring — and differs only in intent.

### Note addressing

Every single-note reader — `get_frontmatter`, `get_property`, `get_outline`, `get_links`, `read_section`, `read_notes`, `get_related_notes` — resolves its `path` the same way, through the shared index. A bare basename (`alpha` → `projects/alpha`) or a wrong-case path (`Projects/Alpha`) reaches the same note through all of them.

This is Obsidian's own wikilink resolution: exact path first, then — **for a slash-less name only** — the shortest-path basename fallback. A slash-qualified path naming no note stays unresolved rather than hopping to a same-basename note elsewhere. A **title or alias is not a resolvable address** here; that's `resolve_note`'s job.

The same `VaultIndex.resolve` defines the link graph and `unresolved_links`, so "what links to this note" and "what does this name address" can never disagree.

**On writes**, every edit-existing tool resolves targets identically, with one divergence: an **ambiguous** bare basename fails loud rather than silently picking the shortest-path note, since a wrong-note write mutates the wrong file.

```
Ambiguous note name: log. Candidates: daily/log, projects/log. Pass the full path.
```

**Create paths stay literal.** `write_note`, `apply_template`, and the `create: true` branches of `append_note`/`prepend_note` address the literal path — a bare name always creates the note you named, never an existing note elsewhere.

### Not-found suggestions

Every path-addressed tool that errors on a missing note appends up to 3 did-you-mean candidates:

```
Note not found: projects/alfa. Did you mean: projects/alpha?
```

Candidates reuse `resolve_note`'s exact matching (case-insensitive title/alias/basename equality), so wrong case, a wrong or missing folder prefix, and a title passed as a path are all corrected in one round trip. There is **no fuzzy matching** — a name with no exact-match identity gets the bare message. Errors stay errors; a candidate is never silently substituted.

Covers the write tools' missing-note errors, the single-note readers, and `read_notes`' per-path `errors` entries. `move_file` is excluded (attachments aren't indexed).

### Link integrity on writes

Every content-writing tool — `write_note`, `append_note`, `prepend_note`, `patch_note`, `add_section`, `append_to_section`, `replace_section`, `set_task_state`, `apply_template`, `insert_template` — returns two extra fields:

- **`unresolved_links`** — wikilink targets in the *resulting* note that resolve to no note
- **`broken_anchors`** — `[[note#heading]]` links whose note resolves but whose anchor matches nothing, as `{ target, anchor }`

Both are **report-only**: the write is never blocked or modified, exactly like `delete_note`'s `dangled_backlinks`. So an agent learns immediately that it introduced a broken `[[wikilink]]`, instead of discovering it later via `list_vault_issues`. The report covers the whole resulting note, not just the changed span; empty arrays mean the write left the graph intact. Block-ref anchors (`#^id`) are never flagged.

### Link context (opt-in)

`get_links`, `delete_note`, and `list_vault_issues` (kinds `unresolved_links` / `broken_anchors`) accept `include_context: true`, decorating each link row with `context` — the source line(s) containing that link, as `{ line, text }` pairs.

`line` is 1-based and **body-relative** (frontmatter stripped, matching `get_outline` / `list_tasks`); `text` is the line verbatim, so it feeds straight into `patch_note`'s `find`. This answers "who references this note, and why" in one call — a `search_notes` on the basename can't distinguish resolved links from text mentions.

Opt-in so a hub note with 200 backlinks stays cheap by default. Context comes from call-time file reads; on `list_vault_issues` only the returned window is read.

### Folder-write git posture

The three folder-write tools — `create_folder`, `move_folder`, `delete_folder` — each return `git_warning` alongside their normal fields: a non-null message means `OBSIDIAN_GIT_SYNC` is `off`, so the operation was **not** snapshotted and cannot be rolled back; `null` means a mode is active and the change was committed.

**Report-only** — the operation still runs, exactly like `delete_note`'s `dangled_backlinks`. Passing `require_git: true` escalates the warning into a refusal raised *before* any filesystem change, for a caller that would rather fail than act unrecoverably.

Only these three carry it, because only these three have a blast radius the arguments do not bound: every note-level write names the single path it touches, while one `delete_folder` can take an arbitrary subtree. `require_git` checks the *mode* only — a mode that is set but whose repo is unusable is already caught fail-closed by the write guard.

Folder operands also refuse two things beyond the usual traversal and symlink guards: the **vault root** (a `delete_folder` of it would be a vault wipe), and **hidden or machinery directories** (`.obsidian`, `.trash`, `.git`, `node_modules`, any leading-dot folder). A file addressed as a folder errors with a pointer to `move_file` / `delete_note`.

### Line numbers

`get_outline`, `read_section`, `list_tasks`, and `set_task_state` all use **1-based, body-relative** line numbers (frontmatter stripped), so a task's `line` cross-references directly against an outline's. `search_notes` returns both: `line_number` (file-absolute) and `body_line` (body-relative, `null` for hits inside frontmatter).

### Code fences

Headings, inline `#tags`, and `[[wikilinks]]` inside fenced code blocks are ignored everywhere — matching Obsidian. A note that *documents* tag or link syntax creates no phantom tags and no false `unresolved_links`, and `move_note`/`rename_section` never rewrite a link inside a code sample.

---

## Search

### `search_notes`

Literal/regex search through markdown files using ripgrep.

| Parameter | Type | Description |
|---|---|---|
| `pattern` | string, **required** | Search pattern for ripgrep (max 1000 chars) |
| `case_sensitive` | boolean | Default `false` |
| `whole_word` | boolean | Match whole words only |
| `multiline` | boolean | Enable multiline matching |
| `context_lines` | number | Context lines to show (default `5`, max `100`) |
| `limit` | number | Max files to return (default `20`; `0` = unlimited) |
| `max_matches_per_file` | number | Default `20`; `0` = unlimited |
| `offset` | number | Files to skip, reported as `files_skipped` |
| `folder` `tags` `match` `where` | | [Shared filters](#filter-vocabulary) |

**Returns** `{ results, truncated, files_returned, files_skipped, files_omitted, matches_capped_in }`.

`results` holds `{ path, matches }`; each match carries `line_number` (file-absolute) and `body_line` (body-relative — see [line numbers](#line-numbers)). `matches_capped_in` lists files whose matches hit the per-file cap.

Results are ordered by path, so an `offset` window is stable across calls — ripgrep's own file order is nondeterministic and would otherwise let a second page repeat or skip files.

When `folder`/`tags`/`where` are given, candidates are resolved from the index first and ripgrep runs only over those files (chunked to stay under `ARG_MAX`); a filter matching zero notes returns empty without invoking ripgrep.

**Corpus:** exactly what the index walks. `.gitignore` is *not* honoured (git-repo vaults are the norm) and hidden note files are included, while hidden directories and machinery dirs (`.obsidian`, `.trash`, `.git`, `node_modules`) stay excluded.

**Security:** the pattern is passed after `--`, so flag injection is impossible. Regex DoS is a non-issue by construction — ripgrep's default engine is linear-time, and an over-large pattern fails loudly.

### `search_notes_ranked`

BM25 relevance-ranked full-text search — most relevant notes first, rather than every literal match. Complements `search_notes`; doesn't replace it.

| Parameter | Type | Description |
|---|---|---|
| `query` | string, **required** | Free-text query (max 1000 chars) |
| `limit` | number | Default `100`; `0` = unbounded; a positive limit caps at 100 |
| `offset` | number | Pages past the 100-row cap |
| `folder` `tags` `match` `where` | | [Shared filters](#filter-vocabulary) |

**Returns** the [standard envelope](#pagination); `results` are note headers (as `list_notes`) plus `score` (higher = more relevant) and `snippet` (a short matched excerpt).

Standard Okapi BM25 (`k1=1.2`, `b=0.75`) over a stemmed, stopword-filtered token stream. Title, heading, and tag terms are indexed at ×2 weight, so a title hit outranks a passing body mention. Built on the shared index — no per-query vault scan.

**Limitation:** tokenization is ASCII/English-oriented (lowercased, split on non-alphanumeric, Porter-stemmed), so non-Latin scripts (e.g. CJK) and accented characters aren't well indexed. Use `search_notes` for literal non-ASCII matching.

---

## Notes

### `read_notes`

Read and parse one or more notes.

| Parameter | Type | Description |
|---|---|---|
| `paths` | array, **required** | Relative paths, `.md` optional (max 50) |

**Returns** `{ notes, errors }`. Each note has `path` (without `.md`), `contents` (body verbatim, frontmatter removed, inline `#tags` preserved), `frontmatter`, and `tags` (frontmatter unified with inline).

`errors` is `[{ path, error }]` for paths that couldn't be read — one bad path doesn't fail the batch. A path-traversal attempt still errors the whole call; only missing or oversized files (10 MB limit) are reported per-path.

### `list_notes`

Lightweight note headers without contents — discover what exists before searching or reading.

| Parameter | Type | Description |
|---|---|---|
| `folder` `tags` `match` `where` | | [Shared filters](#filter-vocabulary) |
| `limit` | number | Default `100`; `0` = unbounded |
| `offset` | number | [Pagination](#pagination) |

**Returns** the [standard envelope](#pagination). A note header is `{ path, title, tags, headline, size, modified }` — `title` is the frontmatter title or basename, `headline` the first markdown heading, `modified` an ISO timestamp. This shape is reused by `find_by_tag`, `query_notes`, `list_recent_notes`, `search_notes_ranked`, `get_related_notes`, and `list_vault_issues`' orphans.

### `list_recent_notes`

Notes ordered by recency, newest first.

| Parameter | Type | Description |
|---|---|---|
| `since` | string | Only notes on or after this ISO date |
| `date_field` | string | Frontmatter field to sort by instead of mtime (e.g. `updated`) |
| `folder` `tags` `match` `where` | | [Shared filters](#filter-vocabulary) |
| `limit` `offset` | number | Default `100`; `0` = unbounded |

**Returns** the [standard envelope](#pagination) of note headers.

### `query_notes`

Find notes by frontmatter condition.

| Parameter | Type | Description |
|---|---|---|
| `where` | object, **required** | `key → condition` map |
| `match` | string | `"all"` (default) or `"any"` — governs `where` only |
| `folder` `tags` | | [Shared filters](#filter-vocabulary) |
| `limit` `offset` | number | Default `100`; `0` = unbounded |

A condition is a bare scalar (equality, or array-membership when the note's value is an array) or an operator object: `{ eq, ne, gt, gte, lt, lte, exists, contains }`.

Comparisons are type-aware — numeric when both sides parse as numbers, chronological when both parse as dates, otherwise case-insensitive string compare.

**Returns** the [standard envelope](#pagination) of note headers.

### `resolve_note`

Map a human-facing name to a canonical path. Humans refer to notes by title or alias; every other tool addresses by path — this closes that gap without a search-then-guess round trip.

| Parameter | Type | Description |
|---|---|---|
| `query` | string, **required** | Title, alias, or basename |

**Returns** `{ query, matches, resolved }`. `matches` is `[{ path, title, matched_on }]` sorted by path, where `matched_on` is `"title" | "alias" | "basename"`; a note matching several fields appears once, labeled with its strongest (precedence title > alias > basename). `resolved` is the single path when exactly one note matches, else `null` — **the tool never guesses**.

Matching is exact and case-insensitive. No partial or fuzzy matching — that's `search_notes_ranked`'s job. A no-match is an empty result, not an error.

### `resolve_daily_note`

Map a calendar date to its canonical daily-note path — the date analogue of `resolve_note`.

| Parameter | Type | Description |
|---|---|---|
| `date` | string | `"YYYY-MM-DD"`, or `"today"` (default) / `"yesterday"` / `"tomorrow"` |

**Returns** `{ date, path, exists, template }`. `path` has no `.md`; slashes in the configured format nest folders (`YYYY/MM/YYYY-MM-DD`), exactly as in Obsidian. `exists` is a fresh stat, so a just-created note shows immediately.

The answer comes from the **Daily Notes core plugin's own config** (`.obsidian/daily-notes.json`), so it keeps working when you change the folder or date format in Obsidian. Missing keys take Obsidian's defaults (vault root, `YYYY-MM-DD`, no template). `OBSIDIAN_DAILY_FOLDER` overrides the folder for headless setups; with neither config nor env var the tool fails loud rather than guessing wrong paths.

Read-only by design — existing tools do the rest: `apply_template` (which accepts the returned `template` path) or `write_note` to create, `append_note` to log into it, `read_notes` to read it.

> **Caveat:** `{{date}}`/`{{time}}` in an applied template expand with the *current* moment, not the resolved day — exact Obsidian parity for today, worth knowing when creating past or future notes.

---

## Sections

### `get_outline`

A note's heading structure without its body. Closes the "check what sections exist, then edit the right one" loop without reading the whole note. Index-backed.

| Parameter | Type | Description |
|---|---|---|
| `path` | string, **required** | `.md` optional |

**Returns** `{ path, outline }`, each entry `{ heading, level, path, line, ambiguous }`. The entry's `path` is the full `" > "`-joined heading-path (`Projects > Log`) — the disambiguating address. `ambiguous` is `true` when the bare heading text repeats in the note.

### `read_section`

Read one section without loading the whole note — the read-side complement of `append_to_section`/`replace_section`.

| Parameter | Type | Description |
|---|---|---|
| `path` | string, **required** | |
| `section` | string, **required** | Bare heading, or `" > "`-joined heading-path |
| `include_subsections` | boolean | Include nested subsections (default `false`) |

**Returns** `{ path, section, level, content }`. `section` is the resolved full heading-path; `content` is the heading line plus its own body. Frontmatter is never included.

A bare heading resolves when unique; an ambiguous one **errors loudly**, listing the candidate full paths so you can retry with the exact one. Reads the file at call time — the index doesn't retain body text.

---

## Tasks

### `list_tasks`

Every `- [ ]` checkbox task in the vault as parsed rows, replacing a hand-rolled regex through `search_notes`. Index-backed.

| Parameter | Type | Description |
|---|---|---|
| `status` | array | Any-of: `"open"`, `"done"`, `"in_progress"`, `"cancelled"`, `"forwarded"`, `"other"`. Omitted = all |
| `folder` `tags` `match` `where` | | [Shared filters](#filter-vocabulary) |
| `limit` `offset` | number | Default `100`; `0` = unbounded |

**Returns** the [standard envelope](#pagination); rows are `{ path, text, status, marker, line, section }`. `text` is the task text after the checkbox, `marker` the raw checkbox character verbatim, `line` [body-relative](#line-numbers), and `section` the `" > "`-joined heading-path the task falls under (`null` above every heading).

---

## Links

### `get_links`

Resolve the Obsidian link graph for a note.

| Parameter | Type | Description |
|---|---|---|
| `path` | string, **required** | |
| `include_context` | boolean | Decorate rows with source lines — see [link context](#link-context-opt-in) |

**Returns** `{ note, outbound_links, unresolved_links, backlinks }` — the canonical path, resolved `[[wikilinks]]` (each `{ target, path }`), targets resolving to nothing, and notes elsewhere linking here.

With `include_context: true`, every row in all three arrays gains `context`: `outbound_links` become `{ target, path, context }`, `unresolved_links` become `{ target, context }` (bare strings otherwise), and `backlinks` become `{ path, context }`.

Handles `[[note]]`, `[[note|alias]]`, `[[note#heading]]`, and `![[embeds]]`. A bare `[[basename]]` matching several notes resolves to the one closest to the vault root (fewest path segments), ties broken alphabetically — Obsidian's shortest-path rule, so the same bare link points to the same note vault-wide. See [note addressing](#note-addressing) for why slash-qualified targets get no basename fallback.

### `get_related_notes`

Associative recall: rank the notes most related to a given one. Computed entirely from the shared index — no embeddings, no model.

| Parameter | Type | Description |
|---|---|---|
| `path` | string, **required** | |
| `folder` `tags` `match` `where` | | Scope the scored candidate pool |
| `limit` `offset` | number | Default `100`; `0` = unbounded |

Relatedness is a transparent weighted blend of four signals:

| Signal | Weight |
|---|---|
| Direct link, either direction | 4 |
| Each shared tag | 3 |
| Each shared out-link (co-reference) | 2 |
| Each shared backlink (co-citation) | 2 |

Notes with no connecting signal are omitted; ties break by path. The source note is never its own candidate.

**Returns** the [standard envelope](#pagination); results are note headers extended with `score`, `reasons` (why each surfaced), `shared_tags`, `shared_links`, `shared_backlinks`, and `linked`.

---

## Tags

### `list_tags`

Every tag across the vault with note counts, unifying inline `#tags` (including nested `#parent/child`) with frontmatter `tags:`.

| Parameter | Type | Description |
|---|---|---|
| `offset` | number | [Pagination](#pagination) |

**Returns** the [standard envelope](#pagination) of `{ tag, count }` sorted by frequency. There's no `limit`, so `truncated` is always `false`.

Tags inside [code fences](#code-fences) are ignored. Every tag consumer shares this extraction, so they never disagree.

### `find_by_tag`

Notes matching one or more tags — high-precision retrieval by human curation.

| Parameter | Type | Description |
|---|---|---|
| `tags` | array, **required** | Leading `#` optional |
| `match` | string | `"any"` (default) or `"all"` — governs the tag set only |
| `folder` `where` | | [Shared filters](#filter-vocabulary); `where` conditions all must hold |
| `limit` `offset` | number | Default `100`; `0` = unbounded |

**Returns** the [standard envelope](#pagination) of note headers.

---

## Properties

### `get_frontmatter`

A note's parsed frontmatter without its body — cheap inspection of status, aliases, or dates before reading the whole note.

| Parameter | Type | Description |
|---|---|---|
| `path` | string, **required** | |

**Returns** `{ path, frontmatter }` — parsed YAML as an object, empty when the note has none.

### `get_property`

One frontmatter property from one note — cheaper than the whole frontmatter when a single field is needed. Index-backed.

| Parameter | Type | Description |
|---|---|---|
| `path` | string, **required** | |
| `key` | string, **required** | |

**Returns** `{ path, key, value, present }` — `present` distinguishes an absent key from one explicitly set to `null`.

### `list_properties`

The vault's frontmatter schema — every property key in use, with usage counts and observed value types. Like `list_tags`, but for arbitrary properties.

| Parameter | Type | Description |
|---|---|---|
| `include_tags` | boolean | Include the `tags` key (default `true`; set `false` since `list_tags` covers it) |
| `offset` | number | [Pagination](#pagination) |

**Returns** the [standard envelope](#pagination) of `{ key, count, types }`, sorted by count descending then key. `types` are the distinct value types observed: `string`, `number`, `boolean`, `array`, `null`, `date`, plus `object` for nested YAML hand-written on disk (frontmatter *writes* reject nesting; reads don't). No `limit`, so `truncated` is always `false`.

### `list_property_values`

Distinct values of one property with per-note counts — a faceted breakdown, e.g. every `status` in use.

| Parameter | Type | Description |
|---|---|---|
| `key` | string, **required** | |
| `limit` `offset` | number | Default `100`; `0` = unbounded |

**Returns** `{ key, results, returned, skipped, omitted, truncated }` — `results` is `[{ value, count }]` sorted by count descending. Array-valued properties count each element once per note.

---

## Vault

### `get_vault_stats`

Summarize the whole vault in one call, derived entirely from the shared index. **No parameters.**

**Returns** `{ notes, total_size_bytes, distinct_tags, tag_assignments, tagged_notes, untagged_notes, resolved_links, unresolved_links, notes_with_links, orphan_notes, conflict_notes, last_modified, first_modified }`.

`orphan_notes` counts notes with neither inbound nor outbound resolved links; `conflict_notes` counts unreconciled git-sync conflict copies. Time bounds are ISO timestamps (`null` for an empty vault).

### `list_vault_issues`

The drill-down from a stat to the actual rows — hygiene findings the index already knows about.

| Parameter | Type | Description |
|---|---|---|
| `kind` | string, **required** | `"orphans"`, `"unresolved_links"`, `"broken_anchors"`, `"conflicts"` |
| `limit` `offset` | number | Default `100`; `0` = unbounded |
| `include_context` | boolean | Link kinds only — see [link context](#link-context-opt-in). Errors on `orphans`/`conflicts` |

**Returns** the [standard envelope](#pagination); `results` depends on `kind`:

| `kind` | Shape |
|---|---|
| `orphans` | Note headers — no inbound and no outbound resolved links |
| `unresolved_links` | `{ source, targets }` grouped by source note |
| `broken_anchors` | `{ source, targets: [{ target, anchor }] }` — note resolves, heading doesn't |
| `conflicts` | `{ path, original, created }` — one row per conflict copy |

For the two link kinds, `returned`/`omitted`/`truncated` count **groups (source notes), not individual targets**. `broken_anchors` excludes block-ref anchors (`#^id`) and links to unresolved notes.

**Count relationship:** on an unbounded result, `orphans`' length equals `get_vault_stats`' `orphan_notes`; the summed `targets` lengths under `unresolved_links` equal its `unresolved_links` count; `conflicts`' length equals `conflict_notes`.

---

## Files

### `list_files`

Non-markdown files (attachments, images, PDFs) — the counterpart to `list_notes` for everything it deliberately excludes.

| Parameter | Type | Description |
|---|---|---|
| `folder` | string | Restrict to this folder |
| `extension` | string | Leading dot optional, case-insensitive (`png` or `.PNG`) |
| `limit` `offset` | number | Default `100`; `0` = unbounded |

**Returns** the [standard envelope](#pagination) of `{ path, size, modified, extension }`. `path` keeps its extension (unlike note paths); `extension` is lowercased without the dot. Markdown files are never returned.

### `list_folders`

The vault's folder shape — the folder-level counterpart to `list_notes` and `list_files`. Closes the folder-discovery gap that otherwise forces an unbounded `list_notes`.

| Parameter | Type | Description |
|---|---|---|
| `folder` | string | Restrict to folders under this one |
| `depth` | number | Relative depth cap — `1` = immediate children of the scope |
| `limit` `offset` | number | Default `100`; `0` = unbounded |

**Returns** the [standard envelope](#pagination) of `{ path, notes, total_notes, subfolders }` sorted by path — `notes` counts notes directly in the folder, `total_notes` recursively, `subfolders` direct children.

Notes-only: a folder holding only attachments doesn't appear (use `list_files`), and root-level notes contribute no folder row. Index-backed.

---

## Templates

Interop with Obsidian's **core Templates plugin** (not Templater). The server reproduces the plugin's insert-time substitution faithfully; it never invents a format.

Supported placeholders: `{{title}}`, `{{date}}`, `{{time}}`, and the inline overrides `{{date:FORMAT}}` / `{{time:FORMAT}}`. Format tokens are Moment.js-compatible, so `{{date:Do MMMM YYYY}}` renders exactly as in Obsidian, and week tokens (`gggg-[W]ww`) work.

Any unrecognized `{{...}}` token **passes through literally**, never silently dropped. Templater's `<% %>` scripting, `tp.*` API, prompts, and system commands are explicitly out of scope — they have no faithful headless equivalent.

`{{title}}` resolves to the **target note's basename** in both write tools — exact Obsidian parity.

**Folder resolution is config-first:** the template folder comes from `.obsidian/templates.json`, and default date/time formats from its `dateFormat`/`timeFormat` (falling back to `YYYY-MM-DD` / `HH:mm`). `OBSIDIAN_TEMPLATE_FOLDER` overrides for headless setups. With neither, the template tools fail loud rather than returning an empty result.

**Vault-path fallback:** a `template` argument resolves inside the configured folder first, then as a vault-relative note path (`.md` optional). This is why `resolve_daily_note`'s `template` value is always directly consumable — the Daily Notes template can live anywhere.

### `list_templates`

Enumerate the configured template folder — the discovery entry point. Read-only, never gated.

| Parameter | Type | Description |
|---|---|---|
| `limit` `offset` | number | Default `100`; `0` = unbounded |

**Returns** the [standard envelope](#pagination) of `{ path, name, size, modified }` sorted by name. The folder is walked **recursively**; a nested template's `name` is the folder-relative path (`sub/Nested`, no `.md`) — exactly the string the two write tools accept as `template`. Fails loud if no template folder is configured (a setup problem, not "zero templates").

---

## Config

### `get_config`

The server's *own* configuration — how it's set up, not what's in the vault (that's `get_vault_stats`). Answers "where is the template folder?", "are writes enabled?", "which vault am I pointed at?" in one call.

Read-only and **never excludable** by `OBSIDIAN_TOOLS` — it's how an agent discovers the active policy, so it's always exposed.

| Parameter | Type | Description |
|---|---|---|
| `section` | string | `"template" \| "daily" \| "writes" \| "sync" \| "vault" \| "tools"` — returns just that section, unwrapped. Omit for the whole object; an unknown section errors, listing valid ones |

**Returns** `{ template, daily, writes, sync, vault, tools }`:

| Section | Fields |
|---|---|
| `template` | `{ folder, date_format, time_format }` — `folder` is `null` when unconfigured (this tool doesn't throw, unlike the template tools); the formats are what a bare `{{date}}`/`{{time}}` actually renders |
| `daily` | `{ folder, format, template }` — reported leniently: `folder: null` when unconfigured, `""` when configured at the vault root |
| `writes` | `{ writes_enabled, git_sync }` — `writes_enabled` is **derived**: true iff the policy exposes at least one write tool |
| `sync` | `{ mode, interval, remote, last_sync, last_error }` |
| `vault` | `{ path }` — the configured `OBSIDIAN_VAULT_PATH` |
| `tools` | `{ policy, exposed, excluded }` — raw `OBSIDIAN_TOOLS` (`null` when unset) and sorted tool names |

`last_sync`/`last_error` track **only the background timer's** own attempts. In `commit`/`every-write` mode they stay `null` forever — there's no timer, and a failed `every-write` pull/push throws back to the write call instead.

---

# Write tools

All writes funnel through a single guarded path that resolves and path-guards the target, runs the git guard, then writes. The structure-aware tools share a note-document core that parses frontmatter and body once and applies surgical edits — so an agent can change a tag or a section without rewriting the whole note.

**Hidden by default.** With `OBSIDIAN_TOOLS` unset the server is read-only: these 21 tools are absent from the tool list and calling one is rejected.

### Guarantees shared by every write

**Path guard.** Writes reject `..` traversal *and* any path leaving the vault through a **symlink** — the deepest existing ancestor is resolved with `realpath` and must stay under the vault's realpath. A lexical check couldn't catch this: a symlink `secret.md → /etc/passwd` contains no `..`.

**Serialization.** Every read-modify-write span holds a per-vault lock — including single-character edits like `set_task_state`, which still rewrites the whole note. Without it, two concurrent calls could each read a note, each mutate their own copy, and each write, silently discarding the first (and two `write_note` calls could both pass the exists-check, defeating `overwrite: false`). The lock is per vault because multi-note operations span notes, and reentrant by async context so outer operations can call inner helpers.

**Body vs. frontmatter fidelity.** Section edits preserve the frontmatter block byte-for-byte. Frontmatter edits re-serialize the YAML canonically (block-style lists) but leave the body untouched.

**Dates.** An unquoted `created: 2026-07-25` parses to a date and is a valid scalar. A date-only value round-trips in its original `YYYY-MM-DD` form — an unrelated edit never rewrites it to `2026-07-25T00:00:00.000Z`. A value carrying a time keeps its full ISO timestamp.

**Validation.** Every frontmatter write rejects (1) nested objects, (2) arrays containing non-scalars, and (3) markdown syntax in string values (bare URLs are fine). Validation runs only on the keys a write actually touches, so a pre-existing violation elsewhere never blocks an unrelated edit. The content-writing tools validate any hand-written leading frontmatter block on the same rules — creating a note by hand can't bypass frontmatter integrity, and malformed YAML is rejected loudly rather than landing in the vault.

---

## Creating and replacing notes

### `write_note`

Create a note, or overwrite an existing one.

| Parameter | Type | Description |
|---|---|---|
| `path` | string, **required** | |
| `content` | string, **required** | May include a leading frontmatter block (validated), or be body-only when `frontmatter` is given |
| `overwrite` | boolean | Allow replacing an existing note (default `false` — refuses to clobber) |
| `frontmatter` | object | Structured frontmatter, validated and serialized canonically |

Supplying frontmatter both inline and via the parameter is an error.

**Returns** `{ path, created, unresolved_links, broken_anchors }` — see [link integrity](#link-integrity-on-writes).

### `append_note` / `prepend_note`

Append to the end of a note, or prepend to the start of its **body**. Prepending preserves any frontmatter block and inserts after it, never before the YAML fence.

| Parameter | Type | Description |
|---|---|---|
| `path` | string, **required** | |
| `content` | string, **required** | |
| `create` | boolean | Create the note if missing (default `false`) |

When the call *creates* the note, a leading frontmatter block in `content` is validated. When editing an existing note, a leading `---` is treated as body text.

**Returns** `{ path, created, unresolved_links, broken_anchors }`.

### `patch_note`

Literal find/replace on a note's raw text. The match is an exact string — **never a regex**, so there's no injection or catastrophic-backtracking risk. Errors if the text is absent, so a stale patch fails loudly instead of silently doing nothing.

| Parameter | Type | Description |
|---|---|---|
| `path` | string, **required** | |
| `find` | string, **required** | Exact literal text |
| `replace` | string, **required** | |
| `all` | boolean | Replace every occurrence instead of only the first (default `false`) |

With `all` false, a `find` occurring more than once **errors** (reporting the count) rather than silently patching the first. Set `all: true`, or narrow `find` until it's unique.

**Returns** `{ path, replacements, unresolved_links, broken_anchors }`. A patch that swaps a wikilink target for a typo surfaces it here immediately.

### `delete_note`

Delete a note. **Trash-safe by default:** the note moves to the vault's `.trash` (Obsidian's convention, ignored by the index), so the deletion is recoverable. Repeated trashings of the same name get a numeric suffix. Errors if the note doesn't exist.

| Parameter | Type | Description |
|---|---|---|
| `path` | string, **required** | |
| `permanent` | boolean | Unlink outright instead of trashing (default `false`) |
| `include_context` | boolean | See [link context](#link-context-opt-in) |

**Returns** `{ path, deleted, trashed, trash_path?, dangled_backlinks }` — `dangled_backlinks` lists notes that linked here and now have a broken `[[wikilink]]`. **Reported only**; those notes aren't modified. With `include_context: true` rows become `{ path, context }`, computed against the pre-delete index where the note still resolves.

### `move_note`

Move or rename a note. By default every `[[wikilink]]` pointing at the old location is rewritten — full-path links become the new full path, bare-basename links the new basename, aliases and `#anchors` preserved — so the link graph is never broken.

| Parameter | Type | Description |
|---|---|---|
| `from` | string, **required** | |
| `to` | string, **required** | |
| `overwrite` | boolean | Default `false` |
| `update_links` | boolean | Default `true` |

**Ownership:** a bare `[[basename]]` is rewritten only when it actually *resolves* to the moved note. With `a/log` and `b/log` in the vault, a bare `[[log]]` resolves to `a/log` (shortest-path rule), so moving `b/log` leaves it alone instead of silently repointing it.

**Returns** `{ from, to, overwritten, updated_notes, updated_links }`.

### `move_file`

Move or rename an arbitrary file (attachment, image, or a note by literal path). Treats the path literally — no `.md` is appended and **no wikilinks are rewritten**.

| Parameter | Type | Description |
|---|---|---|
| `from` `to` | string, **required** | With extension |
| `overwrite` | boolean | Default `false` |

**Returns** `{ from, to, overwritten }`.

### `create_folder`

Create a folder and any missing parents — the "C" of folder CRUD, whose "R" is [`list_folders`](#list_folders). Errors if anything already exists at the path (folder *or* file): a create that silently succeeded on an existing folder would hide a typo.

Two honest limits, both consequences of folders being *implicit* in the vault model. The new folder holds no notes, so **`list_folders` will not show it** until one lands there — its rows come from indexed note paths, not from directories on disk. And **git does not track empty directories**, so with sync enabled this commits nothing rather than failing. It still earns its place: it materializes the directory so a subsequent `move_file` or attachment write has a destination.

| Parameter | Type | Description |
|---|---|---|
| `path` | string, **required** | Folder path, vault-relative |
| `require_git` | boolean | Refuse when `OBSIDIAN_GIT_SYNC` is off. Default `false` |

**Returns** `{ path, created, git_warning }`.

### `move_folder`

Move or rename a folder and everything under it, rewriting the wikilinks that pointed into it — the folder-level analogue of [`move_note`](#move_note).

Only **folder-qualified** links (`[[projects/alpha]]`) are rewritten, because a folder move preserves every basename: `[[alpha]]` still names the same note afterwards. The one residual case is a bare link whose shortest-path winner the move changes (two notes sharing a basename, one moving nearer the root) — Obsidian re-resolves such a link the same way, so it is left alone rather than pinned to one side. Notes *inside* the moved folder are rewritten too, and are read at their new location, since the pre-move index recorded them at the old one.

There is **no `overwrite`**: an existing destination is refused outright, because merging two subtrees is not a rename and silently clobbering a destination tree is not something a single flag should buy. Moving a folder into its own descendant, or onto itself, is likewise refused.

| Parameter | Type | Description |
|---|---|---|
| `from` `to` | string, **required** | Vault-relative; `to` must not exist |
| `update_links` | boolean | Rewrite folder-qualified links pointing into it. Default `true` |
| `require_git` | boolean | Refuse when `OBSIDIAN_GIT_SYNC` is off. Default `false` |

**Returns** `{ from, to, moved_notes, moved_files, updated_notes, updated_links, git_warning }`.

### `delete_folder`

Delete a folder and everything under it. **Trash-safe by default**: the subtree moves to the vault's `.trash` (Obsidian's convention, ignored by the index) so the deletion stays recoverable, with the same numeric-suffix disambiguation as [`delete_note`](#delete_note). `permanent: true` unlinks outright.

A non-empty folder is **refused unless `recursive: true`** — this is the only tool on the surface whose blast radius is not bounded by an explicit list of paths, so the caller states the intent to delete contents rather than discovering it afterwards. Emptiness is judged from a **disk walk, not the index**: the index skips hidden and machinery directories, so an index-derived listing would call a folder holding hidden data empty and wave the guard through.

`dangled_backlinks` lists notes *outside* the folder that linked to notes *inside* it and now have a broken `[[wikilink]]` — report-only, exactly like `delete_note`'s field of the same name. A link from one deleted note to another is not dangling, so sources inside the folder are excluded.

| Parameter | Type | Description |
|---|---|---|
| `path` | string, **required** | Folder path, vault-relative |
| `recursive` | boolean | Required for a non-empty folder. Default `false` |
| `permanent` | boolean | Unlink instead of trashing. Default `false` |
| `require_git` | boolean | Refuse when `OBSIDIAN_GIT_SYNC` is off. Default `false` |

**Returns** `{ path, deleted, trashed, trash_path?, deleted_notes, deleted_files, dangled_backlinks, git_warning }`.

---

## Frontmatter edits

### `add_tag` / `remove_tag`

Add or remove tags in a note's frontmatter without rewriting the note. Adds are idempotent; storage normalizes to a `tags:` array.

| Parameter | Type | Description |
|---|---|---|
| `path` | string, **required** | |
| `tags` | array, **required** | Leading `#` optional |

**Returns** `{ path, tags }` — the resulting tag list.

### `set_frontmatter`

Set and/or unset frontmatter fields, leaving the body untouched.

| Parameter | Type | Description |
|---|---|---|
| `path` | string, **required** | |
| `set` | object | Fields to set, e.g. `{ "status": "done" }` |
| `unset` | array | Keys to remove |

**Returns** `{ path, changed }`.

### `add_property_values` / `remove_property_values`

Add or remove values from an array-valued property. Adding is idempotent; an absent key is created as a new array, and an existing scalar is promoted to `[old, ...new]`. Removing shrinks the array and drops the key entirely once empty.

| Parameter | Type | Description |
|---|---|---|
| `path` `key` | string, **required** | |
| `values` | array, **required** | |

**Returns** `{ path, key, values }` — the resulting list.

### `rename_property`

Rename a frontmatter key in place, preserving its value and its position in the YAML. Errors if `from` is absent or `to` already exists.

| Parameter | Type | Description |
|---|---|---|
| `path` `from` `to` | string, **required** | |

**Returns** `{ path, from, to }`.

---

## Section edits

Section addressing is uniform: a bare heading or a `" > "`-joined heading-path (`Projects > Log`). An **ambiguous bare heading errors loudly**, listing the candidate full paths so you can retry with the exact one and edit the right section.

### `add_section`

Insert a new heading plus content. Appends at the end by default, or immediately after the section named by `after`. Errors on a duplicate heading at the same level.

| Parameter | Type | Description |
|---|---|---|
| `path` | string, **required** | |
| `heading` | string, **required** | Without leading `#` |
| `content` | string, **required** | |
| `level` | number | 1–6 (default `2`) |
| `after` | string | Insert after this section |

**Returns** `{ path, heading, unresolved_links, broken_anchors }`.

### `append_to_section`

Append text under an existing heading, before the next heading, leaving the rest of the note untouched.

| Parameter | Type | Description |
|---|---|---|
| `path` `heading` `content` | string, **required** | |
| `create` | boolean | Create the section if missing (default `false`) |

`create` recovers a **missing bare heading only**. An ambiguous heading is never silently created, and a *heading-path* with no existing target **fails loud** — a heading-path addresses a section inside existing structure (which parent? what level?), so it's refused rather than written as a literal `## Projects > Log` heading. `insert_template`'s `create_section` inherits this guard.

**Returns** `{ path, heading, unresolved_links, broken_anchors }`.

### `replace_section`

Replace the body under an existing heading; the heading line is kept. Errors if the section is missing.

| Parameter | Type | Description |
|---|---|---|
| `path` `heading` `content` | string, **required** | |

**Returns** `{ path, heading, unresolved_links, broken_anchors }`.

### `rename_section`

Rename a heading and rewrite every inbound `[[note#heading]]` anchor across the vault — the heading-level analogue of `move_note`, closing the last structural edit that could silently break the link graph.

| Parameter | Type | Description |
|---|---|---|
| `path` `from` `to` | string, **required** | `from` may be a heading-path; `to` is new heading text |
| `update_anchors` | boolean | Rewrite inbound anchors elsewhere (default `true`) |

**Returns** `{ path, from, to, updated_notes, updated_links }` — `updated_notes` counts **other** notes touched (the renamed note itself always is, so it's excluded); `updated_links` counts every anchor rewritten, including the note's own self-references.

Anchor matching is literal, case-insensitive, trimmed text — **not** Obsidian's slug normalization. Block-ref anchors (`#^id`) are never rewritten. A bare `[[basename#anchor]]` is rewritten only when the basename resolves to the renamed note, and a backlinking note's own `[[#anchor]]` self-link is never touched (it addresses its own heading).

> **Duplicate-leaf caveat:** if the renamed heading's leaf text is duplicated elsewhere in the same note, inbound anchors meant for the *other* occurrence may also get rewritten — Obsidian anchors carry no parent context, so matching is by literal text alone.

---

## Tasks

### `set_task_state`

Change one checkbox task's state, rewriting only the marker character — the write-side complement of `list_tasks`.

| Parameter | Type | Description |
|---|---|---|
| `path` | string, **required** | |
| `status` | string, **required** | A **writable** status: `"open"`, `"done"`, `"in_progress"`, `"cancelled"`, `"forwarded"`. `"other"` is rejected — no canonical marker to write |
| `text` | string | Exact task text (the part after the checkbox) |
| `line` | number | [Body-relative](#line-numbers) — a tiebreak alongside `text`, or a positional address alone |

At least one of `text`/`line` is required. Addressing is fail-loud, mirroring `patch_note`:

- `text` alone, zero matches → "not found"
- `text` alone, several matches → errors, listing candidate line numbers so you can retry with `line`
- `line` alone → addresses whatever task is on that line
- both → `text` must match the task found at `line`, or the call errors

**Returns** `{ path, line, text, status, marker, changed, unresolved_links, broken_anchors }`. `changed` is `false` — with no write and no git snapshot — when the task was already in the requested state.

---

## Templates (write)

### `apply_template`

Create a new note from a template — the template-driven counterpart of `write_note`.

| Parameter | Type | Description |
|---|---|---|
| `template` | string, **required** | Name, folder-relative path, or vault-relative note path |
| `path` | string, **required** | Destination note |
| `overwrite` | boolean | Default `false` — refuses to clobber, like `write_note` |

**Returns** `{ path, created, unresolved_links, broken_anchors }`. Inherits `write_note`'s path guard, frontmatter validation, and overwrite refusal by delegation.

### `insert_template`

Expand a template into an **existing** note — "add a standard block to a note I already have".

| Parameter | Type | Description |
|---|---|---|
| `template` `path` | string, **required** | The note must already exist |
| `position` | string, **required** | `"append"` \| `"prepend"` \| `"section"` |
| `section` | string | Required iff `position` is `"section"` |
| `create_section` | boolean | Default `false`; inherits `append_to_section`'s create guard |

Frontmatter in the expanded template is treated as body text — the existing note's own frontmatter block is never touched. A missing note surfaces "Note not found" (creating notes is `apply_template`'s job).

**Returns** `{ path, position, unresolved_links, broken_anchors }`.

---

## Bulk

### `bulk_edit`

Apply one or more frontmatter mutations to many notes in a single call, under a single git snapshot, with per-note reporting. Turns "tag these 30 notes" from 30 round trips — and 30 auto-snapshot commits — into one.

| Parameter | Type | Description |
|---|---|---|
| `select` | object, **required** | Either `paths` (explicit array) **or** a filter — see below |
| `operations` | array, **required** | Ordered, non-empty list of frontmatter-only mutations |
| `dry_run` | boolean | Preview with zero writes and no git snapshot |
| `expected_count` | number | Abort before any write if the match count differs |

**`select`** takes either `paths`, or any combination of `where`, `tags`, and `folder` — a `folder` alone is a valid filter. `match` (`"any"` default) governs how multiple `tags` combine; `where` conditions always combine as `all`. An optional `limit` caps matched notes (`0` = unbounded). Exactly one of `paths` or the filter form must be given — both, or neither, errors.

**`operations`** are applied in order to each matched note, so you can `rename_property` then `set_frontmatter` on the new key in one pass. Supported ops: `add_tag`, `remove_tag`, `set_frontmatter`, `add_property_values`, `remove_property_values`, `rename_property` — same shapes as the single-note tools. No section or body ops.

**`dry_run`** previews the *selection and operation shape only*. It doesn't parse notes or predict per-note outcomes, so a note that will fail on commit (e.g. `rename_property` onto an existing key) still shows in the match set.

**`expected_count`** guards a filter that drifted between an agent's preview and its commit.

**Returns** `{ dry_run, matched_count, applied_count, failed_count, results }`, each result `{ path, ok: true, changed }` or `{ path, ok: false, error }`. A per-note failure is isolated and reported — it never sinks the rest of the batch. `changed: false` marks a note whose operations were all no-ops.

**Git:** one commit for the whole batch, not one per note. The sync guard runs once up front, every note is written, and the batch is committed at the end — so a partial batch still reviews and reverts as a single diff.
