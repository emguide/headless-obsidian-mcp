# Tool policy: granular tool exposure via `OBSIDIAN_TOOLS`

## Goal

Let the operator choose exactly which tools the MCP server exposes — by domain
group, by read/write mode, or by individual tool — replacing the binary
`OBSIDIAN_ALLOW_WRITES` switch. Two motives: control over what an agent can do,
and token reduction (every hidden tool is schema the client never pays for).

## Configuration surface

One env var carries the whole policy:

```
OBSIDIAN_TOOLS="<selector>, <selector>, ..."
```

Selector tokens, case-insensitive, whitespace-tolerant, evaluated **left to
right** against a running set (plain token adds, `-` prefix subtracts):

| Token form | Meaning |
|---|---|
| `all` / `reads` / `writes` | meta-groups: every tool / all read-side / all write-side |
| `search`, `notes`, `sections`, `links`, `tags`, `properties`, `tasks`, `templates`, `files`, `vault`, `bulk` | a domain group (both modes) |
| `<group>.read` / `<group>.write` | one mode-slice of a group |
| `delete_note` (any tool name) | one individual tool |

Evaluation starts from the empty set. **Exception:** when the first token is a
subtraction, it starts from the default policy `reads` — so
`OBSIDIAN_TOOLS="-templates"` means "the read surface minus `list_templates`",
not "nothing minus templates". It deliberately does not start from `all`:
trimming a group from a read-only server must never silently expose the 21
write tools.

Unset var → policy `reads` (today's read-only default, unchanged).

Examples:

| Config | Exposed |
|---|---|
| unset | all read tools |
| `all` | everything |
| `-templates,-tasks` | reads minus `list_templates`, `list_tasks` |
| `reads,tasks.write,sections.write` | reads + task/section writes |
| `all,-bulk,-delete_note` | everything except `bulk_edit`, `delete_note` |
| `search,notes.read` | minimal search-and-read agent |

### Fail-loud validation (startup, before the transport connects)

- Unknown token (typo'd group/tool/slice) → exit with an error listing the
  valid vocabulary.
- Policy that evaluates to the empty set (e.g. `tasks,-tasks`, or an empty
  string) → exit; a server exposing zero tools is always a misconfiguration.
- A valid slice that happens to select nothing (`links.write` — links has no
  write tools) is allowed; it adds nothing and is not an error.
- `OBSIDIAN_ALLOW_WRITES` set at all → exit with a migration hint ("replaced by
  OBSIDIAN_TOOLS; use OBSIDIAN_TOOLS=all"). Silent read-only fallback for a
  config that expected writes is exactly the drift fail-loud exists to prevent.

## Taxonomy

Eleven groups covering the 44 gated tools; every gated tool belongs to exactly
one group. The 45th tool, `get_config`, is groupless and always exposed — it is
how an agent discovers the policy.

| Group | Read | Write |
|---|---|---|
| `search` | search_notes, search_notes_ranked | — |
| `notes` | read_notes, list_notes, list_recent_notes, resolve_note | write_note, append_note, prepend_note, patch_note, delete_note, move_note |
| `sections` | get_outline, read_section | add_section, append_to_section, replace_section, rename_section |
| `links` | get_links, get_related_notes | — |
| `tags` | list_tags, find_by_tag | add_tag, remove_tag |
| `properties` | get_frontmatter, list_properties, list_property_values, query_notes, get_property | set_frontmatter, add_property_values, remove_property_values, rename_property |
| `tasks` | list_tasks | set_task_state |
| `templates` | list_templates | apply_template, insert_template |
| `files` | list_files, list_folders | move_file |
| `vault` | get_vault_stats, list_vault_issues | — |
| `bulk` | — | bulk_edit |

`bulk_edit` stands alone (highest blast radius; `all,-bulk` must work without
knowing the tool name). `list_folders` sits in `files` as vault-filesystem
shape, next to `list_files`.

## Runtime behavior

- **`list_tools`**: excluded tools are absent from the listing — this is the
  token saving.
- **Call time** (defense in depth): calling an excluded tool returns an error
  naming the cause and the current policy: `excluded by OBSIDIAN_TOOLS;
  current policy: "..."`. Unknown tool names keep their existing error.
- **`get_config`**: never excludable. `writes.writes_enabled` becomes derived —
  `true` iff at least one write tool is exposed (`git_autocommit` unchanged).
  New `tools` section, and `"tools"` joins the valid `section` values:

```json
"tools": {
  "policy": "reads,tasks.write",   // raw env value, null when unset
  "exposed": ["..."],
  "excluded": ["..."]
}
```

- The query CLI stays ungated (operator's own tool).
- `OBSIDIAN_GIT_AUTOCOMMIT` is untouched: write safety, not write exposure.

## Implementation shape

- New module `src/tools/tool-policy.ts`: the tool registry (name → group +
  mode for the 44 gated tools), the selector parser, the evaluator, and
  `effectiveTools()` returning the exposed set (always including `get_config`).
- `src/tools/env-flags.ts`: add `TOOLS_ENV = "OBSIDIAN_TOOLS"`; remove
  `ALLOW_WRITES_ENV`/`writesEnabled()` (the retired-var check moves to the
  startup validation).
- `src/index.ts`: validate the policy once at boot; filter `list_tools` by the
  effective set; reject non-member calls with the policy error. `isWriteTool()`
  in `write.ts` remains the write-side membership test backing the `writes`
  meta-group and the derived `writes_enabled`.
- Startup/test assertion that every tool named in the server's `list_tools`
  registry has a taxonomy entry, so adding a tool without classifying it fails
  CI rather than silently drifting.

## Testing

Unit (`tool-policy`): token forms, case/whitespace tolerance, left-to-right
ordering and re-adding after subtraction, first-token-negative base, unknown
token error, empty-policy error, empty-slice tolerance, meta-groups, retired
`OBSIDIAN_ALLOW_WRITES` error.

Integration (server): `list_tools` filtering under representative policies;
call-time rejection message; `get_config.tools` contents and derived
`writes_enabled`; `get_config` exposed under every policy; taxonomy-covers-all
regression. Same style as the existing suite (`node:test` via tsx).

## Docs

CLAUDE.md and README: replace the `OBSIDIAN_ALLOW_WRITES` sections with the
`OBSIDIAN_TOOLS` grammar, the group table, the defaults, and the updated
`get_config` shape.
