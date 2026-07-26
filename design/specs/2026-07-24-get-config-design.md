# get_config — read the server's own configuration

## Problem

The server's configuration is currently invisible to the agent. There is no way
to ask "where is the template folder?", "are writes even enabled?", or "which
vault am I pointed at?" — the answers are only recoverable as side effects of
other tools. The template folder, for instance, is derivable only from a
*non-empty* `list_templates` result (each row's `path` is prefixed by the
folder); on an empty template folder it is not recoverable at all. Whether the
write tools exist can only be inferred from their presence or absence in
`list_tools`. The vault path is not surfaced anywhere.

A single read tool that reports the server's own configuration closes this gap
and gives a natural home for future config surfaces.

## Solution

A new read tool, `get_config`, returning the server's configuration as a single
object, optionally narrowed to one section. Answers "how is this server
configured?" — distinct from `get_vault_stats`, which answers "what is in the
vault?". Read-only and **never gated** by `OBSIDIAN_ALLOW_WRITES`: it is how an
agent *discovers* whether writes are enabled, so gating it behind the write flag
would defeat its purpose.

### Taxonomy fit

`get_` returning "the vault as a single object" already justifies
`get_vault_stats` in the verb taxonomy (CLAUDE.md). `get_config` is the same
shape — one addressed thing, the server itself. Not `list_` (it enumerates no
vault-wide collection).

### Signature

- **Input**:
  - `section` (optional): one of `"template" | "writes" | "vault"`. Absent →
    the whole config object. An unknown section value errors loudly, listing the
    valid sections (fail-loud, matching the codebase's house style).
- **Output** (no `section`):
  ```jsonc
  {
    "template": { "folder": string | null, "date_format": string, "time_format": string },
    "writes":   { "writes_enabled": boolean, "git_autocommit": boolean },
    "vault":    { "path": string }
  }
  ```
  With `section`, the tool returns just that section's object, unwrapped:
  ```jsonc
  // get_config({ section: "template" })
  { "folder": "Templates", "date_format": "YYYY-MM-DD", "time_format": "HH:mm" }
  ```

### Section behavior

- **`template`** — from `resolveTemplateConfig` (`src/tools/templates.ts`).
  - `folder`: the resolved template folder, or `null` when neither
    `.obsidian/templates.json` nor `OBSIDIAN_TEMPLATE_FOLDER` yields one.
    **This is the one real behavioral decision.** The existing template tools
    *throw* when no folder is configured (an unconfigured folder is a setup
    error for them); `get_config` must **not** throw — reporting "no template
    folder is configured" is a valid, useful answer. So `get_config` calls a
    non-throwing variant of the resolver, or catches the resolver's throw and
    maps it to `folder: null`.
  - `date_format` / `time_format`: the **effective** formats — the values from
    `templates.json` when set, else Obsidian's built-in defaults `YYYY-MM-DD`
    and `HH:mm`. Never `undefined`, so a caller always sees what a bare
    `{{date}}` / `{{time}}` will actually render as.
- **`writes`** — from `src/tools/env-flags.ts`.
  - `writes_enabled`: `writesEnabled()` (`OBSIDIAN_ALLOW_WRITES`).
  - `git_autocommit`: `gitGuardEnabled()` (`OBSIDIAN_GIT_AUTOCOMMIT`).
  - Pure booleans; no vault or filesystem access.
- **`vault`** — `{ path }` only: the `OBSIDIAN_VAULT_PATH` the server booted
  with. **Deliberately minimal.** Counts, sizes, and link stats stay in
  `get_vault_stats`; `vault` here reports *configuration* (which vault), not
  *contents* (what's in it), so the two tools do not overlap or drift.

## Structure

- **New `src/tools/config.ts`**:
  - `resolveServerConfig(vaultPath: string): Promise<ServerConfig>` — builds the
    full object (template section via the non-throwing template resolve, writes
    section via env-flags, vault section from `vaultPath`).
  - A section selector that returns the whole object or one unwrapped section,
    throwing on an unknown section name with the valid list.
- **`src/index.ts`**: register `get_config` in `list_tools` (always exposed,
  ungated) and add its dispatch case.
- **`src/query-cli.ts`**: a `config` subcommand (`config`, `config template`,
  `config writes`, `config vault`) — the operator's read path, ungated like the
  rest of the CLI.
- **Docs**: add a `get_config` section to both CLAUDE.md and README.md per the
  documentation-updates rule, plus a query-CLI example line.

## Testing

Unit tests over `resolveServerConfig` and the section selector:

- Unconfigured template folder → `template.folder === null` (a resolve, **not**
  a throw) — the load-bearing deviation.
- `OBSIDIAN_TEMPLATE_FOLDER` override wins over `templates.json`'s folder.
- Effective date/time format fallback: unset → `YYYY-MM-DD` / `HH:mm`; set in
  `templates.json` → the configured value.
- `writes` booleans track `OBSIDIAN_ALLOW_WRITES` / `OBSIDIAN_GIT_AUTOCOMMIT`.
- `vault.path` echoes the vault path the resolver was given.
- Section filter: each of `template` / `writes` / `vault` returns the right
  unwrapped slice; no `section` returns the full object; an unknown section
  throws, and the message lists the valid sections.

## Non-goals

- No writing of config (no `set_config`) — this is a read tool. The "expand in
  the future" path is *adding sections* to the returned object, not adding a
  setter.
- No vault contents in the `vault` section — that is `get_vault_stats`.
- No new env vars or config sources — it reports the ones that already exist.
