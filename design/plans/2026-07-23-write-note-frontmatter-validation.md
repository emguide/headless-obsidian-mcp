# write_note Frontmatter Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the frontmatter-validation bypass in `write_note`/`append_note`/`prepend_note`, and add an optional structured `frontmatter` object parameter to `write_note` so agents never hand-write YAML.

**Architecture:** A shared helper `validateContentFrontmatter(content)` parses any leading frontmatter block with the existing `NoteDocument.parse` and runs the existing `validateFrontmatterValue` over each key, throwing before any write/snapshot. It is called on `write_note` always, and on the create-path of `append_note`/`prepend_note`. Separately, `write_note` gains an optional `frontmatter` param serialized canonically via `matter.stringify`, with a fail-loud conflict rule when both inline and param frontmatter are present.

**Tech Stack:** TypeScript (ESM, NodeNext), gray-matter, Node's built-in `node:test` runner via tsx.

## Global Constraints

- Node.js 18+ runtime; ESM modules with `.js` import specifiers pointing at `.ts` sources.
- Reuse `validateFrontmatterValue` from `src/tools/note-document.ts` as the single source of frontmatter rules — do NOT add new rules.
- All validation must run BEFORE `commitWrite` so a rejected write takes no git snapshot and makes no filesystem change.
- Tests use `node:test` + `assert/strict` + the `makeVault`/`Fixture` helpers from `tests/fixtures.js`.
- Run the full suite with `npm test`.
- When functionality changes, update BOTH `CLAUDE.md` and `README.md` (repo rule).

---

### Task 1: Shared `validateContentFrontmatter` helper + wire into all three tools

**Files:**
- Modify: `src/tools/write.ts` (add helper near top after imports; call in `writeNote` ~L128-142, `appendNote` create-branch ~L158-162, `prependNote` create-branch ~L189-192)
- Test: `tests/write-frontmatter.test.ts` (new)

**Interfaces:**
- Consumes: `NoteDocument.parse` and `validateFrontmatterValue` from `./note-document.js` (already importable; `validateFrontmatterValue` is not yet imported in write.ts — add it to the existing import block).
- Produces: `function validateContentFrontmatter(content: string): void` — throws on malformed YAML (`Invalid frontmatter in content: <msg>`) or any rule violation; no-op when content has no leading frontmatter block.

- [ ] **Step 1: Write the failing tests**

Create `tests/write-frontmatter.test.ts`:

```typescript
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { writeNote, appendNote, prependNote } from "../src/tools/write.js";
import { makeVault, Fixture } from "./fixtures.js";

const read = (vault: string, name: string) => readFile(join(vault, name), "utf-8");
const exists = (vault: string, name: string) =>
  stat(join(vault, name)).then(() => true, () => false);

let fx: Fixture;
before(async () => {
  fx = await makeVault([
    { path: "existing.md", content: "---\ntitle: E\n---\nbody\n" },
  ]);
});
after(() => fx.cleanup());

test("writeNote accepts a valid inline frontmatter block", async () => {
  await writeNote(fx.vaultPath, {
    path: "ok",
    content: "---\ntitle: Ok\ntags: [a, b]\n---\n# Ok\n",
  });
  const raw = await read(fx.vaultPath, "ok.md");
  assert.match(raw, /title: Ok/);
});

test("writeNote rejects a nested-map inline block and writes nothing", async () => {
  await assert.rejects(
    () => writeNote(fx.vaultPath, { path: "bad1", content: "---\nauthor:\n  name: y\n---\nx\n" }),
    /nested object/i
  );
  assert.equal(await exists(fx.vaultPath, "bad1.md"), false);
});

test("writeNote rejects markdown-in-string inline block", async () => {
  await assert.rejects(
    () => writeNote(fx.vaultPath, { path: "bad2", content: "---\nnote: \"[[wiki]]\"\n---\nx\n" }),
    /markdown/i
  );
});

test("writeNote rejects malformed YAML inline block", async () => {
  await assert.rejects(
    () => writeNote(fx.vaultPath, { path: "bad3", content: "---\ntitle: [unclosed\n---\nx\n" }),
    /invalid frontmatter/i
  );
});

test("appendNote create-path rejects a violating leading block", async () => {
  await assert.rejects(
    () => appendNote(fx.vaultPath, { path: "app-new", content: "---\nauthor:\n  name: y\n---\nx\n", create: true }),
    /nested object/i
  );
  assert.equal(await exists(fx.vaultPath, "app-new.md"), false);
});

test("appendNote to an existing note does NOT validate leading --- as frontmatter", async () => {
  await appendNote(fx.vaultPath, { path: "existing", content: "---\nnot: frontmatter\n---\n" });
  const raw = await read(fx.vaultPath, "existing.md");
  assert.match(raw, /not: frontmatter/); // appended as body text, not rejected
});

test("prependNote create-path rejects a violating leading block", async () => {
  await assert.rejects(
    () => prependNote(fx.vaultPath, { path: "pre-new", content: "---\nauthor:\n  name: y\n---\nx\n", create: true }),
    /nested object/i
  );
});

test("prependNote to an existing note does NOT validate inserted --- as frontmatter", async () => {
  await prependNote(fx.vaultPath, { path: "existing", content: "---\nnot: frontmatter\n---\n" });
  const raw = await read(fx.vaultPath, "existing.md");
  // Original frontmatter preserved; text inserted after it, never validated.
  assert.match(raw, /title: E/);
  assert.match(raw, /not: frontmatter/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/write-frontmatter.test.ts` (or `npx tsx --test tests/write-frontmatter.test.ts`)
Expected: FAIL — validating tests fail because no validation happens yet (notes get written; `bad1.md` exists).

- [ ] **Step 3: Add the helper and import**

In `src/tools/write.ts`, add `validateFrontmatterValue` to the existing import from `./note-document.js`:

```typescript
import {
  NoteDocument,
  frontmatterTagList,
  addTags,
  removeTags,
  setFrontmatter,
  addPropertyValues,
  removePropertyValues,
  renameProperty,
  addSection,
  appendToSection,
  replaceSection,
  validateFrontmatterValue,
} from "./note-document.js";
```

Add the helper (place it just above `writeNote`, after the `editNote` function):

```typescript
/**
 * Validate any leading frontmatter block in a content string against the same
 * rules the dedicated frontmatter tools enforce (no nested maps, no non-scalar
 * arrays, no markdown in string values). A no-op when the content has no leading
 * frontmatter block. Throws before any write, so a rejected write takes no git
 * snapshot and makes no filesystem change. Malformed YAML surfaces as a clean
 * `Invalid frontmatter in content` error rather than a raw parser stack.
 */
function validateContentFrontmatter(content: string): void {
  let doc: NoteDocument;
  try {
    doc = NoteDocument.parse(content);
  } catch (err) {
    const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
    throw new Error(`Invalid frontmatter in content: ${msg}`);
  }
  for (const [key, value] of Object.entries(doc.data)) {
    validateFrontmatterValue(key, value);
  }
}
```

- [ ] **Step 4: Call the helper at the three sites**

In `writeNote`, before `await commitWrite(vaultPath, path, content);`:

```typescript
  validateContentFrontmatter(content);
  await commitWrite(vaultPath, path, content);
```

In `appendNote`, inside the `if (!existed)` create branch, before its `commitWrite`:

```typescript
  if (!existed) {
    if (!create) throw new Error(`Note not found: ${canonicalName(path)}`);
    validateContentFrontmatter(content);
    await commitWrite(vaultPath, path, content.endsWith("\n") ? content : content + "\n");
    return { path: canonicalName(path), created: true };
  }
```

In `prependNote`, inside the `if (!existed)` create branch, before its `commitWrite`:

```typescript
  if (!existed) {
    if (!create) throw new Error(`Note not found: ${canonicalName(path)}`);
    validateContentFrontmatter(content);
    await commitWrite(vaultPath, path, content.endsWith("\n") ? content : content + "\n");
    return { path: canonicalName(path), created: true };
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- tests/write-frontmatter.test.ts`
Expected: PASS (all 8 tests).

- [ ] **Step 6: Run the full suite to check for regressions**

Run: `npm test`
Expected: PASS — existing `tests/write.test.ts` still green (its `writeNote` fixtures use either no frontmatter or valid frontmatter).

- [ ] **Step 7: Commit**

```bash
git add src/tools/write.ts tests/write-frontmatter.test.ts
git commit -m "fix: validate hand-written frontmatter in write/append/prepend_note

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Optional structured `frontmatter` param on `write_note`

**Files:**
- Modify: `src/tools/write.ts` (`WriteNoteParams` interface ~L121-126, `writeNote` body ~L128-142)
- Test: `tests/write-frontmatter.test.ts` (extend)

**Interfaces:**
- Consumes: `validateContentFrontmatter` and `validateFrontmatterValue` (Task 1); `matter` from `gray-matter` (add import).
- Produces: `WriteNoteParams` gains `frontmatter?: Record<string, unknown>`. When present and non-empty, `content` is treated as body-only and the note is serialized as `matter.stringify(content, frontmatter)`. Both-forms → throw.

- [ ] **Step 1: Write the failing tests**

Append to `tests/write-frontmatter.test.ts`:

```typescript
test("writeNote frontmatter param serializes canonically with body-only content", async () => {
  await writeNote(fx.vaultPath, {
    path: "param",
    content: "# Body\n",
    frontmatter: { title: "P", tags: ["x", "y"] },
  });
  const raw = await read(fx.vaultPath, "param.md");
  assert.match(raw, /^---\n/);
  assert.match(raw, /title: P/);
  assert.match(raw, /# Body/);
});

test("writeNote frontmatter param rejects a rule violation", async () => {
  await assert.rejects(
    () => writeNote(fx.vaultPath, { path: "pv", content: "b", frontmatter: { author: { name: "y" } as unknown } }),
    /nested object/i
  );
  assert.equal(await exists(fx.vaultPath, "pv.md"), false);
});

test("writeNote rejects frontmatter param AND an inline block together", async () => {
  await assert.rejects(
    () => writeNote(fx.vaultPath, {
      path: "both",
      content: "---\ntitle: X\n---\nbody\n",
      frontmatter: { title: "Y" },
    }),
    /not both/i
  );
  assert.equal(await exists(fx.vaultPath, "both.md"), false);
});

test("writeNote with empty frontmatter object writes body-only, no conflict", async () => {
  await writeNote(fx.vaultPath, { path: "empty-fm", content: "# Just body\n", frontmatter: {} });
  const raw = await read(fx.vaultPath, "empty-fm.md");
  assert.equal(raw.startsWith("---"), false);
  assert.match(raw, /# Just body/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/write-frontmatter.test.ts`
Expected: FAIL — `frontmatter` param is ignored (TS may also flag the unknown property depending on config; the runtime tests fail on behavior).

- [ ] **Step 3: Add `matter` import and extend `WriteNoteParams`**

In `src/tools/write.ts`, add near the top imports:

```typescript
import matter from "gray-matter";
```

Extend the interface:

```typescript
export interface WriteNoteParams {
  path: string;
  content: string;
  /** Allow replacing an existing note. Default false (refuse to clobber). */
  overwrite?: boolean;
  /**
   * Optional structured frontmatter. When provided (and non-empty), each field
   * is validated and the note is serialized with canonical block-style YAML;
   * `content` is then the body only. Passing this together with a frontmatter
   * block inline in `content` is an error.
   */
  frontmatter?: Record<string, unknown>;
}
```

- [ ] **Step 4: Implement the param in `writeNote`**

Replace the body of `writeNote` up to `commitWrite` with:

```typescript
export async function writeNote(
  vaultPath: string,
  { path, content, overwrite = false, frontmatter }: WriteNoteParams
): Promise<{ path: string; created: boolean }> {
  if (typeof content !== "string") throw new Error("content must be a string");

  const hasFrontmatterParam = frontmatter != null && Object.keys(frontmatter).length > 0;
  let finalContent: string;
  if (hasFrontmatterParam) {
    // A structured param plus an inline block is ambiguous — refuse to guess.
    if (NoteDocument.FENCE_TEST.test(content)) {
      throw new Error(
        "Provide frontmatter either as the `frontmatter` parameter or inline in content, not both."
      );
    }
    for (const [key, value] of Object.entries(frontmatter!)) {
      validateFrontmatterValue(key, value);
    }
    finalContent = matter.stringify(content, frontmatter!);
  } else {
    validateContentFrontmatter(content);
    finalContent = content;
  }

  const fullPath = resolveNotePath(vaultPath, path);
  const existed = await fileExists(fullPath);
  if (existed && !overwrite) {
    throw new Error(
      `Note already exists: ${canonicalName(path)}. Pass overwrite:true to replace it.`
    );
  }
  await commitWrite(vaultPath, path, finalContent);
  return { path: canonicalName(path), created: !existed };
}
```

Note: this replaces the previous unconditional `validateContentFrontmatter(content)` call added in Task 1 — the else-branch preserves it for the no-param case.

- [ ] **Step 5: Expose the fence test on NoteDocument**

`NoteDocument.FENCE` is `private static`. Add a public static predicate in `src/tools/note-document.ts` right after the `FENCE` declaration:

```typescript
  /** True when `raw` begins with a frontmatter fence. */
  static FENCE_TEST = {
    test: (raw: string): boolean => NoteDocument.FENCE.test(raw),
  };
```

(A tiny object literal keeps `FENCE` private while giving `write.ts` a `.test()` it can call without re-declaring the regex. If preferred, inline a local `const FENCE = /^---\r?\n/` check in write.ts instead — but reusing the canonical fence avoids drift.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- tests/write-frontmatter.test.ts`
Expected: PASS (all 12 tests).

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/tools/write.ts src/tools/note-document.ts tests/write-frontmatter.test.ts
git commit -m "feat: optional structured frontmatter param on write_note

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: MCP schema, descriptions, and documentation

**Files:**
- Modify: `src/index.ts` (`write_note` inputSchema ~L464-474; `append_note` ~L476-487; `prepend_note` ~L489-500)
- Modify: `CLAUDE.md` (write_note / append_note / prepend_note sections; the "Validation" paragraph under Writing tools)
- Modify: `README.md` (L490 write_note, L501 append_note, L512 prepend_note, L665 Validation paragraph)

**Interfaces:**
- Consumes: the `frontmatter` param and validation behavior from Tasks 1–2. No new code symbols.

- [ ] **Step 1: Update the MCP schema in `src/index.ts`**

For `write_note`, replace the `content` description and add `frontmatter`:

```typescript
      {
        name: "write_note",
        description: "Create a note, or overwrite an existing one. Refuses to overwrite unless overwrite:true is passed. Pass structured frontmatter via the frontmatter param (validated, serialized canonically) or inline in content (also validated) — not both. Use the structure-aware tools (add_section, set_frontmatter, add_tag) for surgical edits instead of rewriting a whole note.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative note path (with or without .md)" },
            content: { type: "string", description: "Note content. May include a leading frontmatter block (validated), or pass frontmatter via the frontmatter param and give body-only content here." },
            overwrite: { type: "boolean", description: "Allow replacing an existing note (default: false)" },
            frontmatter: { type: "object", description: "Optional frontmatter fields, validated and serialized canonically. When given, content is the body only. Do not also put a frontmatter block in content." }
          },
          required: ["path", "content"]
        }
      },
```

For `append_note`, update the `content` description to note create-path validation:

```typescript
            content: { type: "string", description: "Text to append. When this call creates the note (create:true, note missing), a leading frontmatter block is validated." },
```

For `prepend_note`, likewise:

```typescript
            content: { type: "string", description: "Text to prepend. When this call creates the note (create:true, note missing), a leading frontmatter block is validated; otherwise it is inserted after any existing frontmatter." },
```

- [ ] **Step 2: Update `CLAUDE.md`**

In the `### write_note` section, replace the Input line with:

```markdown
- **Input**: `path` (required), `content` (required), `overwrite` (optional, default `false` — refuses to clobber an existing note), `frontmatter` (optional object — structured frontmatter, validated and serialized canonically; when given, `content` is the body only). Frontmatter may be supplied via the `frontmatter` param **or** inline in `content` (both are validated on the same rules as every other frontmatter write) — supplying both is an error.
```

In `### append_note` and `### prepend_note`, add a sentence to Purpose noting that a leading frontmatter block is validated when the call creates the note.

In the "**Validation**" paragraph (under Writing tools), add: "Content-writing tools (`write_note`, and the create path of `append_note`/`prepend_note`) validate any hand-written leading frontmatter block on these same rules, so an agent creating a note by hand cannot bypass frontmatter integrity."

- [ ] **Step 3: Update `README.md`**

Mirror the same three edits at `README.md` L490 (write_note), L501 (append_note), L512 (prepend_note), and extend the Validation paragraph at L665 with the same "content-writing tools also validate hand-written frontmatter" sentence.

- [ ] **Step 4: Build to verify no type/compile errors**

Run: `npm run build`
Expected: clean compile (no errors).

- [ ] **Step 5: Run the full suite once more**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts CLAUDE.md README.md
git commit -m "docs: document write_note frontmatter param and validation

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Layer 1 (validate hand-written frontmatter) → Task 1. ✓
- Layer 2 (structured `frontmatter` param) → Task 2. ✓
- Conflict rule (both forms) → Task 2, Step 4. ✓
- `frontmatter: {}` body-only exception → Task 2, Steps 1 & 4 (`hasFrontmatterParam` gate on non-empty). ✓
- append/prepend create-path only → Task 1, Steps 3–4. ✓
- Malformed YAML → clean error → Task 1 helper + test. ✓
- Error before snapshot/write → all validation precedes `commitWrite`; tests assert file absence. ✓
- MCP schema + descriptions → Task 3, Step 1. ✓
- CLAUDE.md + README.md → Task 3, Steps 2–3. ✓
- Test cases 1–13 from spec → covered across Task 1 (cases 1–4, 9–12) and Task 2 (5–8), with file-absence assertions for case 13. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. ✓

**Type consistency:** `validateContentFrontmatter(content: string): void` used identically in Tasks 1–2. `WriteNoteParams.frontmatter?: Record<string, unknown>` defined in Task 2 and referenced only there. `NoteDocument.FENCE_TEST.test(...)` defined in Task 2 Step 5 and used in Task 2 Step 4. ✓

**Note on `matter.stringify`:** gray-matter's `stringify(body, data)` prepends a `---`-fenced YAML block. `matter.stringify` with an empty body still works; the `hasFrontmatterParam` gate ensures we only call it when there are fields to write, so `frontmatter: {}` takes the else-branch (body-only, validated) — matching the spec's empty-object exception.
