# Fail-loud section writes + patch_note uniqueness guard

## Problem

The read side (`get_outline`, `read_section`) addresses sections with a
disambiguating `" > "`-joined heading-path (e.g. `Projects > Log`) and errors
loudly when a bare heading is ambiguous, listing the candidate full paths. The
write side does not. `locateSection` in `src/tools/note-document.ts` resolves a
bare heading to the **first** text match, with no ambiguity check and no
heading-path support. A note with two `Log` sections gets its first one
silently edited — the exact wrong-section write the read side was built to
prevent. The advertised loop ("check what sections exist, then edit the right
one") breaks at the edit step, precisely when it matters.

Separately, `patch_note` with `all:false` and a non-unique `find` silently
patches the first occurrence — the same fail-quiet failure mode on the tool most
likely to hit the wrong text.

## Part 1 — Fail-loud section writes

Replace `locateSection` with a resolver that mirrors `read_section` exactly,
reusing the shared `parseHeadings` + `headingPaths` from `src/tools/vault.ts`
(single source of truth — read and write sides never disagree).

**Addressing rules** (identical semantics and error-message shape to
`readSection`):

- Accepts a **bare heading** (`Log`) or a **`>`-joined heading-path**
  (`Projects > Log`), detected by the presence of `>`, with the same
  whitespace-normalizing `norm()` (split on `>`, trim each segment, re-join
  with `" > "`).
- Bare heading matching a single heading → resolves.
- Bare heading matching multiple headings → throws
  `Ambiguous section "Log"; candidates: Alpha > Log, Projects > Log`.
- Heading-path → matches the fully-qualified path exactly.
- Not found (either form) → throws `Section "<x>" not found`.

The resolver returns the matched heading plus its `bodyStart`/`bodyEnd` using the
existing section-boundary logic (end at the next heading of same-or-higher
level).

**Two distinct intents, kept separate:**

1. **Addressing** — used by `appendToSection` (heading), `replaceSection`
   (heading), and `addSection`'s `after` target. These get the fail-loud
   ambiguity behavior above.
2. **Duplicate-existence check** — `addSection` calls the locator with a `level`
   filter to reject creating a duplicate heading *at the same level*. This is a
   level-scoped existence test, not addressing: finding one match is enough to
   reject, and multiplicity is **not** an ambiguity error here. This path keeps
   the level filter and the "first match is enough" behavior.

The two intents are made explicit in code (separate helper or a flag) so they do
not blur.

## Part 2 — patch_note uniqueness guard

In `patchNote` (`src/tools/write.ts`), when `all` is false and `find` occurs
more than once, throw instead of patching the first:

> `Text to patch occurs 3 times in <note>; set all:true to replace all, or make find unique.`

- `all:true` — unchanged (replaces every occurrence).
- Single occurrence with `all:false` — unchanged (replaces the one).
- Absent `find` — unchanged (still errors "not found").
- No new parameters.

## Surface

- **Code:** `src/tools/note-document.ts` (resolver + three call sites);
  `src/tools/write.ts` (patch guard). MCP handlers and query-CLI pass the
  `heading`/`after`/`section`/`find` strings straight through, so no signature
  changes there.
- **Tests (TDD):**
  - `tests/note-document.test.ts` — ambiguous bare heading errors with candidate
    list; heading-path resolves the right (non-first) section for append /
    replace / `after`; duplicate same-level `addSection` still rejects.
  - `tests/edit-extras.test.ts` — patch non-unique `all:false` errors; `all:true`
    still replaces all; single occurrence still works. (The existing
    "replaces the first occurrence by default" test uses a two-occurrence
    fixture and must be updated to a single-occurrence fixture or converted to
    assert the new error.)
- **Docs:** `CLAUDE.md` and `README.md` — the `append_to_section`,
  `replace_section`, `add_section`, and `patch_note` sections gain the
  heading-path + fail-loud notes (CLAUDE.md's doc-sync rule requires both).

## Out of scope

- No `expected_replacements` parameter on `patch_note`.
- No section/body operations added to `bulk_edit`.
- No changes to the read-side tools.
