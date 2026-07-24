# Daily Notes Interop — `resolve_daily_note`

**Date:** 2026-07-24
**Status:** Approved (user-specified minimal shape)

## Problem

"Append this to today's note" / "what did I log yesterday" is the most common
personal-vault agent task, and the server has no support for it. The agent must
be told the daily-notes folder and date format out-of-band, and silently breaks
when the user changes them in Obsidian — exactly the "worrying about vault
structure" this server exists to remove.

The vault already records the answer: the **Daily Notes core plugin** stores its
configuration in `.obsidian/daily-notes.json` (`folder`, `format`, `template`).
The server already has the pattern for reading plugin config config-first with
an env override and a fail-loud fallback (Templates, `src/tools/templates.ts`),
and already ships Moment-compatible date rendering via dayjs
(`src/tools/template-expand.ts`).

## Shape

One new read tool. Everything else is existing tools.

```
resolve_daily_note({ date? }) -> { date, path, exists, template }
```

- `date` (optional): `"YYYY-MM-DD"`, or a keyword `"today"` (default) /
  `"yesterday"` / `"tomorrow"` (case-insensitive). Anything else fails loud,
  listing the accepted forms. Keywords exist because the tool's whole purpose
  is removing out-of-band knowledge — an agent that doesn't know the current
  date can still say "yesterday".
- `date` (output): the resolved calendar date as ISO `YYYY-MM-DD` — echo for
  confirmability.
- `path`: canonical vault-relative note path **without `.md`** (the same note
  identity every other tool uses), i.e. `folder` + `/` + the date rendered with
  the configured Moment `format`. Formats containing `/` (e.g.
  `YYYY/MM/YYYY-MM-DD`) produce nested folders, exactly as in Obsidian. The
  path is traversal-guarded like every other note path.
- `exists`: whether that note currently exists on disk (fresh `stat`, not
  index-dependent — a just-created note is visible immediately).
- `template`: the plugin's configured daily-note template as a vault-relative
  path (normalized, `.md` stripped), or `null` when none is configured.

The `resolve_` verb fits the taxonomy: a date is a human-facing name being
mapped to a canonical path (`resolve_note` for titles/aliases,
`resolve_daily_note` for dates). Read-only; joins the `notes` group
(read side) in the `OBSIDIAN_TOOLS` taxonomy — no new group for a single tool.

Existing tools close the loop:

- create it → `apply_template(template, path)` (or `write_note` when no
  template is configured)
- log into it → `append_note` / `append_to_section`
- read yesterday → `read_notes` / `read_section`

## Config resolution (config-first, mirroring Templates)

New module `src/tools/daily-notes.ts`:

1. Read `.obsidian/daily-notes.json`. Missing keys take **Obsidian's own
   defaults**: `folder` → vault root, `format` → `YYYY-MM-DD`, `template` →
   none. An existing-but-empty `{}` config is therefore fully valid (plugin
   enabled, defaults untouched). Invalid JSON is treated as no config.
2. `OBSIDIAN_DAILY_FOLDER` overrides the folder (headless setups without a
   `.obsidian` dir), same as `OBSIDIAN_TEMPLATE_FOLDER` for templates. Format
   and template still come from the config file when present, else defaults.
3. Neither config file nor env override → **fail loud**: enable the Daily
   notes core plugin or set `OBSIDIAN_DAILY_FOLDER`. Guessing root/`YYYY-MM-DD`
   without evidence the plugin is in use would silently resolve wrong paths —
   the exact failure mode this tool exists to kill.

Date rendering: `dayjs(date).format(format)` with the `advancedFormat` plugin
already shipped for `{{date:...}}` — one date engine, not two. Local timezone,
matching how Obsidian renders for the user. Input parsing is strict
(`customParseFormat`), so `2026-13-45` fails loud.

## In-scope glue: template resolution accepts vault paths

`daily-notes.json`'s `template` is an **arbitrary vault path** — it is not
required to live in the Templates folder, and daily notes can be configured
with no Templates folder at all. Today `apply_template`/`insert_template`
resolve template names only inside the configured Templates folder, so the
stated flow (`resolve_daily_note` → `apply_template`) would break for those
vaults.

Fix, in `src/tools/templates.ts` (`readTemplate`):

1. If a Templates folder is configured, resolve `template` inside it first —
   **existing behavior, unchanged precedence**.
2. Otherwise (not found there, or no folder configured), try `template` as a
   vault-relative note path (`.md` optional).
3. Still nothing → the existing fail-loud error, now also noting that
   vault-relative paths are accepted.

`expandTemplateFor` correspondingly tolerates an unconfigured Templates folder
(date/time formats fall back to Obsidian defaults) when the template resolved
via the vault path. `apply_template(template: <resolve_daily_note's template>,
path: <its path>)` therefore always works.

**Caveat (documented, not solved):** `{{date}}`/`{{time}}` in a template expand
with *now*, exactly like Obsidian's core plugin (which only ever creates
today's note). Creating a **past** daily note from a template containing
`{{date}}` stamps today's date in the body. Plumbing a date override through
`apply_template` is out of scope until someone actually needs it (YAGNI);
`{{title}}` already renders the date-formatted basename, matching Obsidian.

## get_config

New `daily` section — `{ folder, format, template }` — reported leniently
(`folder: null` when unconfigured, no throw), mirroring the `template`
section. Added to the `section` enum. `get_config` remains the discovery
surface for "how is this server set up?".

## Alternatives considered

- **A full `get/create_daily_note` tool** (à la other Obsidian MCP servers):
  rejected — it would duplicate `apply_template`/`append_note` behavior behind
  a second write surface and violate the no-merges/one-intent taxonomy.
- **A new `daily` policy group**: rejected — one read tool doesn't justify a
  12th group; `notes.read` already means "note addressing and reading".
- **Periodic notes (weekly/monthly)**: out of scope — that's a community
  plugin with different config; the core plugin is daily-only.

## Testing

`tests/daily-notes.test.ts` (+ additions to `tests/templates.test.ts`,
`tests/config-cli.test.ts` pattern for get_config):

- Config: full config read; `{}` → Obsidian defaults; env override; invalid
  JSON → treated as absent; absent + no env → fail loud.
- Dates: default today (injected `now` for determinism); keywords;
  explicit date; strict parse rejection.
- Paths: custom format; format with `/` → nested path; `.md`-less identity;
  traversal attempt (folder or format escaping the vault) rejected.
- `exists` true/false; `template` normalization and `null`.
- Template fallback: vault-path template outside the folder; template works
  with **no** templates.json; folder-relative precedence unchanged; not-found
  error still lists available templates.
- Policy/config: tool classified in `notes`; `get_config` `daily` section.

## Docs

CLAUDE.md and README both gain the tool section, the `OBSIDIAN_DAILY_FOLDER`
env var, the `daily` get_config section, the query-CLI `daily` command, and the
template vault-path fallback note (project rule: both files, always).
