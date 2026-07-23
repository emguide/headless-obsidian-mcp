# Core Templates Interop — Design

**Date:** 2026-07-23
**Status:** Approved (design), pending implementation plan

## Problem

Users already maintain templates in their Obsidian vault via the built-in
**core Templates plugin** — a template folder plus insert-time placeholder
substitution. The MCP server can create and edit notes but has no notion of
these templates, so an agent cannot produce a note that matches the shape the
user already relies on (consistent frontmatter, section skeleton, dated
headers) without hand-reconstructing it.

Goal: let an agent **discover, apply, and insert** the vault's existing core
Templates, reproducing Obsidian's substitution faithfully — without inventing a
new template format.

## Scope

**In scope** — the core Templates plugin only:

- The four documented placeholders: `{{title}}`, `{{date}}`, `{{time}}`, and
  the inline format overrides `{{date:FORMAT}}` / `{{time:FORMAT}}`.
- Moment.js format-token fidelity via a date library (see Dependency).
- Reading the template folder from the plugin's own config, env-overridable.

**Out of scope** (explicitly not supported):

- The **Templater** community plugin: `<% ... %>` JS eval, the `tp.*` API,
  user functions, prompts, `<%* ... %>` execution blocks, system commands,
  cursor placeholders. None are headless-reproducible without a JS sandbox and
  some have no headless equivalent at all.
- Inventing any non-Obsidian template syntax.
- Templates as schema/validation (a separate concern — could be a future
  `list_vault_issues` kind, not this work).

## Dependency

Add **`dayjs`** with the **`advancedFormat`** and **`customParseFormat`**
plugins (~7KB total) for Moment-compatible format tokens. This is a deliberate
exception to the project's "leans on Node built-ins" ethos, chosen over `moment`
(large, legacy, in maintenance mode) to get exact parity with Obsidian's
`{{date:FORMAT}}` output at minimal weight. Rationale: the alternative —
hand-implementing Moment tokens — reproduces a fiddly, bug-prone surface and
still risks divergence from Obsidian on edge tokens (`Do`, `ddd`, `[literal]`
escapes, locale-aware names).

> Note: production tool code already uses `new Date(...)` (e.g.
> `src/tools/vault-index.ts`, `src/tools/recent.ts`), so calling `new Date()`
> for the current timestamp in the apply/insert tools is consistent with the
> codebase. The wall-clock-free constraint applies to workflow scripts and to
> the `expand()` unit tests (which inject `now`), not to tool code.

## Tools

Three tools, fitting the existing verb taxonomy.

| Tool | Verb class | Gating | Purpose |
|---|---|---|---|
| `list_templates` | `list_` (read) | Always available | Enumerate the configured template folder |
| `apply_template` | write | `OBSIDIAN_ALLOW_WRITES` + git guard | Create a **new note** from a template |
| `insert_template` | write | `OBSIDIAN_ALLOW_WRITES` + git guard | Expand a template into an **existing note** |

### list_templates

- **Purpose:** Enumerate the vault's configured template folder so an agent can
  see what templates exist before applying one.
- **Input:**
  - `limit` (optional, default `100`; `0` = unbounded), `offset` (optional,
    default `0`) — standard pagination envelope.
- **Output:** `{ results, returned, skipped, omitted, truncated }` where each
  result is `{ path, name, size, modified }` (`name` = basename without `.md`,
  `path` = vault-relative note path, `modified` = ISO timestamp). Same envelope
  convention as `list_notes`.
- **Errors:** If no template folder is configured (neither `templates.json` nor
  the env override), fail loud with a clear message rather than returning an
  empty list — an unconfigured folder is a setup problem, not "zero templates".
- **Index note:** Reuses the vault walk / ignore rules; may reuse the index for
  headers. Read-only; never gated.

### apply_template

- **Purpose:** Expand a named template's placeholders and create a note from the
  result. The template-driven counterpart of `write_note`.
- **Input:**
  - `template` (required): template name (basename, with or without `.md`) or a
    template-folder-relative path.
  - `path` (required): destination note path for the new note.
  - `overwrite` (optional, default `false`): refuse to clobber an existing note,
    exactly like `write_note`.
- **Substitution:** `{{title}}` → the **destination note's basename** (from
  `path`), matching Obsidian. `{{date}}`/`{{time}}` and their format variants →
  current time (see Expansion engine).
- **Output:** `{ path, created, unresolved_links, broken_anchors }` — same shape
  and link-health convention as `write_note`. Report-only link health.
- **Delegation:** After expansion, delegates to the existing `commitWrite` /
  `write_note` path — inheriting path-guard, git guard, frontmatter validation
  of any leading frontmatter block in the expanded text, and link-health
  reporting. No new write machinery.
- **Errors (fail loud):** template not found (list nearby candidates); template
  folder unconfigured; destination exists and `overwrite` is false.

### insert_template

- **Purpose:** Expand a named template into an **existing** note, at a chosen
  location. Fills the "add a standard block to a note I already have" case.
- **Input:**
  - `template` (required): as in `apply_template`.
  - `path` (required): the existing note to insert into.
  - `position` (required): one of `"append"`, `"prepend"`, or `"section"`.
  - `section` (required iff `position === "section"`): a bare heading or a
    `" > "`-joined heading-path, resolved with the **same fail-loud ambiguity
    behavior** as `append_to_section` / `read_section`.
  - `create_section` (optional, default `false`): when `position === "section"`,
    create the section if missing (mirrors `append_to_section`'s `create`). An
    ambiguous section is never silently created.
- **Substitution:** `{{title}}` → the **existing note's basename** (from
  `path`), matching Obsidian. Date/time as in `apply_template`.
- **Output:** `{ path, position, unresolved_links, broken_anchors }` — link
  health for the resulting note, per the shared convention.
- **Delegation:** `expand()` then delegate to the existing body-write path:
  `append` → `append_note`'s core, `prepend` → `prepend_note`'s core,
  `section` → `append_to_section`'s core. Frontmatter in the expanded template
  is treated as body text here (we are inserting into an existing note's body,
  never rewriting its frontmatter block) — an explicit, documented choice.
- **Errors (fail loud):** template/folder errors as above; note not found;
  `position: "section"` with a missing section and `create_section` false;
  ambiguous section (lists candidate heading-paths).

## Components

- **`src/tools/templates.ts`** — folder + template resolution:
  - `resolveTemplateFolder()`: **config-first** — read the folder from
    `.obsidian/templates.json` (`folder` key), overridable by the
    `OBSIDIAN_TEMPLATE_FOLDER` env var (override wins when set). If neither is
    present, the folder is unconfigured (callers fail loud).
  - `resolveTemplate(name)`: map a template name/path to a file under the
    template folder; path-guarded via the same `resolveVaultFile` guard as
    `read_notes`. Not-found lists nearby candidates.
  - `readTemplate(name)`: return raw template text.
  - `listTemplates()`: enumerate the folder as headers.
- **`src/tools/template-expand.ts`** — the pure substitution engine:
  - `expand(text, { title, now }): string`. `now` is injected (a `Date`), so
    unit tests are deterministic. Handles the four placeholders + inline format
    overrides + `[literal]` escaping (delegated to dayjs); unknown `{{...}}`
    tokens **pass through literally** (report-only philosophy — never silently
    drop unrecognized syntax).
  - Default date/time formats come from `templates.json`
    (`dateFormat` / `timeFormat`); when unset, Obsidian's built-in defaults
    `YYYY-MM-DD` and `HH:mm`.
- **Tool wrappers** — `list_templates` / `apply_template` / `insert_template`
  registered in the server; the two write tools gated behind
  `OBSIDIAN_ALLOW_WRITES` (hidden from `list_tools` when off) and routed through
  the git guard, exactly like the existing eighteen write tools.
- **Query CLI** — `templates list`, `template apply`, `template insert`
  subcommands (the CLI is not gated by `OBSIDIAN_ALLOW_WRITES`).

## Data flow (expansion)

1. Resolve template folder (config-first, env override).
2. Resolve + read the named template's raw text.
3. Compute `title` from the **target note's basename** (destination for apply,
   existing note for insert).
4. `expand(raw, { title, now: new Date() })`:
   - `{{title}}` → `title`.
   - `{{date}}` / `{{time}}` → `dayjs(now).format(defaultDate/TimeFormat)`.
   - `{{date:FMT}}` / `{{time:FMT}}` → `dayjs(now).format(FMT)` (inline wins).
   - Unknown `{{...}}` → passed through unchanged.
5. Delegate the expanded text to the appropriate existing write path.

## Config & gating

- **Folder source:** `.obsidian/templates.json` first, `OBSIDIAN_TEMPLATE_FOLDER`
  override, else unconfigured → fail loud.
- **Write gating:** `apply_template` / `insert_template` behave identically to
  the rest of the write surface — hidden unless `OBSIDIAN_ALLOW_WRITES` is
  truthy, and each write passes through `snapshotBeforeWrite` when
  `OBSIDIAN_GIT_AUTOCOMMIT` is on (fail-closed if the snapshot can't be taken).
- **`list_templates`** is a read tool — always exposed.

## Error handling (summary)

All errors fail loud (consistent with existing tools):

- Template folder unconfigured → explicit setup error.
- Template not found → error listing nearby candidates.
- `apply_template` onto an existing note without `overwrite` → refuse.
- `insert_template` with an ambiguous section → error listing candidate
  heading-paths; with a missing section and `create_section` false → error.
- Path traversal on any path → guarded, same as `read_notes`.

## Testing

- **Unit — `expand()`** (deterministic, injected `now`): each placeholder;
  inline format overrides; `[literal]` escapes; combined tokens in one template;
  unknown-token passthrough; default-format sourcing from a synthetic
  `templates.json`; a handful of parity cases against known Obsidian outputs
  (`YYYY-MM-DD`, `dddd`, `Do MMMM YYYY`, `HH:mm`).
- **Unit — folder resolution:** config-only, env-only, both (override wins),
  neither (fail loud).
- **Integration (temp vault):**
  - `list_templates` envelope + pagination + unconfigured-folder error.
  - `apply_template`: creates note; `{{title}}` = destination basename;
    `overwrite` semantics; link-health fields present; git guard invoked when
    enabled; hidden/rejected when writes disabled.
  - `insert_template`: append / prepend / section placement; section fail-loud
    ambiguity; `create_section`; link-health in the envelope; gating + git
    guard.

## Documentation

Per the project's documentation rule, update **both**:

- **CLAUDE.md** — new tool descriptions under a Templates section; note the new
  `dayjs` dependency; add the folder-resolution + gating behavior; CLI examples.
- **README.md** — a Templates feature bullet and prerequisites/behavior note.

## Non-goals / future

- Templater interop (would need a JS sandbox — a separate, much larger design).
- Template-as-schema validation (a possible future `list_vault_issues` kind).
- A `get_template` that returns expanded-but-unwritten text (the read-only
  variant) — deferred; the three chosen tools cover the requested cases.
