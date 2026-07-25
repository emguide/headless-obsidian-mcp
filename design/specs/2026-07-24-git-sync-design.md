# Git Sync — from autocommit guard to full remote sync

**Date:** 2026-07-24
**Status:** Approved design, ready for implementation planning

## Problem

The vault's git integration today is a single ~60-line pre-write guard
(`src/tools/git-guard.ts`, `snapshotBeforeWrite`). Gated by the
`OBSIDIAN_GIT_AUTOCOMMIT` env flag, it commits the vault's *pre-write* state
before each mutation and leaves the agent's change **uncommitted** for review.
It is purely local and pre-write: no remote, no pull, no push, no conflict
handling.

The target workflow is **multi-device, single-user** — the same vault is edited
from Obsidian on a laptop/phone *and* through this MCP server, and all changes
should converge through a shared git remote (the Obsidian Git plugin model).
That requires the two things the current guard deliberately avoids: **remote
round-trips** and **merge conflicts**.

## Goals

- Every write becomes a real, immediately-committed local commit with a
  meaningful, tool-derived message (no more leave-it-uncommitted semantics).
- Remote convergence (pull + push) with an env-selected cadence: per-write or
  on a background timer.
- Conflicts never block a write and never lose data — divergence is preserved
  as a first-class, queryable note.
- Fail-closed safety guarantee preserved: when remote sync is required and
  cannot be done, the write is refused (same contract as today's guard).
- Minimal agent-facing surface: **no new sync tools**. Discovery of conflicts
  and sync state reuses existing tools (`list_vault_issues`, `get_config`,
  `get_vault_stats`).

## Non-goals

- Multi-user / concurrent-writer coordination beyond single-user multi-device.
- A `sync_vault` tool or any other new tool in the write surface. (Explicitly
  rejected: env-driven only.)
- Injecting git conflict markers into notes, or a three-way merge UI.
- Carrying a sync/conflict signal in individual write tools' return values.

## Design

### 1. The core shift: commit-per-write

The pre-write-snapshot model is **retired**. Where the funnel previously called
`snapshotBeforeWrite(vaultPath)` (committing the state *before* the change), it
now commits the change *itself* after writing. A write becomes:

```
1. [pull phase — only when mode = "every-write"]   pull()
2. write file(s)                                    (existing writeResolved)
3. commit  (structured, tool-derived message)
4. [push phase — only when mode = "every-write"]   push()
```

In **timer** mode, steps 1 and 4 are skipped per-write; a background
`setInterval` runs pull+push on a period. In **commit** mode, only steps 2–3
run (local history, no remote). The local commit (2–3) always happens inline in
every mode except `off` — so writes are always durable local commits, and *when*
they reach the remote is the only variable.

Multi-file operations (`move_note` updating backlinks, `bulk_edit`,
`rename_section`) run the phases **once per operation**, not per file: in
`every-write` mode a single pull precedes the batch and a single push follows
it, and all files are committed in **one** commit after they are written —
preserving today's "one snapshot per batch" property so a batch still reviews
and reverts as a single diff.

**New module `src/tools/git-sync.ts`** holds the engine: `pull()`, `push()`,
`syncOnce()`, `commitWrite(message)`, and conflict handling. It reuses the
single `git()` execFile helper. `git-guard.ts`'s `snapshotBeforeWrite` is
replaced by the sync engine's commit path; the `git()` helper and fail-closed
error shaping are carried over.

### 2. Configuration (env surface)

Following `src/tools/env-flags.ts` conventions.

| Var | Values | Meaning |
|---|---|---|
| `OBSIDIAN_GIT_SYNC` | `off` (default) / `commit` / `every-write` / `timer` | Master mode. `off` disables git integration entirely. `commit` = commit-per-write, no remote. `every-write` = pull/commit/push per write. `timer` = commit-per-write + background pull/push. |
| `OBSIDIAN_GIT_SYNC_INTERVAL` | seconds (default `300`) | Timer period; read only in `timer` mode. |
| `OBSIDIAN_GIT_REMOTE` | remote name (default `origin`) | Remote to pull/push against. Branch is inferred from current HEAD. |

**Migration of `OBSIDIAN_GIT_AUTOCOMMIT`:** warn-and-map, not hard-error (unlike
the retired `OBSIDIAN_ALLOW_WRITES`, which hard-errors — autocommit is a working
feature people may rely on). If `OBSIDIAN_GIT_AUTOCOMMIT` is set truthy and
`OBSIDIAN_GIT_SYNC` is unset, the server maps it to `OBSIDIAN_GIT_SYNC=commit`
and emits a one-time deprecation warning to stderr. If both are set,
`OBSIDIAN_GIT_SYNC` wins (still warn).

**Fail-closed:** `every-write`/`timer` with no reachable remote, no git binary,
or a non-repo vault → the write is **refused** (same guarantee as today).
Exception: in `timer` mode a *background* push failure cannot refuse an
already-completed write — it is recorded (see §4) and surfaced via
`get_config.sync.last_error`, not swallowed.

### 3. Conflict handling — keep both, report

On a pull that cannot fast-forward and produces a conflict:

1. Pull uses a **merge** (not rebase) so conflict state is well-defined and the
   merge is abortable to a clean tree on unexpected failure.
2. For each conflicted note, the engine writes the **local** version aside as a
   **conflict copy**: `projects/alpha (conflicted 2026-07-24 143022).md`
   (timestamped to avoid collisions, mirroring `delete_note`'s `.trash`
   disambiguation). Byte-for-byte the local content — **no `<<<<<<<` merge
   markers injected**, so the copy stays a valid note the index can read.
3. The **remote** version is taken as canonical for the original path, so the
   merge completes and the repo converges to a clean tree.
4. The conflict copy is committed and pushed, so it exists on every device; the
   human reconciles later in Obsidian.

Net: nothing is ever lost, the repo always ends clean and converged, and the
divergence is preserved as a first-class note. This is the git analogue of the
codebase's report-only pattern (`dangled_backlinks`, `unresolved_links`) — the
sync is never blocked or silently mangled.

**Terminal-artifact guard:** existing `(conflicted …)` copies are excluded from
*triggering* new conflict copies (they are already terminal artifacts), so a
conflict copy can never spawn an infinite family — mirroring how `.trash` is
excluded from the index.

### 4. Conflict discovery & reporting — reuse `list_vault_issues`

Per CLAUDE.md ("a new vault-hygiene finding becomes a `kind` of
`list_vault_issues`, not a new tool"), an unreconciled conflict copy is a
hygiene finding. This also honors the "no new sync tools" decision — no
standalone conflict tool either.

**New `list_vault_issues` kind: `"conflicts"`.** Returns unreconciled conflict
copies as note headers (same shape as `orphans`), each paired with the canonical
note it diverged from:

```json
{ "results": [ { "path": "projects/alpha (conflicted 2026-07-24 143022)",
                 "original": "projects/alpha",
                 "created": "2026-07-24T14:30:22Z" } ],
  "returned": 1, "skipped": 0, "omitted": 0, "truncated": false }
```

Detection is a **filename-pattern scan over the index** (the
`(conflicted YYYY-MM-DD HHMMSS)` suffix) — index-backed, no git call, and
mode-independent (works the same whether the conflict was created here or pulled
in from another device). Obeys the shared `limit`/`offset` pagination
convention.

`get_vault_stats` gains a matching **`conflict_notes`** count, mirroring the
guaranteed `orphans` ↔ `orphan_notes` relationship.

**This closes the timer-mode reporting gap.** Since write tools return
link-health (not sync status) and timer-mode syncs have no return value at all,
the `conflicts` kind is the durable, mode-independent report of what happened —
however a conflict arose.

**Write-time signal:** *none.* Write tools keep their current return shape
across all modes. A synchronous (`every-write`) conflict is discovered the same
way as any other: via `list_vault_issues("conflicts")` / `get_config`. Uniform
contract, no mode-dependent fields.

### 5. Config visibility

`get_config` gains a **`sync`** section:

```json
{ "sync": { "mode": "timer", "interval": 300, "remote": "origin",
            "last_sync": "2026-07-24T14:30:00Z", "last_error": null } }
```

`writes.git_autocommit` becomes **`writes.git_sync`** (the mode string). The old
field is dropped — config output is not a stability contract, and it is
documented in the migration note. This is how an agent discovers the active sync
mode (the role `tools` plays for the policy). `sync` is addressable as a
`get_config` section like the others.

## Testing

- Sync engine tested against **local bare-repo remotes** (`git init --bare` +
  clone in a temp dir) — no network, fully deterministic. Reuses the existing
  `node:test` harness.
- **Conflict test:** two clones diverge on the same note → sync → assert exactly
  one conflict copy exists, the canonical path holds the remote version, and the
  tree is clean.
- **Terminal-artifact test:** a conflict copy present, then another conflict →
  assert no second-order copy of the copy.
- **Mode tests:** `commit` (local commit, no remote interaction), `every-write`
  (pull/commit/push sequence), `timer` (`syncOnce()` called directly rather than
  waiting on the interval).
- **Fail-closed tests:** `every-write` with unreachable remote / non-repo /
  missing git → write refused; `timer` background failure → recorded in
  `last_error`, write not refused.
- **Migration test:** `OBSIDIAN_GIT_AUTOCOMMIT=1` alone maps to `mode: "commit"`
  with a warning; `OBSIDIAN_GIT_SYNC` set alongside it wins.
- `list_vault_issues("conflicts")` and the `conflict_notes` stat: assert the
  count relationship holds for the unbounded result.

## Documentation

Per the repo rule (update CLAUDE.md and README.md together):

- "Git guard" section → "Git sync": the mode vocabulary, env table, and
  fail-closed contract.
- New `list_vault_issues` `conflicts` kind in the tool reference and the
  count-relationship note in `get_vault_stats`.
- New `get_config.sync` section and the `writes.git_sync` rename.
- The `OBSIDIAN_GIT_AUTOCOMMIT` → `OBSIDIAN_GIT_SYNC` migration note.

## Open questions

None. All design forks resolved during brainstorming:
- Scenario: multi-device single-user.
- Cadence: commit-per-write always; remote cadence env-selected
  (`every-write` | `timer`).
- Conflicts: keep both, report (conflict copies).
- Commit messages: structured, tool-derived.
- Sync tool surface: env-driven only, no new tools.
- Conflict discovery: new `list_vault_issues` kind (extend, don't add a tool).
- Write-time conflict signal: rely on the `conflicts` kind only.
```
