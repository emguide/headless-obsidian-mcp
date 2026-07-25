# Writer name resolution — closing the reader/writer addressing asymmetry

**Date:** 2026-07-25
**Status:** Design — awaiting review

## Problem

Readers forgive addressing; writers don't. `get_frontmatter("alpha")` resolves a
bare basename (`alpha` → `projects/alpha`) or a wrong-case path
(`Projects/Alpha` → `projects/Alpha`) through the shared index before reading.
But `patch_note` / `add_tag` / `delete_note` / etc. with the same
`path: "alpha"` fail — writers address by the *literal* filesystem path.

The irony: the writer's own not-found error already runs the did-you-mean
builder and says `Did you mean: projects/alpha?` — naming the exact note it just
refused to write. The writer *computes* the resolution; it just spends the
answer on an error message instead of on completing the operation.

This is defensible as "writes are literal," but the asymmetry surprises agents:
a name that addresses a note for reading silently stops addressing it for
writing, with no signal beyond a not-found error that then points at the very
note that would have worked.

### Mechanism (why the two diverge)

| | Resolves via | Behavior on `"alpha"` |
|---|---|---|
| Readers | `resolveNoteName(index, path)` → `index.resolve(canon)` before disk (`not-found.ts:35`) | `alpha` → `projects/alpha` |
| Writers | `resolveNotePath(vaultPath, path)` — pure `join(vault, path + ".md")` (`vault.ts:41`) | `alpha` → `<vault>/alpha.md` (missing) → not-found |

`resolveNotePath` never consults the index. It is a string-to-filesystem-path
join plus a traversal guard. The index is only touched afterward, by
`noteNotFoundError` → `didYouMean`, to build the error suffix.

## Goal

Make **edit-existing** write tools address notes the same way readers do:
resolve a bare basename or wrong-case path through the shared index before
touching disk. Keep the safety property that made the literal behavior
defensible — a write never silently mutates a note the agent did not clearly
identify — by **failing loud on an ambiguous bare name** instead of silently
picking one.

## Non-goals

- **Create paths stay literal.** `write_note`, `apply_template`, and the
  `create: true` paths of `append_note` / `prepend_note` name a note that may
  not exist yet. Resolving there could redirect an intended new root note onto
  an existing folder note (a clobber-refusal, or worse a clobber under
  `overwrite: true`) — a destructive surprise readers can never cause. The
  create path is out of scope and unchanged.
- **No title/alias resolution.** Readers deliberately resolve path/basename but
  *not* title or alias (that is `resolve_note`'s job — see CLAUDE.md "Note
  addressing"). Writers match exactly: same `index.resolve` semantics, nothing
  broader. `"Alpha Project"` (a title) remains a not-found write target.
- **No fuzzy matching.** Exact case-insensitive path/basename equality only, as
  today.

## Semantics — the resolution contract

For an edit-existing writer given `path`:

1. **Exact path (case-insensitive).** If `path` names a note by full relative
   path (any case), resolve to that note's canonical path. `Projects/Alpha` →
   `projects/Alpha`.
2. **Unique bare basename.** If `path` is slash-less and exactly one note has
   that basename, resolve to it. `alpha` → `projects/alpha`.
3. **Ambiguous bare basename → fail loud.** If `path` is slash-less and *more
   than one* note shares that basename, error and list the candidates, e.g.

   ```
   Ambiguous note name: log. Candidates: daily/log, projects/log.
   Pass the full path.
   ```

   The write does not happen. This is the write-appropriate divergence from
   readers/`get_links`, which silently pick the shortest-path candidate — a
   fine default for a read, a wrong-note *mutation* for a write.
4. **Slash-qualified miss → literal.** A slash-qualified `path` that names no
   note gets no basename fallback (mirroring `index.resolve`), falls through to
   the literal path, and produces the usual not-found error with did-you-mean
   candidates. `wrong-folder/alpha` stays a broken address, never a silent hop
   to a same-basename note elsewhere.
5. **No match → literal.** Falls through to the literal path; the existing
   not-found-with-suggestions error is produced exactly as today.

Cases 1, 2, 4, 5 are precisely `index.resolve`'s existing behavior. The *only*
new behavior is case 3: surfacing ambiguity that `index.resolve` currently hides
behind its shortest-path pick.

### Precedent this extends

Index-resolution-on-write is not novel here. `move_note` (`write.ts:474`) and
`rename_section` (`write.ts:658`) already call `index.resolve(canon)` on their
target — for backlink-key correctness on case-insensitive filesystems. This
design generalizes that already-accepted pattern to the rest of the
edit-existing writers, and adds the fail-loud-on-ambiguity guard those two do
not currently have (a latent wrong-note risk in them too — see "Incidental
hardening").

## Design

### New primitive: `VaultIndex.resolveForWrite`

`index.resolve` cannot back this directly: it returns `candidates[0]` for an
ambiguous basename and cannot distinguish "unique" from "ambiguous" (both
`byPath` and `byBasename` are private). Add one public method that exposes the
distinction:

```ts
type WriteResolution =
  | { kind: "resolved"; path: string }        // exact or unique basename
  | { kind: "ambiguous"; candidates: string[] } // slash-less, >1 basename match
  | { kind: "unresolved" };                    // no match → caller uses literal

resolveForWrite(target: string): WriteResolution
```

Logic mirrors `resolve` up to the branch point:
- exact `byPath` hit → `resolved`
- slash present and no exact hit → `unresolved` (no basename fallback)
- slash-less: `byBasename` list of length 1 → `resolved`; length > 1 →
  `ambiguous` (candidates sorted, the existing `byBasename` ordering); length 0
  / absent → `unresolved`

`resolve` stays as-is (readers and the link graph keep silent shortest-path
picking — correct for them). `resolveForWrite` is the write-only variant.

### Shared helper: `resolveWriteTarget`

In `not-found.ts` (where `resolveNoteName` already lives), add:

```ts
/** Resolve a write target's name to a canonical path, failing loud on an
 *  ambiguous bare basename. Returns the canonical name unchanged when the name
 *  does not resolve, so the caller's existing not-found path still fires. */
export function resolveWriteTarget(index: VaultIndex, notePath: string): string
```

- `resolved` → return the canonical path.
- `ambiguous` → throw `Ambiguous note name: <name>. Candidates: <a>, <b>. Pass
  the full path.`
- `unresolved` → return `canonical(notePath)` unchanged (parity with
  `resolveNoteName`'s fall-through, so create paths and genuine misses behave
  exactly as before).

And an async convenience for sites that don't already hold an index (parallel to
`noteNotFoundError`):

```ts
export async function resolveWriteTargetAsync(
  vaultPath: string, notePath: string
): Promise<string>
```

Never masks a real failure: if the index can't be built, it returns
`canonical(notePath)` and the write proceeds on the literal path (degrading to
today's behavior), *except* it still throws the ambiguity error when the index
*is* available and reports ambiguity — ambiguity is a caller error worth
surfacing, not an index hiccup to swallow.

### Insertion points

Two chokepoints cover every edit-existing writer:

1. **`readRaw` (`write.ts:169`)** — the read-before-edit funnel. `editNote`
   calls it, so it covers **add_tag, remove_tag, set_frontmatter,
   add/remove_property_values, rename_property, add_section,
   append_to_section, replace_section**, plus **patch_note** and the
   *existing-note* branch of **append_note / prepend_note** (which call `readRaw`
   directly). Resolve at the top of `readRaw`:

   ```ts
   export async function readRaw(vaultPath, notePath) {
     const resolved = await resolveWriteTargetAsync(vaultPath, notePath);
     const fullPath = resolveNotePath(vaultPath, resolved);
     ...
   }
   ```

   The append/prepend *create* branch checks `fileExists` on the literal path
   *before* `readRaw`, so a `create: true` call on a bare name still creates the
   literal note — create path stays literal, as required. (An existing note
   reachable by bare name will `fileExists`-miss on the literal path and route
   into the create branch — see "Edge cases" for why this is acceptable and how
   it's handled.)

2. **Direct `resolveNotePath` callers** — the tools that bypass `readRaw`:
   **delete_note**, **move_note** (source `from`), **set_task_state**, and
   **bulk_edit**'s per-note loop. Each resolves the name once up front. Two of
   these — `move_note` and `rename_section` — already do `index.resolve(canon)`;
   they switch to `resolveForWrite` so their existing resolution gains the
   ambiguity guard (and `delete_note` / `set_task_state` / `bulk_edit` gain
   resolution they lacked).

3. **insert_template** — needs **no resolution logic of its own**: it delegates
   entirely to `appendNote` / `prependNote` / `appendToSection` (all without
   `create`), which take the existing-note `readRaw` branch and therefore
   inherit resolution from insertion point 1. The one adjustment is cosmetic —
   its echoed `path` field (`templates.ts:304`) currently returns the raw input;
   align it with the resolved name for output consistency (or read it back from
   the delegate's returned `path`, which is already resolved).

Because `resolveWriteTarget` returns the name unchanged when nothing resolves,
inserting it is **additive**: every existing test where `path` is already
canonical is unaffected, and every existing not-found error still fires
(now on the resolved-or-literal name).

### What each writer's git message / output reports

Writers currently label their git commit and echo their `path` output via
`canonicalName(path)` — the *input* name. After resolution these should report
the **resolved** canonical path (the note actually written), so the commit
message and the returned `path` name the real target, not the bare input. This
is a small, consistent change at each call site (resolve once, use the resolved
name for both the write and the reported fields).

## Edge cases

- **Existing note reachable only by bare name, via a create-capable tool.**
  `append_note("alpha", create: true)` where `projects/alpha` exists but no root
  `alpha.md`: the `fileExists` check is on the *literal* path, misses, and the
  create branch makes a new root `alpha.md`. This is the create-path non-goal
  in action — create is literal by design. Documented, not fixed: an agent that
  wants to append to `projects/alpha` addresses it as such, or uses
  `append_note` without `create`. (Without `create`, resolution applies and it
  reaches `projects/alpha`.) This exactly matches how `write_note` already
  treats a bare name.
- **Ambiguous name on a create-capable tool's edit path.** `append_note("log")`
  (no `create`) where two `log` notes exist: fails loud with candidates, same as
  every other edit-existing writer. Good — the alternative is a silent
  not-found on the literal `log.md`.
- **`bulk_edit` with explicit `paths`.** Each path resolves independently; an
  ambiguous one becomes that note's per-note `{ ok: false, error }` (isolated,
  not batch-sinking — consistent with bulk's existing per-note error handling).
  A filter-based selection already yields canonical paths from the index, so it
  resolves trivially (no-op).
- **`move_note` destination `to`.** The *destination* is a create target and
  stays literal (you are naming where the note should go). Only `from` resolves.
- **Case-only rename.** `move_note("Alpha", "alpha")` on a case-insensitive FS:
  `from` resolves to the real `Alpha`; existing same-note guard and rename logic
  are unchanged.

## Incidental hardening

`move_note` and `rename_section` currently call `index.resolve`, which silently
picks a shortest-path winner for an ambiguous bare `from`. Switching them to
`resolveForWrite` closes that latent wrong-note-mutation gap too: an ambiguous
`from` now fails loud instead of renaming/moving whichever note sorts first.
This is a strict safety improvement, not a behavior change for any unambiguous
input.

## Testing

- **Unit — `resolveForWrite`:** exact-path (case variants), unique basename,
  ambiguous basename (→ `ambiguous` with sorted candidates), slash-qualified
  miss (→ `unresolved`, no fallback), no match (→ `unresolved`).
- **Unit — `resolveWriteTarget`:** resolved passthrough, ambiguous throws with
  candidate list in the message, unresolved returns input canonical unchanged.
- **Integration — per edit-existing writer:** bare-name write hits the right
  note (`add_tag("alpha")` tags `projects/alpha`); wrong-case write hits the
  right note; ambiguous bare name fails loud without writing (assert file
  unchanged + git has no new commit); genuine miss still errors with
  did-you-mean; slash-qualified miss still errors (no silent hop).
- **Create-path guards (regression):** `write_note("alpha")` still creates root
  `alpha.md` even when `projects/alpha` exists; `append_note("alpha",
  create:true)` likewise; `apply_template` likewise.
- **`move_note` / `rename_section` ambiguity:** ambiguous `from` now fails loud
  (new); unambiguous `from` behavior unchanged (regression).
- **`bulk_edit`:** ambiguous explicit path isolates to one `{ ok:false }` row;
  the rest of the batch still applies.

## Documentation

Per CLAUDE.md's "update both docs" rule, add a shared **"Note addressing on
writes"** convention paragraph alongside the existing "Note addressing"
(readers) section in both CLAUDE.md and README: edit-existing writers resolve a
bare basename or wrong-case path through the shared index exactly as readers do,
except an ambiguous bare name fails loud (listing candidates) rather than
picking one, and create paths stay literal. State it once; write-tool
descriptions carry no repetition (they already omit the reader-addressing
convention). Also note the `move_note`/`rename_section` ambiguity hardening.

## Files touched

- `src/tools/vault-index.ts` — add `resolveForWrite` (+ `WriteResolution` type).
- `src/tools/not-found.ts` — add `resolveWriteTarget` / `resolveWriteTargetAsync`.
- `src/tools/write.ts` — resolve in `readRaw`; resolve `from`/target in
  `delete_note`, `move_note`, `set_task_state`; switch `move_note` /
  `rename_section` from `resolve` to `resolveForWrite`; report resolved path in
  outputs/messages.
- `src/tools/bulk.ts` — resolve each explicit path in the per-note loop.
- `src/tools/templates.ts` — no resolution logic (inherited via the delegates);
  only align `insert_template`'s echoed `path` with the resolved name.
- `src/types.ts` — `WriteResolution` if it lives there rather than vault-index.
- Tests + CLAUDE.md + README.
