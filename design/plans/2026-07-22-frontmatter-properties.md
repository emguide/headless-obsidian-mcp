# Frontmatter Property Search, CRUD & Validation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make note frontmatter a first-class queryable and safely-editable surface: 4 read tools (schema, faceting, query-by-condition, get-one), 3 write tools (array add/remove, key rename), and enforce-on-write validation rejecting nested objects, non-scalar arrays, and markdown-in-strings.

**Architecture:** Read tools live in a new `src/tools/properties.ts` reading from the shared `VaultIndex` (no extra I/O). A shared `matchesWhere` matcher is extracted into `src/tools/property-match.ts` and used by both `query_notes` and the existing `list_recent_notes`. Write logic and validation extend the pure `src/tools/note-document.ts` core; thin wrappers in `src/tools/write.ts` route through the existing `commitWrite` funnel. Registration in `src/index.ts`, CLI subcommands in `src/query-cli.ts`.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node built-ins, gray-matter, commander, `node:test` via tsx.

## Global Constraints

- Node 18+; ESM modules — all local imports use `.js` specifiers even for `.ts` sources.
- Tests: `node:test` via tsx; run with `npm test` (runs `tests/*.test.ts`). Use the `makeVault` / `sampleNotes` fixtures from `tests/fixtures.ts`; call `clearIndexCache()` between vaults (fixtures do this).
- Read tools read exclusively from the shared index (`getIndex(vaultPath)` → `index.getEntries()` / `index.getEntry(path)`); no direct file reads.
- Every write funnels through `commitWrite` via the `editNote` helper in `write.ts`; the three new write tools MUST be added to `WRITE_TOOL_NAMES` so they are gated behind `OBSIDIAN_ALLOW_WRITES`.
- Validation runs on **only the values a write adds or modifies**; pre-existing violations on untouched keys never block a write.
- Path-canonicalization convention: strip `.md`, forward slashes (`canonicalName` in `write.ts`; `properties.ts` reads canonical `entry.path` directly).
- Dual-doc rule: update BOTH `CLAUDE.md` and `README.md` for any user-facing tool change.
- Commit after each task with a `feat:`/`refactor:`/`docs:`/`test:` prefix; end commit messages with the `Co-Authored-By` trailer this repo uses.

---

### Task 1: Frontmatter validation core

**Files:**
- Modify: `src/tools/note-document.ts` (add `validateFrontmatterValue` + `isScalar` helper)
- Test: `tests/frontmatter-validate.test.ts` (create)

**Interfaces:**
- Consumes: nothing (pure functions).
- Produces:
  - `isScalar(v: unknown): boolean` — true for `string | number | boolean | null | undefined`.
  - `validateFrontmatterValue(key: string, value: unknown): void` — throws `Error` on a violating value; returns `void` when valid.

- [ ] **Step 1: Write the failing test**

Create `tests/frontmatter-validate.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateFrontmatterValue } from "../src/tools/note-document.js";

test("accepts scalars, null, and flat scalar arrays", () => {
  assert.doesNotThrow(() => validateFrontmatterValue("a", "text"));
  assert.doesNotThrow(() => validateFrontmatterValue("a", 3));
  assert.doesNotThrow(() => validateFrontmatterValue("a", true));
  assert.doesNotThrow(() => validateFrontmatterValue("a", null));
  assert.doesNotThrow(() => validateFrontmatterValue("a", ["x", 1, false]));
});

test("accepts a bare URL and plain text (not markdown)", () => {
  assert.doesNotThrow(() => validateFrontmatterValue("url", "https://example.com/a_b"));
  assert.doesNotThrow(() => validateFrontmatterValue("s", "a - b (c) plain"));
});

test("rejects a nested object at top level", () => {
  assert.throws(() => validateFrontmatterValue("a", { x: 1 }), /nested object/i);
});

test("rejects an object nested inside an array", () => {
  assert.throws(() => validateFrontmatterValue("a", [{ x: 1 }]), /nested object|non-scalar/i);
});

test("rejects an array nested inside an array", () => {
  assert.throws(() => validateFrontmatterValue("a", [[1, 2]]), /non-scalar/i);
});

test("rejects markdown syntax in a string value", () => {
  assert.throws(() => validateFrontmatterValue("a", "see [[Note]]"), /markdown/i);
  assert.throws(() => validateFrontmatterValue("a", "![[embed.png]]"), /markdown/i);
  assert.throws(() => validateFrontmatterValue("a", "a [link](http://x)"), /markdown/i);
  assert.throws(() => validateFrontmatterValue("a", "**bold**"), /markdown/i);
  assert.throws(() => validateFrontmatterValue("a", "text `code` here"), /markdown/i);
  assert.throws(() => validateFrontmatterValue("a", "# heading"), /markdown/i);
  assert.throws(() => validateFrontmatterValue("a", "- bullet"), /markdown/i);
});

test("rejects markdown syntax inside a string array element", () => {
  assert.throws(() => validateFrontmatterValue("a", ["ok", "[[bad]]"]), /markdown/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/frontmatter-validate.test.ts`
Expected: FAIL — `validateFrontmatterValue` is not exported.

- [ ] **Step 3: Implement the validator**

Add to `src/tools/note-document.ts`, after the `frontmatterTagList` block (near the tags section) or in a new `/* --- validation --- */` section:

```typescript
/* ----------------------------------------------------------- validation -- */

/** Scalar frontmatter values: what a property (or array element) may hold. */
export function isScalar(v: unknown): boolean {
  return (
    v == null ||
    typeof v === "string" ||
    typeof v === "number" ||
    typeof v === "boolean"
  );
}

// Markdown markup we forbid in property strings. Bare URLs / plain punctuation
// are intentionally allowed — only genuine markup is rejected.
const MARKDOWN_PATTERNS: RegExp[] = [
  /!?\[\[[^\]]*\]\]/, // [[wikilink]] or ![[embed]]
  /\[[^\]]*\]\([^)]*\)/, // [text](url)
  /\*\*[^*]+\*\*/, // **bold**
  /__[^_]+__/, // __bold__
  /`[^`]*`/, // `code`
  /^\s*#{1,6}\s+\S/, // # heading
  /^\s*[-*+]\s+\S/, // - / * / + list bullet
];

function assertNoMarkdown(key: string, value: string): void {
  if (MARKDOWN_PATTERNS.some((re) => re.test(value))) {
    throw new Error(
      `Property "${key}" contains markdown syntax; frontmatter values must be plain text`
    );
  }
}

/**
 * Enforce the frontmatter property rules on a single value the caller is about
 * to write: no nested objects (maps), no arrays of non-scalars, and no markdown
 * markup inside string values or string array elements. Scalars, null, and flat
 * arrays of scalars pass. Throws a descriptive Error on any violation.
 */
export function validateFrontmatterValue(key: string, value: unknown): void {
  if (Array.isArray(value)) {
    for (const el of value) {
      if (!isScalar(el)) {
        throw new Error(
          `Property "${key}" is an array containing a non-scalar element; ` +
            `only flat arrays of scalars are allowed`
        );
      }
      if (typeof el === "string") assertNoMarkdown(key, el);
    }
    return;
  }
  if (!isScalar(value)) {
    throw new Error(
      `Property "${key}" is a nested object; frontmatter values must be scalars or flat arrays of scalars`
    );
  }
  if (typeof value === "string") assertNoMarkdown(key, value);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/frontmatter-validate.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/tools/note-document.ts tests/frontmatter-validate.test.ts
git commit -m "feat: add frontmatter value validator (no nested/markdown/non-scalar)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Wire validation into existing frontmatter writers

**Files:**
- Modify: `src/tools/note-document.ts` (`setFrontmatter` and `addTags` call the validator)
- Test: `tests/frontmatter-validate.test.ts` (append integration cases)

**Interfaces:**
- Consumes: `validateFrontmatterValue` (Task 1), existing `setFrontmatter`, `addTags`.
- Produces: no signature changes; `setFrontmatter`/`addTags` now throw on violating input.

- [ ] **Step 1: Write the failing test**

Append to `tests/frontmatter-validate.test.ts`:

```typescript
import { NoteDocument, setFrontmatter } from "../src/tools/note-document.js";

test("setFrontmatter rejects a nested-object value", () => {
  const doc = NoteDocument.parse("---\ntitle: X\n---\nbody\n");
  assert.throws(() => setFrontmatter(doc, { author: { name: "y" } }), /nested object/i);
});

test("setFrontmatter rejects markdown in a value but allows plain scalars", () => {
  const doc = NoteDocument.parse("---\ntitle: X\n---\nbody\n");
  assert.throws(() => setFrontmatter(doc, { note: "[[wiki]]" }), /markdown/i);
  assert.doesNotThrow(() => setFrontmatter(doc, { status: "active", n: 3 }));
});

test("setFrontmatter validates only the keys it writes (legacy value untouched)", () => {
  // Note already has a violating `bad` value; editing an unrelated key succeeds.
  const doc = NoteDocument.parse("---\ntitle: X\nbad:\n  nested: 1\n---\nbody\n");
  assert.doesNotThrow(() => setFrontmatter(doc, { status: "done" }));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/frontmatter-validate.test.ts`
Expected: FAIL — the first two throw-tests fail (no validation yet); the third passes.

- [ ] **Step 3: Wire the validator into `setFrontmatter`**

In `src/tools/note-document.ts`, in `setFrontmatter`, validate each `set` value before assigning:

```typescript
  if (set) {
    for (const [key, value] of Object.entries(set)) {
      validateFrontmatterValue(key, value);
      doc.data[key] = value;
      changed = true;
    }
  }
```

In `addTags`, validate each normalized tag (they are strings; this rejects e.g. a `[[wikilink]]` masquerading as a tag). After computing `norm`:

```typescript
    const norm = normalizeTag(tag);
    validateFrontmatterValue("tags", norm);
    if (!set.has(norm)) {
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/frontmatter-validate.test.ts`
Then the full suite to confirm no regression: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/note-document.ts tests/frontmatter-validate.test.ts
git commit -m "feat: enforce frontmatter validation in setFrontmatter and addTags

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Array property CRUD + rename in the note-document core

**Files:**
- Modify: `src/tools/note-document.ts` (add `addPropertyValues`, `removePropertyValues`, `renameProperty`)
- Test: `tests/property-edit.test.ts` (create)

**Interfaces:**
- Consumes: `NoteDocument`, `validateFrontmatterValue` (Task 1).
- Produces:
  - `addPropertyValues(doc: NoteDocument, key: string, values: unknown[]): unknown[] | null` — returns resulting array, or `null` if unchanged.
  - `removePropertyValues(doc: NoteDocument, key: string, values: unknown[]): unknown[] | null` — returns resulting array (or `[]`→key dropped), or `null` if nothing matched.
  - `renameProperty(doc: NoteDocument, from: string, to: string): boolean` — true when renamed; throws on absent `from` or colliding `to`.

- [ ] **Step 1: Write the failing test**

Create `tests/property-edit.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NoteDocument,
  addPropertyValues,
  removePropertyValues,
  renameProperty,
} from "../src/tools/note-document.js";

function parse(fm: string): NoteDocument {
  return NoteDocument.parse(`---\n${fm}\n---\nbody\n`);
}

test("addPropertyValues creates a new array key", () => {
  const doc = parse("title: X");
  const out = addPropertyValues(doc, "aliases", ["a", "b"]);
  assert.deepEqual(out, ["a", "b"]);
  assert.deepEqual(doc.data.aliases, ["a", "b"]);
});

test("addPropertyValues appends without duplicating", () => {
  const doc = parse("aliases: [a, b]");
  const out = addPropertyValues(doc, "aliases", ["b", "c"]);
  assert.deepEqual(out, ["a", "b", "c"]);
});

test("addPropertyValues returns null when nothing new is added", () => {
  const doc = parse("aliases: [a, b]");
  assert.equal(addPropertyValues(doc, "aliases", ["a"]), null);
});

test("addPropertyValues promotes a scalar key to an array", () => {
  const doc = parse("alias: foo");
  const out = addPropertyValues(doc, "alias", ["bar"]);
  assert.deepEqual(out, ["foo", "bar"]);
});

test("addPropertyValues rejects a markdown value", () => {
  const doc = parse("title: X");
  assert.throws(() => addPropertyValues(doc, "aliases", ["[[bad]]"]), /markdown/i);
});

test("removePropertyValues removes members and keeps the rest", () => {
  const doc = parse("aliases: [a, b, c]");
  const out = removePropertyValues(doc, "aliases", ["b"]);
  assert.deepEqual(out, ["a", "c"]);
});

test("removePropertyValues drops the key when emptied", () => {
  const doc = parse("aliases: [a]");
  const out = removePropertyValues(doc, "aliases", ["a"]);
  assert.deepEqual(out, []);
  assert.equal("aliases" in doc.data, false);
});

test("removePropertyValues returns null when nothing matched", () => {
  const doc = parse("aliases: [a]");
  assert.equal(removePropertyValues(doc, "aliases", ["z"]), null);
});

test("renameProperty renames a key preserving its value", () => {
  const doc = parse("author: jane");
  assert.equal(renameProperty(doc, "author", "authors"), true);
  assert.equal(doc.data.author, undefined);
  assert.equal(doc.data.authors, "jane");
});

test("renameProperty throws when the source key is absent", () => {
  const doc = parse("title: X");
  assert.throws(() => renameProperty(doc, "nope", "x"), /not found/i);
});

test("renameProperty throws when the destination key already exists", () => {
  const doc = parse("a: 1\nb: 2");
  assert.throws(() => renameProperty(doc, "a", "b"), /already exists/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/property-edit.test.ts`
Expected: FAIL — the three functions are not exported.

- [ ] **Step 3: Implement the three functions**

Add to `src/tools/note-document.ts`, in the frontmatter section (after `setFrontmatter`):

```typescript
/**
 * Add values to the array-valued property `key` (idempotent). Creates the array
 * if the key is absent; promotes an existing scalar to `[old, ...new]`. Each
 * added value is validated. Returns the resulting array, or null if unchanged.
 */
export function addPropertyValues(
  doc: NoteDocument,
  key: string,
  values: unknown[]
): unknown[] | null {
  const current = doc.data[key];
  const base: unknown[] =
    current == null ? [] : Array.isArray(current) ? [...current] : [current];
  let changed = false;
  for (const value of values) {
    validateFrontmatterValue(key, value);
    if (!base.some((v) => v === value)) {
      base.push(value);
      changed = true;
    }
  }
  if (!changed) return null;
  doc.data[key] = base;
  doc.markFrontmatterDirty();
  return base;
}

/**
 * Remove values from the array-valued property `key`. An emptied array drops the
 * key. Returns the resulting array (possibly empty), or null if nothing matched.
 */
export function removePropertyValues(
  doc: NoteDocument,
  key: string,
  values: unknown[]
): unknown[] | null {
  const current = doc.data[key];
  const base: unknown[] =
    current == null ? [] : Array.isArray(current) ? [...current] : [current];
  const remove = new Set(values);
  const next = base.filter((v) => !remove.has(v));
  if (next.length === base.length) return null;

  if (next.length === 0) {
    delete doc.data[key];
  } else {
    doc.data[key] = next;
  }
  doc.markFrontmatterDirty();
  return next;
}

/**
 * Rename frontmatter key `from` to `to`, preserving the value. Throws if `from`
 * is absent or `to` already exists (no silent clobber). Returns true on success.
 */
export function renameProperty(
  doc: NoteDocument,
  from: string,
  to: string
): boolean {
  if (!(from in doc.data)) {
    throw new Error(`Property "${from}" not found`);
  }
  if (to in doc.data) {
    throw new Error(`Property "${to}" already exists`);
  }
  // Rebuild in insertion order with the key swapped in place, so the renamed
  // key keeps its position in the serialized YAML.
  const rebuilt: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc.data)) {
    rebuilt[k === from ? to : k] = v;
  }
  doc.data = rebuilt;
  doc.markFrontmatterDirty();
  return true;
}
```

Note: `doc.data` is a public mutable field on `NoteDocument` (see `note-document.ts`), so reassigning it in `renameProperty` is allowed.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/property-edit.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/tools/note-document.ts tests/property-edit.test.ts
git commit -m "feat: add array property add/remove and key rename to note-document core

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Write-tool wrappers + gating for the three property writers

**Files:**
- Modify: `src/tools/write.ts` (add wrappers, params, register in `WRITE_TOOL_NAMES`)
- Test: `tests/property-write.test.ts` (create)

**Interfaces:**
- Consumes: `addPropertyValues`, `removePropertyValues`, `renameProperty` (Task 3); existing `editNote`, `canonicalName`, `WRITE_TOOL_NAMES`.
- Produces:
  - `interface PropertyValuesParams { path: string; key: string; values: unknown[] }`
  - `interface RenamePropertyParams { path: string; from: string; to: string }`
  - `addNotePropertyValues(vaultPath, params): Promise<{ path: string; key: string; values: unknown[] }>`
  - `removeNotePropertyValues(vaultPath, params): Promise<{ path: string; key: string; values: unknown[] }>`
  - `renameNoteProperty(vaultPath, params): Promise<{ path: string; from: string; to: string }>`

- [ ] **Step 1: Write the failing test**

Create `tests/property-write.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { makeVault } from "./fixtures.js";
import {
  addNotePropertyValues,
  removeNotePropertyValues,
  renameNoteProperty,
} from "../src/tools/write.js";

const NOTE = { path: "n.md", content: "---\ntitle: N\naliases: [a, b]\n---\nbody\n" };

test("addNotePropertyValues appends and persists", async () => {
  const { vaultPath, cleanup } = await makeVault([NOTE]);
  try {
    const res = await addNotePropertyValues(vaultPath, {
      path: "n",
      key: "aliases",
      values: ["c"],
    });
    assert.deepEqual(res.values, ["a", "b", "c"]);
    const raw = await readFile(join(vaultPath, "n.md"), "utf-8");
    assert.match(raw, /aliases:/);
    assert.match(raw, /- c/);
  } finally {
    await cleanup();
  }
});

test("removeNotePropertyValues removes and persists", async () => {
  const { vaultPath, cleanup } = await makeVault([NOTE]);
  try {
    const res = await removeNotePropertyValues(vaultPath, {
      path: "n",
      key: "aliases",
      values: ["a"],
    });
    assert.deepEqual(res.values, ["b"]);
  } finally {
    await cleanup();
  }
});

test("renameNoteProperty renames and persists", async () => {
  const { vaultPath, cleanup } = await makeVault([NOTE]);
  try {
    const res = await renameNoteProperty(vaultPath, {
      path: "n",
      from: "aliases",
      to: "akas",
    });
    assert.equal(res.to, "akas");
    const raw = await readFile(join(vaultPath, "n.md"), "utf-8");
    assert.match(raw, /akas:/);
    assert.doesNotMatch(raw, /aliases:/);
  } finally {
    await cleanup();
  }
});

test("addNotePropertyValues rejects markdown before writing", async () => {
  const { vaultPath, cleanup } = await makeVault([NOTE]);
  try {
    await assert.rejects(
      () => addNotePropertyValues(vaultPath, { path: "n", key: "aliases", values: ["[[x]]"] }),
      /markdown/i
    );
  } finally {
    await cleanup();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/property-write.test.ts`
Expected: FAIL — wrappers not exported.

- [ ] **Step 3: Implement wrappers, params, and gating**

In `src/tools/write.ts`:

1. Extend the import from `./note-document.js` to include the three new functions:

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
} from "./note-document.js";
```

2. Add the three tool names to `WRITE_TOOL_NAMES` (the `Set` literal near the top):

```typescript
  "set_frontmatter",
  "add_property_values",
  "remove_property_values",
  "rename_property",
  "add_section",
```

3. Add the wrappers in the frontmatter section (after `setNoteFrontmatter`):

```typescript
export interface PropertyValuesParams {
  path: string;
  key: string;
  values: unknown[];
}

export async function addNotePropertyValues(
  vaultPath: string,
  { path, key, values }: PropertyValuesParams
): Promise<{ path: string; key: string; values: unknown[] }> {
  if (!key || typeof key !== "string") throw new Error("key must be a non-empty string");
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("values must be a non-empty array");
  }
  let result: unknown[] = [];
  await editNote(vaultPath, path, (doc) => {
    const next = addPropertyValues(doc, key, values);
    const current = doc.data[key];
    result = next ?? (Array.isArray(current) ? current : current == null ? [] : [current]);
    return next != null;
  });
  return { path: canonicalName(path), key, values: result };
}

export async function removeNotePropertyValues(
  vaultPath: string,
  { path, key, values }: PropertyValuesParams
): Promise<{ path: string; key: string; values: unknown[] }> {
  if (!key || typeof key !== "string") throw new Error("key must be a non-empty string");
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("values must be a non-empty array");
  }
  let result: unknown[] = [];
  await editNote(vaultPath, path, (doc) => {
    const next = removePropertyValues(doc, key, values);
    const current = doc.data[key];
    result = next ?? (Array.isArray(current) ? current : current == null ? [] : [current]);
    return next != null;
  });
  return { path: canonicalName(path), key, values: result };
}

export interface RenamePropertyParams {
  path: string;
  from: string;
  to: string;
}

export async function renameNoteProperty(
  vaultPath: string,
  { path, from, to }: RenamePropertyParams
): Promise<{ path: string; from: string; to: string }> {
  if (!from || typeof from !== "string") throw new Error("from must be a non-empty string");
  if (!to || typeof to !== "string") throw new Error("to must be a non-empty string");
  await editNote(vaultPath, path, (doc) => renameProperty(doc, from, to));
  return { path: canonicalName(path), from, to };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/property-write.test.ts`
Then: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/write.ts tests/property-write.test.ts
git commit -m "feat: add property CRUD write wrappers gated behind writes flag

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Extract the shared `where` matcher

**Files:**
- Create: `src/tools/property-match.ts`
- Modify: `src/tools/recent.ts` (delete inline `matchesWhere`, import shared one)
- Test: `tests/property-match.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type Condition = string | number | boolean | { eq?: unknown; ne?: unknown; gt?: unknown; gte?: unknown; lt?: unknown; lte?: unknown; exists?: boolean; contains?: unknown };`
  - `matchesWhere(frontmatter: Record<string, unknown>, where: Record<string, Condition>, match?: "all" | "any"): boolean` — `match` defaults to `"all"`.

- [ ] **Step 1: Write the failing test**

Create `tests/property-match.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesWhere } from "../src/tools/property-match.js";

const fm = { status: "active", priority: 5, due: "2026-08-01", aliases: ["a", "b"] };

test("bare scalar means equality (case-insensitive)", () => {
  assert.equal(matchesWhere(fm, { status: "ACTIVE" }), true);
  assert.equal(matchesWhere(fm, { status: "done" }), false);
});

test("bare scalar matches an array member", () => {
  assert.equal(matchesWhere(fm, { aliases: "a" }), true);
  assert.equal(matchesWhere(fm, { aliases: "z" }), false);
});

test("numeric comparisons are numeric, not lexical", () => {
  assert.equal(matchesWhere(fm, { priority: { gt: 3 } }), true);
  assert.equal(matchesWhere(fm, { priority: { gte: 5 } }), true);
  assert.equal(matchesWhere(fm, { priority: { lt: 5 } }), false);
});

test("date comparisons are chronological", () => {
  assert.equal(matchesWhere(fm, { due: { lt: "2026-09-01" } }), true);
  assert.equal(matchesWhere(fm, { due: { gt: "2026-09-01" } }), false);
});

test("eq / ne operators", () => {
  assert.equal(matchesWhere(fm, { status: { eq: "active" } }), true);
  assert.equal(matchesWhere(fm, { status: { ne: "active" } }), false);
});

test("exists tests key presence", () => {
  assert.equal(matchesWhere(fm, { status: { exists: true } }), true);
  assert.equal(matchesWhere(fm, { missing: { exists: false } }), true);
  assert.equal(matchesWhere(fm, { missing: { exists: true } }), false);
});

test("contains tests array membership and string substring", () => {
  assert.equal(matchesWhere(fm, { aliases: { contains: "b" } }), true);
  assert.equal(matchesWhere(fm, { status: { contains: "activ" } }), true);
  assert.equal(matchesWhere(fm, { aliases: { contains: "z" } }), false);
});

test("match all vs any", () => {
  const w = { status: "active", priority: { gt: 9 } };
  assert.equal(matchesWhere(fm, w, "all"), false);
  assert.equal(matchesWhere(fm, w, "any"), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/property-match.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create the shared matcher**

Create `src/tools/property-match.ts`:

```typescript
/**
 * Shared frontmatter condition matcher, used by `query_notes` and
 * `list_recent_notes`. A condition is either a bare scalar (equality, or
 * array-membership when the note's value is an array) or an operator object.
 * Comparisons are type-aware: numeric when both sides are numbers, chronological
 * when both parse as dates, else case-insensitive string compare.
 */

export type Condition =
  | string
  | number
  | boolean
  | {
      eq?: unknown;
      ne?: unknown;
      gt?: unknown;
      gte?: unknown;
      lt?: unknown;
      lte?: unknown;
      exists?: boolean;
      contains?: unknown;
    };

function eqLoose(a: unknown, b: unknown): boolean {
  return String(a).toLowerCase() === String(b).toLowerCase();
}

/** Membership (or, for a scalar `have`, loose equality) test used by bare scalars. */
function membership(have: unknown, want: unknown): boolean {
  if (Array.isArray(have)) return have.some((v) => eqLoose(v, want));
  return have != null && eqLoose(have, want);
}

/** Type-aware ordered compare: <0, 0, >0, or NaN when incomparable. */
function compare(have: unknown, want: unknown): number {
  const hn = typeof have === "number" ? have : Number(have);
  const wn = typeof want === "number" ? want : Number(want);
  if (!Number.isNaN(hn) && !Number.isNaN(wn) && have !== "" && want !== "") {
    return hn - wn;
  }
  const hd = Date.parse(String(have));
  const wd = Date.parse(String(want));
  if (!Number.isNaN(hd) && !Number.isNaN(wd)) return hd - wd;
  return String(have).toLowerCase().localeCompare(String(want).toLowerCase());
}

function evaluate(have: unknown, cond: Condition): boolean {
  // Bare scalar: equality / array-membership shorthand.
  if (cond === null || typeof cond !== "object") {
    return membership(have, cond);
  }
  const c = cond;
  if (c.exists !== undefined) {
    const present = have !== undefined;
    if (present !== c.exists) return false;
  }
  if (c.eq !== undefined && !membership(have, c.eq)) return false;
  if (c.ne !== undefined && membership(have, c.ne)) return false;
  if (c.contains !== undefined) {
    if (Array.isArray(have)) {
      if (!have.some((v) => eqLoose(v, c.contains))) return false;
    } else if (!String(have).toLowerCase().includes(String(c.contains).toLowerCase())) {
      return false;
    }
  }
  if (c.gt !== undefined && !(compare(have, c.gt) > 0)) return false;
  if (c.gte !== undefined && !(compare(have, c.gte) >= 0)) return false;
  if (c.lt !== undefined && !(compare(have, c.lt) < 0)) return false;
  if (c.lte !== undefined && !(compare(have, c.lte) <= 0)) return false;
  return true;
}

/**
 * Does a note's frontmatter satisfy `where`? With match="all" (default) every
 * condition must hold; with "any" at least one must.
 */
export function matchesWhere(
  frontmatter: Record<string, unknown>,
  where: Record<string, Condition>,
  match: "all" | "any" = "all"
): boolean {
  const entries = Object.entries(where);
  if (entries.length === 0) return true;
  if (match === "any") {
    return entries.some(([key, cond]) => evaluate(frontmatter[key], cond));
  }
  return entries.every(([key, cond]) => evaluate(frontmatter[key], cond));
}
```

- [ ] **Step 4: Rewire `recent.ts` to the shared matcher**

In `src/tools/recent.ts`: delete the inline `matchesWhere` function (lines defining it) and import the shared one. Change the import block and the call site:

```typescript
import { matchesWhere } from "./property-match.js";
```

The existing call `selected.filter((e) => matchesWhere(e.frontmatter, where))` still compiles — the shared `matchesWhere` defaults `match` to `"all"`, matching the old all-conditions behavior. Leave `toEpoch` in `recent.ts` (still used for date sorting).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx tsx --test tests/property-match.test.ts tests/recent.test.ts`
Then: `npm test`
Expected: PASS — including the existing `recent.test.ts` (backward-compat).

- [ ] **Step 6: Commit**

```bash
git add src/tools/property-match.ts src/tools/recent.ts tests/property-match.test.ts
git commit -m "refactor: extract shared frontmatter where-matcher with full operators

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Read tools — `list_properties`, `get_property_values`, `query_notes`, `get_property`

**Files:**
- Create: `src/tools/properties.ts`
- Modify: `src/types.ts` (param + result interfaces)
- Test: `tests/properties-read.test.ts` (create)

**Interfaces:**
- Consumes: `getIndex`, `entryToHeader`, `IndexEntry` from `./vault-index.js`; `matchesWhere`, `Condition` from `./property-match.js`; `NoteHeader` from `../types.js`.
- Produces (in `types.ts`):
  - `interface PropertySchemaEntry { key: string; count: number; types: string[] }`
  - `interface ListPropertiesParams { include_tags?: boolean }`
  - `interface PropertyValuesParamsRead { key: string; limit?: number }`
  - `interface PropertyValueCount { value: unknown; count: number }`
  - `interface QueryNotesParams { where: Record<string, Condition>; match?: "all" | "any"; limit?: number }`
  - `interface GetPropertyParams { path: string; key: string }`
- Produces (in `properties.ts`):
  - `listProperties(vaultPath, params?): Promise<PropertySchemaEntry[]>`
  - `getPropertyValues(vaultPath, params): Promise<{ key: string; values: PropertyValueCount[] }>`
  - `queryNotes(vaultPath, params): Promise<NoteHeader[]>`
  - `getProperty(vaultPath, params): Promise<{ path: string; key: string; value: unknown; present: boolean }>`

- [ ] **Step 1: Add the types**

In `src/types.ts`, append (and add `import type { Condition } from "./tools/property-match.js";` at the top):

```typescript
export interface PropertySchemaEntry {
  key: string;
  count: number;
  /** Distinct value types observed: string|number|boolean|array|null|date. */
  types: string[];
}

export interface ListPropertiesParams {
  /** Include the `tags` key (already covered by list_tags). Default: true. */
  include_tags?: boolean;
}

export interface PropertyValuesParamsRead {
  key: string;
  limit?: number;
}

export interface PropertyValueCount {
  value: unknown;
  count: number;
}

export interface QueryNotesParams {
  where: Record<string, Condition>;
  match?: "all" | "any";
  limit?: number;
}

export interface GetPropertyParams {
  path: string;
  key: string;
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/properties-read.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeVault } from "./fixtures.js";
import {
  listProperties,
  getPropertyValues,
  queryNotes,
  getProperty,
} from "../src/tools/properties.js";

function vault() {
  return makeVault([
    { path: "a.md", content: "---\ntitle: A\nstatus: active\npriority: 5\ntags: [x]\n---\nbody\n" },
    { path: "b.md", content: "---\ntitle: B\nstatus: active\npriority: 2\naliases: [k, j]\n---\nbody\n" },
    { path: "c.md", content: "---\ntitle: C\nstatus: done\nnull_field:\n---\nbody\n" },
  ]);
}

test("listProperties reports keys, counts, and types", async () => {
  const { vaultPath, cleanup } = await vault();
  try {
    const props = await listProperties(vaultPath);
    const status = props.find((p) => p.key === "status");
    assert.equal(status?.count, 3);
    assert.deepEqual(status?.types, ["string"]);
    const priority = props.find((p) => p.key === "priority");
    assert.equal(priority?.count, 2);
    assert.deepEqual(priority?.types, ["number"]);
    const nullField = props.find((p) => p.key === "null_field");
    assert.deepEqual(nullField?.types, ["null"]);
  } finally {
    await cleanup();
  }
});

test("listProperties omits tags when include_tags is false", async () => {
  const { vaultPath, cleanup } = await vault();
  try {
    const props = await listProperties(vaultPath, { include_tags: false });
    assert.equal(props.some((p) => p.key === "tags"), false);
  } finally {
    await cleanup();
  }
});

test("getPropertyValues facets distinct values with counts", async () => {
  const { vaultPath, cleanup } = await vault();
  try {
    const res = await getPropertyValues(vaultPath, { key: "status" });
    assert.equal(res.values.find((v) => v.value === "active")?.count, 2);
    assert.equal(res.values.find((v) => v.value === "done")?.count, 1);
  } finally {
    await cleanup();
  }
});

test("getPropertyValues counts array elements individually", async () => {
  const { vaultPath, cleanup } = await vault();
  try {
    const res = await getPropertyValues(vaultPath, { key: "aliases" });
    assert.equal(res.values.find((v) => v.value === "k")?.count, 1);
    assert.equal(res.values.find((v) => v.value === "j")?.count, 1);
  } finally {
    await cleanup();
  }
});

test("queryNotes finds notes by condition", async () => {
  const { vaultPath, cleanup } = await vault();
  try {
    const hits = await queryNotes(vaultPath, {
      where: { status: "active", priority: { gt: 3 } },
    });
    assert.deepEqual(hits.map((h) => h.path), ["a"]);
  } finally {
    await cleanup();
  }
});

test("queryNotes with match any", async () => {
  const { vaultPath, cleanup } = await vault();
  try {
    const hits = await queryNotes(vaultPath, {
      where: { status: "done", priority: { gte: 5 } },
      match: "any",
    });
    assert.deepEqual(hits.map((h) => h.path).sort(), ["a", "c"]);
  } finally {
    await cleanup();
  }
});

test("getProperty distinguishes present, null, and absent", async () => {
  const { vaultPath, cleanup } = await vault();
  try {
    assert.deepEqual(
      await getProperty(vaultPath, { path: "a", key: "status" }),
      { path: "a", key: "status", value: "active", present: true }
    );
    const nul = await getProperty(vaultPath, { path: "c", key: "null_field" });
    assert.equal(nul.present, true);
    assert.equal(nul.value, null);
    const absent = await getProperty(vaultPath, { path: "a", key: "nope" });
    assert.equal(absent.present, false);
  } finally {
    await cleanup();
  }
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx tsx --test tests/properties-read.test.ts`
Expected: FAIL — `src/tools/properties.ts` does not exist.

- [ ] **Step 4: Implement `properties.ts`**

Create `src/tools/properties.ts`:

```typescript
import { assertVaultPath } from "./vault.js";
import { getIndex, entryToHeader } from "./vault-index.js";
import { matchesWhere } from "./property-match.js";
import {
  ListPropertiesParams,
  PropertySchemaEntry,
  PropertyValuesParamsRead,
  PropertyValueCount,
  QueryNotesParams,
  GetPropertyParams,
  NoteHeader,
} from "../types.js";

/** Canonical vault name for a note path (forward slashes, no .md suffix). */
function canonicalName(notePath: string): string {
  return notePath.replace(/\\/g, "/").replace(/\.md$/, "");
}

/** Classify a frontmatter value into a coarse type label. */
function typeOf(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "array";
  if (value instanceof Date) return "date";
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return t;
  return "object";
}

/**
 * The vault's frontmatter schema: every property key with the number of notes
 * using it and the distinct value types observed. Mirrors list_tags. Derived
 * from the shared index — no extra file reads.
 */
export async function listProperties(
  vaultPath: string,
  params: ListPropertiesParams = {}
): Promise<PropertySchemaEntry[]> {
  assertVaultPath(vaultPath);
  const includeTags = params.include_tags !== false;
  const index = await getIndex(vaultPath);

  const counts = new Map<string, number>();
  const types = new Map<string, Set<string>>();
  for (const entry of index.getEntries()) {
    for (const [key, value] of Object.entries(entry.frontmatter)) {
      if (!includeTags && key === "tags") continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      const set = types.get(key) ?? new Set<string>();
      set.add(typeOf(value));
      types.set(key, set);
    }
  }

  return [...counts.entries()]
    .map(([key, count]) => ({
      key,
      count,
      types: [...(types.get(key) ?? [])].sort(),
    }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

/**
 * Faceted distinct values for one property key, with the number of notes each
 * value appears in. Array-valued properties count each element once per note.
 */
export async function getPropertyValues(
  vaultPath: string,
  params: PropertyValuesParamsRead
): Promise<{ key: string; values: PropertyValueCount[] }> {
  assertVaultPath(vaultPath);
  const { key, limit } = params;
  if (!key || typeof key !== "string") {
    throw new Error("key must be a non-empty string");
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error("limit must be a positive integer");
  }
  const index = await getIndex(vaultPath);

  // Count by stringified value so distinct object identities collapse sensibly.
  const counts = new Map<string, { value: unknown; count: number }>();
  for (const entry of index.getEntries()) {
    const raw = entry.frontmatter[key];
    if (raw === undefined) continue;
    const items = Array.isArray(raw) ? raw : [raw];
    for (const item of new Set(items)) {
      const k = String(item);
      const slot = counts.get(k) ?? { value: item, count: 0 };
      slot.count += 1;
      counts.set(k, slot);
    }
  }

  let values = [...counts.values()].sort(
    (a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value))
  );
  if (limit !== undefined) values = values.slice(0, limit);
  return { key, values };
}

/**
 * Find notes whose frontmatter satisfies a set of conditions. Returns
 * lightweight headers so results compose with the other knowledge-base tools.
 */
export async function queryNotes(
  vaultPath: string,
  params: QueryNotesParams
): Promise<NoteHeader[]> {
  assertVaultPath(vaultPath);
  const { where, match = "all", limit } = params;
  if (!where || typeof where !== "object" || Array.isArray(where)) {
    throw new Error("where must be an object of property conditions");
  }
  if (match !== "all" && match !== "any") {
    throw new Error('match must be "all" or "any"');
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error("limit must be a positive integer");
  }
  const index = await getIndex(vaultPath);
  const matched = index
    .getEntries()
    .filter((e) => matchesWhere(e.frontmatter, where, match));
  const limited = limit !== undefined ? matched.slice(0, limit) : matched;
  return limited.map(entryToHeader);
}

/**
 * Read a single frontmatter property from one note. `present` distinguishes an
 * absent key from a key explicitly set to null.
 */
export async function getProperty(
  vaultPath: string,
  params: GetPropertyParams
): Promise<{ path: string; key: string; value: unknown; present: boolean }> {
  assertVaultPath(vaultPath);
  const { path, key } = params;
  if (!path || typeof path !== "string") throw new Error("A note path is required");
  if (!key || typeof key !== "string") throw new Error("key must be a non-empty string");
  const index = await getIndex(vaultPath);
  const entry = index.getEntry(canonicalName(path));
  if (!entry) throw new Error(`Note not found: ${canonicalName(path)}`);
  const present = key in entry.frontmatter;
  return {
    path: entry.path,
    key,
    value: present ? entry.frontmatter[key] : undefined,
    present,
  };
}
```

Note: `index.getEntry` is keyed by the canonical path. Verified in `src/tools/vault.ts`: `walkVault` builds each `f.path` via `toVaultName`, which strips `.md` and uses forward slashes; `vault-index.ts` keys `entries` by that `f.path`. So `index.getEntry(canonicalName(path))` looks up correctly for both `"a"` and `"a.md"` inputs.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx tsx --test tests/properties-read.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tools/properties.ts src/types.ts tests/properties-read.test.ts
git commit -m "feat: add frontmatter read tools (schema, facets, query, get-property)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Register all 7 tools in the MCP server

**Files:**
- Modify: `src/index.ts` (imports, tool definitions in `ListToolsRequestSchema`, dispatch cases in `CallToolRequestSchema`)
- Test: manual smoke via the server is out of scope here; covered by CLI test in Task 8. Add no new test file; rely on `npm test` + a typecheck.

**Interfaces:**
- Consumes: `listProperties`, `getPropertyValues`, `queryNotes`, `getProperty` (Task 6); `addNotePropertyValues`, `removeNotePropertyValues`, `renameNoteProperty` (Task 4); their param types.

- [ ] **Step 1: Add imports**

In `src/index.ts`, add:

```typescript
import {
  listProperties,
  getPropertyValues,
  queryNotes,
  getProperty,
} from "./tools/properties.js";
```

Extend the existing `./tools/write.js` import to include:

```typescript
  addNotePropertyValues,
  removeNotePropertyValues,
  renameNoteProperty,
  PropertyValuesParams,
  RenamePropertyParams,
```

Extend the `../types.js` import to include:

```typescript
  ListPropertiesParams,
  PropertyValuesParamsRead,
  QueryNotesParams,
  GetPropertyParams,
```

- [ ] **Step 2: Add tool definitions**

In the `tools` array (before the closing `]` of `ListToolsRequestSchema`), add the 4 read tools among the read tools and the 3 write tools among the write tools:

```typescript
      {
        name: "list_properties",
        description: "List every frontmatter property key used across the vault with the number of notes using it and the distinct value types observed (string/number/boolean/array/null/date), sorted by frequency. The vault's property schema; like list_tags but for arbitrary properties.",
        inputSchema: {
          type: "object",
          properties: {
            include_tags: { type: "boolean", description: "Include the tags key (default: true)" }
          }
        }
      },
      {
        name: "get_property_values",
        description: "List the distinct values of one frontmatter property with the number of notes each appears in, most frequent first. Array-valued properties count each element. A faceted index for a single key.",
        inputSchema: {
          type: "object",
          properties: {
            key: { type: "string", description: "The frontmatter property key to facet" },
            limit: { type: "number", description: "Maximum number of distinct values to return" }
          },
          required: ["key"]
        }
      },
      {
        name: "query_notes",
        description: "Find notes whose frontmatter satisfies a set of conditions, returning lightweight headers. Each condition is a bare scalar (equality / array-membership) or an operator object { eq, ne, gt, gte, lt, lte, exists, contains }. Comparisons are type-aware (numbers, ISO dates, strings). match: all (default) or any.",
        inputSchema: {
          type: "object",
          properties: {
            where: { type: "object", description: "Map of property key to condition (scalar or { eq/ne/gt/gte/lt/lte/exists/contains })" },
            match: { type: "string", enum: ["all", "any"], description: "Require all (default) or any of the conditions" },
            limit: { type: "number", description: "Maximum number of notes to return" }
          },
          required: ["where"]
        }
      },
      {
        name: "get_property",
        description: "Read a single frontmatter property value from one note. Returns { path, key, value, present }; present distinguishes an absent key from a key explicitly set to null.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative note path (with or without .md)" },
            key: { type: "string", description: "The frontmatter property key to read" }
          },
          required: ["path", "key"]
        }
      },
```

And among the write tools (e.g. after `set_frontmatter`):

```typescript
      {
        name: "add_property_values",
        description: "Add one or more values to an array-valued frontmatter property (idempotent, no duplicates). Creates the array if the key is absent; promotes an existing scalar to an array. Rejects nested objects and markdown. Returns the resulting list.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative note path (with or without .md)" },
            key: { type: "string", description: "The array-valued property key" },
            values: { type: "array", description: "Values to add" }
          },
          required: ["path", "key", "values"]
        }
      },
      {
        name: "remove_property_values",
        description: "Remove one or more values from an array-valued frontmatter property. An emptied array drops the key. Returns the resulting list.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative note path (with or without .md)" },
            key: { type: "string", description: "The array-valued property key" },
            values: { type: "array", description: "Values to remove" }
          },
          required: ["path", "key", "values"]
        }
      },
      {
        name: "rename_property",
        description: "Rename a frontmatter property key in a note, preserving its value and position. Errors if the source key is absent or the destination key already exists.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative note path (with or without .md)" },
            from: { type: "string", description: "Current property key" },
            to: { type: "string", description: "New property key" }
          },
          required: ["path", "from", "to"]
        }
      },
```

- [ ] **Step 3: Add dispatch cases**

In the `switch (name)` of `CallToolRequestSchema`, add (read tools among reads, write tools among writes):

```typescript
      case "list_properties": {
        const result = await listProperties(VAULT_PATH, (args ?? {}) as ListPropertiesParams);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "get_property_values": {
        const result = await getPropertyValues(VAULT_PATH, (args ?? {}) as unknown as PropertyValuesParamsRead);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "query_notes": {
        const result = await queryNotes(VAULT_PATH, (args ?? {}) as unknown as QueryNotesParams);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "get_property": {
        const result = await getProperty(VAULT_PATH, (args ?? {}) as unknown as GetPropertyParams);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "add_property_values": {
        const result = await addNotePropertyValues(VAULT_PATH, (args ?? {}) as unknown as PropertyValuesParams);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "remove_property_values": {
        const result = await removeNotePropertyValues(VAULT_PATH, (args ?? {}) as unknown as PropertyValuesParams);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "rename_property": {
        const result = await renameNoteProperty(VAULT_PATH, (args ?? {}) as unknown as RenamePropertyParams);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
```

- [ ] **Step 4: Typecheck + build**

Run: `npm run build`
Expected: PASS (no TypeScript errors). Then `npm test` — all green.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: register frontmatter property tools in the MCP server

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Query CLI subcommands

**Files:**
- Modify: `src/query-cli.ts` (imports, `queryTool` branches, `.command(...)` definitions)
- Test: `tests/property-cli.test.ts` (create — exercises the tool functions the CLI calls; the CLI is a thin shell)

**Interfaces:**
- Consumes: all 7 tool functions from `./tools/properties.js` and `./tools/write.js`.

- [ ] **Step 1: Write the failing test**

The CLI actions are thin wrappers over the tool functions already tested in Tasks 4 and 6. To avoid brittle process-spawn tests, add one end-to-end test that shells the CLI for a read and a write, matching the existing test conventions. Create `tests/property-cli.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { makeVault } from "./fixtures.js";

const run = promisify(execFile);
const CLI = ["tsx", "src/query-cli.ts"];

test("CLI: properties lists the schema", async () => {
  const { vaultPath, cleanup } = await makeVault([
    { path: "a.md", content: "---\nstatus: active\n---\nbody\n" },
  ]);
  try {
    const { stdout } = await run("npx", [...CLI, "properties"], {
      env: { ...process.env, OBSIDIAN_VAULT_PATH: vaultPath },
    });
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.some((p: any) => p.key === "status"), true);
  } finally {
    await cleanup();
  }
});

test("CLI: query --where filters by condition", async () => {
  const { vaultPath, cleanup } = await makeVault([
    { path: "a.md", content: "---\nstatus: active\n---\nbody\n" },
    { path: "b.md", content: "---\nstatus: done\n---\nbody\n" },
  ]);
  try {
    const { stdout } = await run(
      "npx",
      [...CLI, "query", "--where", '{"status":"active"}'],
      { env: { ...process.env, OBSIDIAN_VAULT_PATH: vaultPath } }
    );
    const parsed = JSON.parse(stdout);
    assert.deepEqual(parsed.map((h: any) => h.path), ["a"]);
  } finally {
    await cleanup();
  }
});

test("CLI: add-property-values mutates the note", async () => {
  const { vaultPath, cleanup } = await makeVault([
    { path: "a.md", content: "---\naliases: [x]\n---\nbody\n" },
  ]);
  try {
    const { stdout } = await run(
      "npx",
      [...CLI, "add-property-values", "a", "aliases", "y"],
      { env: { ...process.env, OBSIDIAN_VAULT_PATH: vaultPath } }
    );
    const parsed = JSON.parse(stdout);
    assert.deepEqual(parsed.values, ["x", "y"]);
  } finally {
    await cleanup();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/property-cli.test.ts`
Expected: FAIL — the subcommands do not exist (CLI errors "unknown command").

- [ ] **Step 3: Add imports and `queryTool` branches**

In `src/query-cli.ts`, extend the `./tools/write.js` import with `addNotePropertyValues, removeNotePropertyValues, renameNoteProperty`, and add:

```typescript
import {
  listProperties,
  getPropertyValues,
  queryNotes,
  getProperty,
} from "./tools/properties.js";
```

Add branches in `queryTool` (before the final `else`):

```typescript
    } else if (toolName === "list_properties") {
      result = await listProperties(VAULT_PATH!, args);
    } else if (toolName === "get_property_values") {
      result = await getPropertyValues(VAULT_PATH!, args);
    } else if (toolName === "query_notes") {
      result = await queryNotes(VAULT_PATH!, args);
    } else if (toolName === "get_property") {
      result = await getProperty(VAULT_PATH!, args);
    } else if (toolName === "add_property_values") {
      result = await addNotePropertyValues(VAULT_PATH!, args);
    } else if (toolName === "remove_property_values") {
      result = await removeNotePropertyValues(VAULT_PATH!, args);
    } else if (toolName === "rename_property") {
      result = await renameNoteProperty(VAULT_PATH!, args);
```

- [ ] **Step 4: Add the `.command(...)` definitions**

Add before `program.parseAsync(process.argv);`:

```typescript
program
  .command("properties")
  .description("List the frontmatter property schema (keys, counts, types)")
  .option("--no-tags", "Omit the tags key")
  .action(async (options: any, command: Command) => {
    await queryTool("list_properties", { include_tags: options.tags }, command.parent?.opts().verbose);
  });

program
  .command("property-values <key>")
  .description("List distinct values of a property with counts")
  .option("-l, --limit <n>", "Maximum number of values", (v) => parseInt(v, 10))
  .action(async (key: string, options: any, command: Command) => {
    await queryTool("get_property_values", { key, limit: options.limit }, command.parent?.opts().verbose);
  });

program
  .command("query")
  .description("Find notes by frontmatter condition (JSON where object)")
  .requiredOption("--where <json>", "Conditions as a JSON object")
  .option("--match <mode>", "all (default) or any", "all")
  .option("-l, --limit <n>", "Maximum number of notes", (v) => parseInt(v, 10))
  .action(async (options: any, command: Command) => {
    await queryTool(
      "query_notes",
      { where: JSON.parse(options.where), match: options.match, limit: options.limit },
      command.parent?.opts().verbose
    );
  });

program
  .command("get-property <path> <key>")
  .description("Read one frontmatter property from a note")
  .action(async (path: string, key: string, _options: any, command: Command) => {
    await queryTool("get_property", { path, key }, command.parent?.opts().verbose);
  });

program
  .command("add-property-values <path> <key> <values...>")
  .description("Add values to an array-valued property")
  .action(async (path: string, key: string, values: string[], _options: any, command: Command) => {
    await queryTool("add_property_values", { path, key, values }, command.parent?.opts().verbose);
  });

program
  .command("remove-property-values <path> <key> <values...>")
  .description("Remove values from an array-valued property")
  .action(async (path: string, key: string, values: string[], _options: any, command: Command) => {
    await queryTool("remove_property_values", { path, key, values }, command.parent?.opts().verbose);
  });

program
  .command("rename-property <path> <from> <to>")
  .description("Rename a frontmatter property key in a note")
  .action(async (path: string, from: string, to: string, _options: any, command: Command) => {
    await queryTool("rename_property", { path, from, to }, command.parent?.opts().verbose);
  });
```

Note: `--no-tags` in commander sets `options.tags` to `false` when passed, `true` otherwise, so passing `include_tags: options.tags` is correct.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx tsx --test tests/property-cli.test.ts`
Then: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/query-cli.ts tests/property-cli.test.ts
git commit -m "feat: add property search/CRUD subcommands to the query CLI

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Documentation (CLAUDE.md + README.md)

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`

**Interfaces:** none (docs only).

- [ ] **Step 1: Update CLAUDE.md — read tools**

In the read-tools section (after `get_frontmatter`, before `get_vault_stats`), add entries for `list_properties`, `get_property_values`, `query_notes`, `get_property`, matching the existing entry format (Purpose / Input / Output / Security where relevant). Document the `query_notes` operator set (`eq, ne, gt, gte, lt, lte, exists, contains`), the bare-scalar shorthand, and type-aware comparison.

- [ ] **Step 2: Update CLAUDE.md — write tools + validation**

In the Writing tools section (after `set_frontmatter`), add `add_property_values`, `remove_property_values`, `rename_property`. Add a short **Validation** note under the structure notes: writes reject nested objects, arrays of non-scalars, and markdown in string values (bare URLs allowed), validating only the keys each write touches. Update the "thirteen write tools" count wording to sixteen (search the file for "thirteen write tools" and update it).

- [ ] **Step 3: Update CLAUDE.md — index note + CLI examples**

Add `query_notes`, `list_properties`, `get_property_values` to the list of index-backed tools in the "Vault index" paragraph. Add CLI examples under the Testing section mirroring the existing style:

```bash
npm run query -- properties                             # Frontmatter schema
npm run query -- property-values status                 # Distinct values of a key
npm run query -- query --where '{"status":"active","priority":{"gt":3}}'
npm run query -- get-property "projects/alpha" status
npm run query -- add-property-values "projects/alpha" aliases a2 a3
npm run query -- remove-property-values "projects/alpha" aliases a3
npm run query -- rename-property "projects/alpha" author authors
```

- [ ] **Step 4: Update README.md**

Mirror the same additions in `README.md` (tool list and any CLI/example sections it carries), consistent with how `search_notes_ranked` was documented in both files.

- [ ] **Step 5: Verify and commit**

Run: `npm test && npm run build`
Expected: PASS (docs don't affect tests, but confirm the tree is still green before committing).

```bash
git add CLAUDE.md README.md
git commit -m "docs: document frontmatter property search, CRUD & validation tools

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Read: `list_properties` (T6), `get_property_values` (T6), `query_notes` (T6), `get_property` (T6) ✓
- Write: `add_property_values` / `remove_property_values` (T3 core, T4 wrapper), `rename_property` (T3/T4) ✓
- Scalar→array promotion (T3), emptied-array drops key (T3) ✓
- Validation: nested objects, non-scalar arrays, markdown-in-strings, bare URLs allowed, null allowed (T1); enforce-on-write via setFrontmatter/addTags/addPropertyValues (T2, T3); validate-only-changed (T2 test, and by construction — remove/rename don't validate) ✓
- Full operator set + type-aware compare (T5); shared matcher used by both query_notes and recent (T5, T6) ✓
- Gating behind OBSIDIAN_ALLOW_WRITES (T4 WRITE_TOOL_NAMES) ✓
- MCP registration (T7), CLI (T8), dual-doc (T9) ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every test step shows real assertions. The only conditional is the `getEntry` keying note in T6 Step 4, which gives an explicit fallback — not a placeholder.

**Type consistency:** `matchesWhere(fm, where, match?)` signature identical in T5 (def), T6 (use), and T5 recent rewire. `PropertyValuesParams` (write, T4) vs `PropertyValuesParamsRead` (read, T6) are deliberately distinct names to avoid collision. `addPropertyValues`/`removePropertyValues`/`renameProperty` (core, T3) vs `addNotePropertyValues`/`removeNotePropertyValues`/`renameNoteProperty` (wrappers, T4) named consistently across tasks. Return shapes match between wrappers (T4) and dispatch/CLI (T7/T8).

**Index key convention verified:** `getProperty` (T6) relies on `index.getEntry` being keyed by the canonical, no-`.md` path. Confirmed against `src/tools/vault.ts` (`toVaultName` strips `.md`) — no open questions remain.
