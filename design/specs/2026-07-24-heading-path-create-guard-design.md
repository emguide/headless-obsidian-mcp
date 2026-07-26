# Fail-loud on creating a section addressed by a heading-path

## Problem

`" > "` is addressing vocabulary throughout the section tools: `read_section`,
`append_to_section`, `replace_section`, `add_section`'s `after`, and
`rename_section` all read `Projects > Log` as "the `Log` section nested under
`Projects`". `resolveSection` (`src/tools/note-document.ts`) detects it by the
presence of `>` and matches the fully-qualified heading-path.

One path breaks that meaning. `appendToSection(doc, heading, content, create=true)`
on a **missing** section recovers by calling `addSection(doc, heading, content)`
([note-document.ts:485-487](../../../src/tools/note-document.ts#L485-L487)).
`addSection` writes the heading line as `${"#".repeat(level)} ${heading.trim()}`
([note-document.ts:446](../../../src/tools/note-document.ts#L446)) — literal text.
So `append_to_section` with `create:true` on a missing `Projects > Log` silently
produces a single heading whose literal text is `Projects > Log`:

```
## Projects > Log
<content>
```

The same string means "nested address" when resolving and "literal text with a
`>` in it" when creating. `insert_template`'s `create_section` inherits the bug —
it routes through the same `appendToSection(..., create: create_section)` call
([templates.ts:281](../../../src/tools/templates.ts#L281)).

This is the last `" > "`-addressing site that fails quiet, directly against the
philosophy the prior fail-loud-section-writes work established
(`2026-07-22-fail-loud-section-writes-design.md`).

## Fix

Fail loud. A heading-path names a location *inside existing structure*
(`Projects > Log` = "Log under Projects"). When that structure is absent, there
is no well-defined note to create — we cannot know the parent's heading level or
whether it should exist at all. So the `create` recovery must refuse a
heading-path rather than fabricate a literal-text heading.

In `appendToSection`'s `create && /not found/` recovery branch, before calling
`addSection`, test whether `heading` is a heading-path (contains `>`). If it is,
throw instead:

> `Cannot create section "Projects > Log": a heading-path addresses a section inside existing structure and cannot be created. Create the section with a bare heading, or create the parent first.`

A **bare** heading with `create:true` is unchanged — that is the legitimate
create case and stays exactly as it is (`## Later` from `appendToSection(doc,
"Later", "todo", true)`).

Ambiguity ordering is unaffected: `resolveSection` throws the ambiguity error
before we ever reach the `not found` recovery branch, so an ambiguous bare
heading still errors with candidates (never silently created), exactly as today.

### Shared heading-path predicate

The `wanted.includes(">")` test is duplicated verbatim in `resolveSection`
([note-document.ts:385](../../../src/tools/note-document.ts#L385)) and
`readSection` ([section.ts:56](../../../src/tools/section.ts#L56)). Extract a
tiny predicate — `isHeadingPath(section: string): boolean` — so "is this a
path?" has one definition, and reuse it at the new guard site and both existing
sites. One source of truth, mirroring how the prior spec unified the resolver.
Place it in `src/tools/vault.ts` beside `headingPaths`/`parseHeadings` — both
`note-document.ts` and `section.ts` already import those from `vault.ts`, so the
import is cycle-free.

## Surface

- **Code:**
  - `src/tools/vault.ts` — new `isHeadingPath(section: string): boolean`
    predicate, beside `headingPaths`.
  - `src/tools/note-document.ts` — guard in `appendToSection`'s `create`
    recovery branch (import + use `isHeadingPath`); `resolveSection` uses the
    predicate in place of its inline `includes(">")`.
  - `src/tools/section.ts` — `readSection` uses the predicate (no behavior
    change, dedup only).
  - No signature changes: `appendToSection`, `insert_template`, the MCP
    handlers, and the query CLI all pass the `heading`/`section` string straight
    through. `insert_template`'s `create_section` inherits the fix for free.
- **Tests (TDD):**
  - `tests/note-document.test.ts` — `appendToSection` with `create:true` on a
    missing **heading-path** throws (`/cannot be created/` + names the path);
    with `create:true` on a missing **bare** heading still creates (existing
    "can create a missing section" test stays green); ambiguous bare heading
    still errors with candidates (unchanged). A unit test for `isHeadingPath`
    (`"Projects > Log"` → true, `"Log"` → false).
  - `tests/templates.test.ts` — `insert_template` with `position: "section"`,
    a `" > "` section, and `create_section: true` on a missing section throws
    the same guard error (proves inheritance through `appendToSection`).
- **Docs:** `CLAUDE.md` and `README.md` — the `append_to_section` and
  `insert_template` entries note that `create`/`create_section` recovers a
  *missing bare* section only; a heading-path with no existing target fails loud
  (CLAUDE.md's doc-sync rule requires both files).

## Out of scope

- No auto-creation of parent headings (the "build the nested path" option was
  rejected — it invents structure and heading levels the caller never specified).
- No leaf-only creation (silently dropping the parent context is the same class
  of surprise this fix removes).
- No changes to how `add_section`'s explicit `heading` param is written — a
  caller of `add_section` that literally wants a `>` in heading text is out of
  this fix's scope; only the `create`-recovery path (where `>` is unambiguously
  addressing intent) is guarded. `add_section` addresses its *insertion point*
  via `after` (a heading-path), but its `heading` is the new heading's literal
  text by contract.
