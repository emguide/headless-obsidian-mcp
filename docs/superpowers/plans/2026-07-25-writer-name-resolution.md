# Writer Name Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make edit-existing write tools resolve a bare basename or wrong-case path through the shared vault index — exactly like readers — while failing loud on an ambiguous bare name and leaving create paths literal.

**Architecture:** Add one index primitive (`resolveForWrite`) that distinguishes resolved / ambiguous / unresolved (which `index.resolve` cannot, because it silently picks a shortest-path winner). Wrap it in a shared helper pair in `not-found.ts`. Wire the helper into two chokepoints — `readRaw` (covers most edit-existing writers via `editNote`) and the four tools that call `resolveNotePath` directly (`delete_note`, `move_note` source, `set_task_state`, `bulk_edit`). `move_note`/`rename_section` already index-resolve; they switch to the new primitive to gain the ambiguity guard. Create paths stay untouched.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node's built-in `node:test` runner via tsx, no extra deps.

## Global Constraints

- **Test runner:** `npm test` runs `node:test` via tsx. Run a single file with `npx tsx --test tests/<file>.test.ts`. Tests import source directly from `../src/...` with `.js` specifiers.
- **Fixtures:** Use `makeVault(notes)` from `tests/fixtures.js`; it clears the index cache and returns `{ vaultPath, cleanup }`. Notes are `{ path (with .md), content }`.
- **Import specifiers:** every relative import ends in `.js` even for `.ts` files (ESM/NodeNext).
- **Canonical name:** a note's identity is its path minus `.md`, forward-slashed (`canonicalName` in `src/tools/vault.ts`).
- **Reader precedent (do not exceed):** resolution is path/basename only, case-insensitive, exact — never title/alias (that is `resolve_note`'s job), never fuzzy. Slash-qualified misses get no basename fallback.
- **Create paths stay literal:** `write_note`, `apply_template`, and the `create:true` branches of `append_note`/`prepend_note` are out of scope and must not resolve.
- **Docs rule (CLAUDE.md):** any functional change updates BOTH `CLAUDE.md` and `README.md`.
- **Git messages:** end commit messages with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## File Structure

- `src/types.ts` — add `WriteResolution` discriminated-union type (lives beside `ResolveMatch`).
- `src/tools/vault-index.ts` — add `resolveForWrite(target)` method on `VaultIndex`.
- `src/tools/not-found.ts` — add `resolveWriteTarget(index, path)` and `resolveWriteTargetAsync(vaultPath, path)`.
- `src/tools/write.ts` — resolve in `readRaw`; resolve `from`/target in `deleteNote`, `moveNote`, `setTaskState`; switch `moveNote`/`renameSectionInVault` from `index.resolve` to `resolveForWrite`; report resolved path in outputs/messages.
- `src/tools/bulk.ts` — resolve each explicit path in the per-note loop.
- `src/tools/templates.ts` — align `insertTemplate`'s echoed `path` with the resolved name (no resolution logic of its own).
- `tests/write-resolution.test.ts` — new: unit tests for the primitive + helper, integration tests per writer.
- `tests/not-found.test.ts` — modify: the existing write-side rejection tests invert (a bare name now succeeds).
- `CLAUDE.md`, `README.md` — new "Note addressing on writes" convention.

---

## Task 1: `resolveForWrite` index primitive

**Files:**
- Modify: `src/types.ts` (add `WriteResolution`)
- Modify: `src/tools/vault-index.ts` (add method after `resolve`, ~line 203)
- Test: `tests/write-resolution.test.ts` (create)

**Interfaces:**
- Consumes: `VaultIndex` private `byPath: Map<string,string>` (lowercased path → canonical path) and `byBasename: Map<string,string[]>` (lowercased basename → canonical paths, shortest-path-then-alpha ordered).
- Produces:
  ```ts
  // src/types.ts
  export type WriteResolution =
    | { kind: "resolved"; path: string }
    | { kind: "ambiguous"; candidates: string[] }
    | { kind: "unresolved" };

  // VaultIndex method
  resolveForWrite(target: string): WriteResolution
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/write-resolution.test.ts`:

```ts
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { makeVault, Fixture } from "./fixtures.js";
import { getIndex } from "../src/tools/vault-index.js";

/** Vault with: a folder note, a root note, and two notes sharing a basename. */
function notes() {
  return [
    { path: "projects/alpha.md", content: "# Alpha" },
    { path: "root-note.md", content: "# Root" },
    { path: "daily/log.md", content: "# Daily log" },
    { path: "projects/log.md", content: "# Project log" },
  ];
}

describe("VaultIndex.resolveForWrite", () => {
  let fx: Fixture;
  before(async () => { fx = await makeVault(notes()); });
  after(() => fx.cleanup());

  test("exact path resolves (case-insensitive)", async () => {
    const index = await getIndex(fx.vaultPath);
    assert.deepEqual(index.resolveForWrite("projects/alpha"), {
      kind: "resolved", path: "projects/alpha",
    });
    assert.deepEqual(index.resolveForWrite("Projects/Alpha"), {
      kind: "resolved", path: "projects/alpha",
    });
    assert.deepEqual(index.resolveForWrite("projects/alpha.md"), {
      kind: "resolved", path: "projects/alpha",
    });
  });

  test("unique bare basename resolves", async () => {
    const index = await getIndex(fx.vaultPath);
    assert.deepEqual(index.resolveForWrite("alpha"), {
      kind: "resolved", path: "projects/alpha",
    });
    assert.deepEqual(index.resolveForWrite("ROOT-NOTE"), {
      kind: "resolved", path: "root-note",
    });
  });

  test("ambiguous bare basename reports candidates", async () => {
    const index = await getIndex(fx.vaultPath);
    assert.deepEqual(index.resolveForWrite("log"), {
      kind: "ambiguous", candidates: ["daily/log", "projects/log"],
    });
  });

  test("slash-qualified miss is unresolved (no basename fallback)", async () => {
    const index = await getIndex(fx.vaultPath);
    assert.deepEqual(index.resolveForWrite("wrong/alpha"), { kind: "unresolved" });
  });

  test("no match is unresolved", async () => {
    const index = await getIndex(fx.vaultPath);
    assert.deepEqual(index.resolveForWrite("nope"), { kind: "unresolved" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/write-resolution.test.ts`
Expected: FAIL — `index.resolveForWrite is not a function`.

- [ ] **Step 3: Add the type**

In `src/types.ts`, near the `ResolveMatch` / `ResolveMatchField` declarations, add:

```ts
/**
 * Outcome of resolving a WRITE target's name through the index. Unlike
 * VaultIndex.resolve (which silently picks a shortest-path winner for an
 * ambiguous bare basename), this distinguishes the ambiguous case so a write
 * can fail loud instead of mutating the wrong note.
 */
export type WriteResolution =
  | { kind: "resolved"; path: string }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "unresolved" };
```

- [ ] **Step 4: Implement the method**

In `src/tools/vault-index.ts`, add `WriteResolution` to the type import from `../types.js`, then add this method immediately after `resolve` (after line 203):

```ts
  /**
   * Resolve a WRITE target's name, distinguishing unique from ambiguous — the
   * distinction {@link resolve} hides. Same matching rules as `resolve` (exact
   * path wins; slash-less bare basename falls back; a slash-qualified miss does
   * NOT fall back), but an ambiguous bare basename is reported as such rather
   * than silently resolved to the shortest-path candidate. A caller turns
   * `unresolved` into the literal-path not-found flow and `ambiguous` into a
   * fail-loud error.
   */
  resolveForWrite(target: string): WriteResolution {
    const key = target.replace(/\.md$/i, "").replace(/\\/g, "/").toLowerCase();
    const exact = this.byPath.get(key);
    if (exact) return { kind: "resolved", path: exact };
    if (key.includes("/")) return { kind: "unresolved" }; // path-qualified: no fallback
    const candidates = this.byBasename.get(key);
    if (!candidates || candidates.length === 0) return { kind: "unresolved" };
    if (candidates.length === 1) return { kind: "resolved", path: candidates[0] };
    return { kind: "ambiguous", candidates: [...candidates] };
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx tsx --test tests/write-resolution.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/tools/vault-index.ts tests/write-resolution.test.ts
git commit -m "$(cat <<'EOF'
feat(index): add resolveForWrite distinguishing ambiguous from unique names

VaultIndex.resolve silently picks a shortest-path winner for an ambiguous
bare basename; resolveForWrite surfaces the ambiguity so writes can fail loud.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `resolveWriteTarget` / `resolveWriteTargetAsync` helpers

**Files:**
- Modify: `src/tools/not-found.ts`
- Test: `tests/write-resolution.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `VaultIndex.resolveForWrite` (Task 1); `canonical` (private in not-found.ts); `getIndex` (already imported in not-found.ts).
- Produces:
  ```ts
  export function resolveWriteTarget(index: VaultIndex, notePath: string): string
  export function resolveWriteTargetAsync(vaultPath: string, notePath: string): Promise<string>
  ```
  Both return the resolved canonical path, or the input's canonical form unchanged when unresolved. Both throw `Ambiguous note name: <name>. Candidates: <a>, <b>. Pass the full path.` on an ambiguous bare name.

- [ ] **Step 1: Write the failing test**

Append to `tests/write-resolution.test.ts`:

```ts
import {
  resolveWriteTarget,
  resolveWriteTargetAsync,
} from "../src/tools/not-found.js";

describe("resolveWriteTarget", () => {
  let fx: Fixture;
  before(async () => { fx = await makeVault(notes()); });
  after(() => fx.cleanup());

  test("resolved name returns the canonical path", async () => {
    const index = await getIndex(fx.vaultPath);
    assert.equal(resolveWriteTarget(index, "alpha"), "projects/alpha");
    assert.equal(resolveWriteTarget(index, "Projects/Alpha"), "projects/alpha");
  });

  test("unresolved name returns the input canonical unchanged", async () => {
    const index = await getIndex(fx.vaultPath);
    assert.equal(resolveWriteTarget(index, "brand-new"), "brand-new");
    assert.equal(resolveWriteTarget(index, "wrong/alpha"), "wrong/alpha");
  });

  test("ambiguous name throws listing candidates", async () => {
    const index = await getIndex(fx.vaultPath);
    assert.throws(
      () => resolveWriteTarget(index, "log"),
      /Ambiguous note name: log\. Candidates: daily\/log, projects\/log\. Pass the full path\./
    );
  });

  test("async variant resolves and throws the same way", async () => {
    assert.equal(await resolveWriteTargetAsync(fx.vaultPath, "alpha"), "projects/alpha");
    await assert.rejects(
      () => resolveWriteTargetAsync(fx.vaultPath, "log"),
      /Ambiguous note name: log/
    );
  });

  test("async variant degrades to input canonical when the index cannot build", async () => {
    // A nonexistent vault: index build fails, so an unresolvable name passes
    // through unchanged (the caller's literal not-found flow then fires).
    assert.equal(
      await resolveWriteTargetAsync("/nonexistent-vault-xyz", "ghost"),
      "ghost"
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/write-resolution.test.ts`
Expected: FAIL — `resolveWriteTarget is not exported` / not a function.

- [ ] **Step 3: Implement the helpers**

In `src/tools/not-found.ts`, add `WriteResolution` is not needed here (the method returns it); append after `resolveNoteName` (after line 38):

```ts
/**
 * Resolve a WRITE target's name to its canonical path the way readers resolve
 * (bare basename, wrong-case), but fail loud on an ambiguous bare name rather
 * than silently mutating the shortest-path note. Returns the input's canonical
 * form unchanged when the name does not resolve, so the caller's existing
 * literal-path not-found flow still fires (and create paths stay literal).
 */
export function resolveWriteTarget(index: VaultIndex, notePath: string): string {
  const canon = canonical(notePath);
  const res = index.resolveForWrite(canon);
  if (res.kind === "resolved") return res.path;
  if (res.kind === "ambiguous") {
    throw new Error(
      `Ambiguous note name: ${canon}. Candidates: ${res.candidates.join(", ")}. ` +
        `Pass the full path.`
    );
  }
  return canon; // unresolved: fall through to the literal path
}

/**
 * Async convenience for write sites that do not already hold an index (the
 * write funnel). Mirrors {@link noteNotFoundError}: a failed index build is NOT
 * masked into an error — the name degrades to its canonical form and the
 * caller's own not-found flow decides. An AMBIGUOUS name, however, still throws
 * (it is a caller error worth surfacing, not an index hiccup).
 */
export async function resolveWriteTargetAsync(
  vaultPath: string,
  notePath: string
): Promise<string> {
  try {
    const index = await getIndex(vaultPath);
    return resolveWriteTarget(index, notePath);
  } catch (err) {
    // Re-throw a genuine ambiguity error; swallow index-build failures only.
    if (err instanceof Error && err.message.startsWith("Ambiguous note name:")) {
      throw err;
    }
    return canonical(notePath);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/write-resolution.test.ts`
Expected: PASS (all Task 1 + Task 2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tools/not-found.ts tests/write-resolution.test.ts
git commit -m "$(cat <<'EOF'
feat(not-found): add resolveWriteTarget write-name resolution helpers

Resolve bare/wrong-case write targets like readers; fail loud on ambiguity;
pass unresolved names through unchanged so the literal not-found flow fires.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Resolve in `readRaw` (covers the editNote-based writers + patch/append/prepend)

**Files:**
- Modify: `src/tools/write.ts` (`readRaw`, line 169)
- Test: `tests/write-resolution.test.ts` (append integration block)

**Interfaces:**
- Consumes: `resolveWriteTargetAsync` (Task 2).
- Produces: `readRaw` now resolves its `notePath` before reading, so every tool routing through `editNote` (`add_tag`, `remove_tag`, `set_frontmatter`, `add/remove_property_values`, `rename_property`, `add_section`, `append_to_section`, `replace_section`) plus `patchNote` and the existing-note branch of `appendNote`/`prependNote` accept bare/wrong-case names. Signature unchanged.

- [ ] **Step 1: Write the failing test**

Append to `tests/write-resolution.test.ts`:

```ts
import {
  addTag,
  patchNote,
  setNoteFrontmatter,
  appendNote,
  writeNote,
} from "../src/tools/write.js";
import { getFrontmatter } from "../src/tools/frontmatter.js";
import { readRaw } from "../src/tools/write.js";

describe("edit-existing writers resolve bare/wrong-case names", () => {
  let fx: Fixture;
  before(async () => { fx = await makeVault(notes()); });
  after(() => fx.cleanup());

  test("add_tag on a bare basename hits the folder note", async () => {
    const res = await addTag(fx.vaultPath, { path: "alpha", tags: ["x"] });
    assert.equal(res.path, "projects/alpha"); // resolved path echoed
    const fm = await getFrontmatter(fx.vaultPath, "projects/alpha");
    assert.deepEqual(fm.frontmatter.tags, ["x"]);
  });

  test("patch_note on a wrong-case path hits the note", async () => {
    const res = await patchNote(fx.vaultPath, {
      path: "Projects/Alpha", find: "# Alpha", replace: "# Alpha!",
    });
    assert.equal(res.path, "projects/alpha");
    assert.equal(res.replacements, 1);
  });

  test("set_frontmatter on a bare name resolves", async () => {
    await setNoteFrontmatter(fx.vaultPath, { path: "root-note", set: { s: 1 } });
    const fm = await getFrontmatter(fx.vaultPath, "root-note");
    assert.equal(fm.frontmatter.s, 1);
  });

  test("ambiguous bare name fails loud and writes nothing", async () => {
    const before = await readRaw(fx.vaultPath, "daily/log");
    await assert.rejects(
      () => addTag(fx.vaultPath, { path: "log", tags: ["y"] }),
      /Ambiguous note name: log/
    );
    const after = await readRaw(fx.vaultPath, "daily/log");
    assert.equal(after, before); // untouched
  });

  test("append_note WITHOUT create resolves a bare name", async () => {
    const res = await appendNote(fx.vaultPath, { path: "alpha", content: "more" });
    assert.equal(res.path, "projects/alpha");
    assert.equal(res.created, false);
  });

  test("append_note WITH create stays literal (create path unchanged)", async () => {
    // "alpha" already exists at projects/alpha, but create targets the literal
    // root path — a NEW note, never a redirect onto the folder note.
    const res = await appendNote(fx.vaultPath, {
      path: "alpha", content: "x", create: true,
    });
    assert.equal(res.path, "alpha");
    assert.equal(res.created, true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/write-resolution.test.ts`
Expected: FAIL — `add_tag("alpha")` rejects with "Note not found" (readRaw not yet resolving), and the resolved-path echo assertions fail.

- [ ] **Step 3: Resolve in `readRaw`**

In `src/tools/write.ts`, add `resolveWriteTargetAsync` to the import from `./not-found.js` (line 19), then update `readRaw` (line 169):

```ts
/** Read an existing note's raw text, or throw a friendly not-found error. */
export async function readRaw(vaultPath: string, notePath: string): Promise<string> {
  const resolved = await resolveWriteTargetAsync(vaultPath, notePath);
  const fullPath = resolveNotePath(vaultPath, resolved);
  try {
    return await readFile(fullPath, "utf-8");
  } catch {
    throw await noteNotFoundError(vaultPath, resolved);
  }
}
```

Note: `readRaw` returns only text; the resolved-path *echo* in each tool's output comes from those tools calling `canonicalName(path)` on the original input. Fix the echo in Step 5.

- [ ] **Step 4: Run test to verify the write-behavior tests pass (echo still wrong)**

Run: `npx tsx --test tests/write-resolution.test.ts`
Expected: the ambiguity/create/behavior tests PASS; the `res.path === "projects/alpha"` echo assertions still FAIL (tools echo the raw input `"alpha"`).

- [ ] **Step 5: Echo the resolved path in the editNote-based tools**

The clean fix is central: have `editNote` resolve once and report the resolved name. Update `editNote` (line 186) to resolve and return the resolved path, and have `readRaw` reuse it. Change `editNote`'s return to include the resolved path:

```ts
async function editNote(
  vaultPath: string,
  notePath: string,
  mutate: (doc: NoteDocument) => boolean | void,
  message: string
): Promise<{ changed: boolean; content: string; path: string }> {
  const resolved = await resolveWriteTargetAsync(vaultPath, notePath);
  const raw = await readRaw(vaultPath, resolved);
  const doc = NoteDocument.parse(raw);
  const changed = mutate(doc);
  if (changed === false) return { changed: false, content: raw, path: resolved };
  const content = doc.serialize();
  await commitWrite(vaultPath, resolved, content, message);
  return { changed: true, content, path: resolved };
}
```

Then in each editNote-based tool, use the returned `path` for the echoed output and the git message. Concretely, update `addTag` (line 865) as the pattern for all of them:

```ts
export async function addTag(
  vaultPath: string,
  { path, tags }: TagParams
): Promise<{ path: string; tags: string[] }> {
  if (!Array.isArray(tags) || tags.length === 0) {
    throw new Error("tags must be a non-empty array");
  }
  let resultTags: string[] = [];
  const { path: resolved } = await editNote(
    vaultPath,
    path,
    (doc) => {
      const next = addTags(doc, tags);
      resultTags = next ?? frontmatterTagList(doc.data);
      return next != null;
    },
    `add_tag: ${canonicalName(path)}`
  );
  return { path: resolved, tags: resultTags };
}
```

Apply the same `const { path: resolved } = await editNote(...)` + `return { path: resolved, ... }` change to: `removeTag`, `setNoteFrontmatter`, `addNotePropertyValues`, `removeNotePropertyValues`, `renameNoteProperty`, `addNoteSection`, `appendNoteSection`, `replaceNoteSection`. For the three section tools that also compute link health, resolve the health from `resolved`:

```ts
export async function appendNoteSection(
  vaultPath: string,
  { path, heading, content, create }: SectionEditParams
): Promise<{ path: string; heading: string } & LinkHealth> {
  const { content: written, path: resolved } = await editNote(
    vaultPath,
    path,
    (doc) => appendToSection(doc, heading, content ?? "", create ?? false),
    `append_to_section: ${canonicalName(path)}`
  );
  const health = await linkHealthAfterWrite(vaultPath, resolved, written);
  return { path: resolved, heading, ...health };
}
```

(The git message keeps `canonicalName(path)`; changing it to `resolved` is optional — the spec asks for it, so update the message string to `${resolved}` too for consistency. Since `resolved` is computed inside `editNote`, pass a resolved message by moving the resolution out, OR accept that the message shows the input name. **Decision: keep the message on the input name** to avoid double-resolving; the returned `path` and the committed *content* are correct, which is what matters for review. Note this in the commit body.)

For `patchNote`, `appendNote`, `prependNote` (which call `readRaw` directly, not `editNote`), resolve once at the top and use it for both the read and the echo:

```ts
// patchNote — after the find/replace validation, before readRaw:
const resolved = await resolveWriteTargetAsync(vaultPath, path);
const raw = await readRaw(vaultPath, resolved);
// ...use `resolved` in canonicalName-echo spots and commitWrite/linkHealth:
await commitWrite(vaultPath, resolved, next, `patch_note: ${resolved}`);
const health = await linkHealthAfterWrite(vaultPath, resolved, next);
return { path: resolved, replacements, ...health };
```

For `appendNote`/`prependNote`, resolve only on the **existing-note branch** (after the `if (!existed)` create block), leaving the create branch on the literal `path`:

```ts
// appendNote, existing-note branch (after the create block returns):
const resolved = await resolveWriteTargetAsync(vaultPath, path);
const raw = await readRaw(vaultPath, resolved);
const separator = raw.length === 0 || raw.endsWith("\n") ? "" : "\n";
const next = raw + separator + content + (content.endsWith("\n") ? "" : "\n");
await commitWrite(vaultPath, resolved, next, `append_note: ${resolved}`);
const health = await linkHealthAfterWrite(vaultPath, resolved, next);
return { path: resolved, created: false, ...health };
```

Note the create-branch `fileExists` check stays on the literal `path` (via `resolveNotePath(vaultPath, path)` at the top), so `create:true` on a bare name still creates the literal note.

- [ ] **Step 6: Run the full resolution test file**

Run: `npx tsx --test tests/write-resolution.test.ts`
Expected: PASS (all Task 1–3 tests, including the resolved-path echoes).

- [ ] **Step 7: Run the broader write suite for regressions**

Run: `npx tsx --test tests/write.test.ts tests/edit-extras.test.ts tests/property-edit.test.ts tests/link-health.test.ts`
Expected: PASS (no regressions — canonical-path inputs are unaffected since `resolveWriteTarget` returns them unchanged).

- [ ] **Step 8: Commit**

```bash
git add src/tools/write.ts tests/write-resolution.test.ts
git commit -m "$(cat <<'EOF'
feat(write): resolve bare/wrong-case names in readRaw + editNote writers

add_tag/patch_note/set_frontmatter/section/property tools and existing-note
append/prepend now resolve names like readers, fail loud on ambiguity, echo
the resolved path. Create paths stay literal.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Resolve in the direct `resolveNotePath` writers (delete, move, task-state)

**Files:**
- Modify: `src/tools/write.ts` (`deleteNote` line 364, `moveNote` line 438, `renameSectionInVault` line 631, `setTaskState` line 754)
- Test: `tests/write-resolution.test.ts` (append)

**Interfaces:**
- Consumes: `resolveWriteTargetAsync` (Task 2), `VaultIndex.resolveForWrite` (Task 1).
- Produces: `delete_note`, `move_note` (source `from`), `set_task_state` accept bare/wrong-case names; `move_note`/`rename_section` gain fail-loud ambiguity on their target (previously silent shortest-path pick). Destinations (`move_note` `to`) stay literal.

- [ ] **Step 1: Write the failing test**

Append to `tests/write-resolution.test.ts`:

```ts
import { deleteNote, moveNote, setTaskState } from "../src/tools/write.js";
import { renameSectionInVault } from "../src/tools/write.js";

function taskNotes() {
  return [
    { path: "projects/alpha.md", content: "# Alpha\n\n- [ ] ship it\n" },
    { path: "daily/log.md", content: "# Daily log" },
    { path: "projects/log.md", content: "# Project log" },
    { path: "solo.md", content: "# Solo\n\n## Old Heading\ntext\n" },
  ];
}

describe("direct-resolveNotePath writers resolve names", () => {
  let fx: Fixture;
  before(async () => { fx = await makeVault(taskNotes()); });
  after(() => fx.cleanup());

  test("delete_note resolves a bare basename", async () => {
    const res = await deleteNote(fx.vaultPath, "solo");
    assert.equal(res.path, "solo");
    assert.equal(res.deleted, true);
  });

  test("set_task_state resolves a wrong-case path", async () => {
    const res = await setTaskState(fx.vaultPath, {
      path: "Projects/Alpha", text: "ship it", status: "done",
    });
    assert.equal(res.path, "projects/alpha");
    assert.equal(res.marker, "x");
  });

  test("move_note resolves a bare `from`", async () => {
    // recreate solo first (deleted above runs in same fixture order-independently)
    // NOTE: this test uses its own fresh fixture to avoid ordering coupling.
  });

  test("move_note ambiguous `from` fails loud (hardening)", async () => {
    await assert.rejects(
      () => moveNote(fx.vaultPath, { from: "log", to: "archive/log" }),
      /Ambiguous note name: log/
    );
  });

  test("rename_section ambiguous `path` fails loud (hardening)", async () => {
    await assert.rejects(
      () => renameSectionInVault(fx.vaultPath, {
        path: "log", from: "X", to: "Y",
      }),
      /Ambiguous note name: log/
    );
  });
});

describe("move_note resolves bare from (isolated fixture)", () => {
  let fx: Fixture;
  before(async () => {
    fx = await makeVault([{ path: "projects/alpha.md", content: "# Alpha" }]);
  });
  after(() => fx.cleanup());

  test("bare `from` moves the folder note", async () => {
    const res = await moveNote(fx.vaultPath, { from: "alpha", to: "archive/alpha" });
    assert.equal(res.from, "projects/alpha");
    assert.equal(res.to, "archive/alpha");
  });
});
```

Remove the empty placeholder `test("move_note resolves a bare `from`", ...)` above — it is covered by the isolated-fixture describe. (Delete that stub before running.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/write-resolution.test.ts`
Expected: FAIL — bare/wrong-case `delete_note`/`set_task_state`/`move_note` reject with "Note not found"; ambiguous `move_note`/`rename_section` silently pick a note instead of throwing.

- [ ] **Step 3: Resolve in `deleteNote`**

In `deleteNote` (line 364), resolve at the top before the `fileExists` check:

```ts
export async function deleteNote(
  vaultPath: string,
  notePath: string,
  { permanent = false, include_context = false }: DeleteNoteOptions = {}
): Promise<{ ... }> {
  const resolved = await resolveWriteTargetAsync(vaultPath, notePath);
  const fullPath = resolveNotePath(vaultPath, resolved);
  if (!(await fileExists(fullPath))) {
    throw await noteNotFoundError(vaultPath, resolved);
  }
  // ...replace every subsequent `notePath` / `canonicalName(notePath)` with
  // `resolved` / `canonicalName(resolved)`:
  const index = await getIndex(vaultPath);
  const backlinkPaths = index.backlinks(canonicalName(resolved));
  const dangled_backlinks = include_context
    ? await backlinkContext(index, backlinkPaths, canonicalName(resolved))
    : backlinkPaths;
  // ...and in the permanent/trash blocks, use canonicalName(resolved) throughout.
}
```

- [ ] **Step 4: Resolve in `moveNote` (source only)**

In `moveNote` (line 438), resolve `from` up front; the `resolveForWrite`-via-helper both resolves the name AND gives the ambiguity guard. Replace the existing `index.resolve(fromCanon)` block:

```ts
  // Resolve the source name (bare/wrong-case) and fail loud on ambiguity. This
  // supersedes the later index.resolve(fromCanon) used for backlink keying.
  const fromResolved = await resolveWriteTargetAsync(vaultPath, from);
  const fromFull = resolveNotePath(vaultPath, fromResolved);
  const toFull = resolveNotePath(vaultPath, to);
  const fromCanon = canonicalName(fromResolved);
  const toCanon = canonicalName(to);
  if (fromCanon === toCanon) {
    throw new Error("Source and destination are the same note");
  }
  if (!(await fileExists(fromFull))) {
    throw await noteNotFoundError(vaultPath, fromResolved);
  }
  // ...
  let backlinks: string[] = [];
  let resolvedFrom = fromCanon;
  if (update_links) {
    const index = await getIndex(vaultPath);
    resolvedFrom = index.resolve(fromCanon) ?? fromCanon; // now a case-exact hit
    backlinks = index.backlinks(resolvedFrom);
  }
```

The return's `from: fromCanon` now reports the resolved source path. `to` stays literal (a create target).

- [ ] **Step 5: Resolve in `renameSectionInVault`**

In `renameSectionInVault` (line 631), the note is addressed by `path`. Resolve it up front (ambiguity guard) and use the resolved canon:

```ts
  const resolvedPath = await resolveWriteTargetAsync(vaultPath, path);
  const canon = canonicalName(resolvedPath);
  // ...the rest already reads via readRaw(vaultPath, path) — change to
  // readRaw(vaultPath, resolvedPath), and index.resolve(canon) stays (case-exact).
```

Update the `readRaw(vaultPath, path)` call (line 674) to `readRaw(vaultPath, resolvedPath)` and `writeResolved(vaultPath, path, ...)` (line 703) to `writeResolved(vaultPath, resolvedPath, ...)`.

- [ ] **Step 6: Resolve in `setTaskState`**

In `setTaskState` (line 754), resolve before `readRaw`:

```ts
  const resolved = await resolveWriteTargetAsync(vaultPath, path);
  const canon = canonicalName(resolved);
  const raw = await readRaw(vaultPath, resolved);
```

(Replace the existing `canonicalName(path)` and `readRaw(vaultPath, path)` on lines 779–780; every downstream use of `canon` / `path` in the commit message and output already flows from `canon`, and `commitWrite(vaultPath, path, ...)` at line 845 becomes `commitWrite(vaultPath, resolved, ...)`.)

- [ ] **Step 7: Delete the placeholder stub test**

Remove the empty `test("move_note resolves a bare `from`", ...)` stub added in Step 1 (covered by the isolated describe).

- [ ] **Step 8: Run the resolution + regression suites**

Run: `npx tsx --test tests/write-resolution.test.ts tests/write.test.ts tests/rename-section.test.ts tests/edit-extras.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/tools/write.ts tests/write-resolution.test.ts
git commit -m "$(cat <<'EOF'
feat(write): resolve names in delete/move/task-state; harden move/rename ambiguity

delete_note, move_note (source), set_task_state, rename_section now resolve
bare/wrong-case names. move_note/rename_section gain fail-loud ambiguity on
their target (previously a silent shortest-path pick).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Resolve explicit paths in `bulk_edit`

**Files:**
- Modify: `src/tools/bulk.ts` (per-note loop, line 215)
- Test: `tests/write-resolution.test.ts` (append)

**Interfaces:**
- Consumes: `resolveWriteTarget` (Task 2), `getIndex`.
- Produces: `bulk_edit` with explicit `paths` resolves each; an ambiguous path becomes that note's isolated `{ ok:false, error }` row (not a batch failure). Filter-based selection already yields canonical index paths (no-op).

- [ ] **Step 1: Write the failing test**

Append to `tests/write-resolution.test.ts`:

```ts
import { bulkEdit } from "../src/tools/bulk.js";

describe("bulk_edit resolves explicit paths", () => {
  let fx: Fixture;
  before(async () => {
    fx = await makeVault([
      { path: "projects/alpha.md", content: "# Alpha" },
      { path: "daily/log.md", content: "# Daily" },
      { path: "projects/log.md", content: "# Project" },
    ]);
  });
  after(() => fx.cleanup());

  test("bare path resolves; ambiguous path isolates to one failed row", async () => {
    const res = await bulkEdit(fx.vaultPath, {
      select: { paths: ["alpha", "log"] },
      operations: [{ op: "add_tag", tags: ["z"] }],
    });
    const alpha = res.results.find((r) => r.path.endsWith("alpha"))!;
    const log = res.results.find((r) => r.path === "log")!;
    assert.equal(alpha.ok, true);
    assert.equal(log.ok, false);
    assert.match((log as any).error, /Ambiguous note name: log/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/write-resolution.test.ts`
Expected: FAIL — `"alpha"` reports not-found (bulk reads the literal path), `"log"` reports not-found rather than ambiguous.

- [ ] **Step 3: Resolve in the per-note loop**

In `src/tools/bulk.ts`, import the helper and the index, then resolve inside the loop's try (so an ambiguous/failed resolution is caught per-note). Update the loop (line 215):

```ts
import { getIndex } from "./vault-index.js";
import { resolveWriteTarget } from "./not-found.js";

// ...before the loop:
const index = await getIndex(vaultPath);

for (const notePath of matched) {
  try {
    const resolved = resolveWriteTarget(index, notePath); // throws on ambiguity
    const raw = await readRaw(vaultPath, resolved);
    const doc = NoteDocument.parse(raw);
    const changed = applyOperations(doc, operations);
    if (changed) await writeResolved(vaultPath, resolved, doc.serialize());
    results.push({ path: resolved, ok: true, changed });
  } catch (error) {
    results.push({
      path: notePath,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
```

(`readRaw` also resolves, but calling `resolveWriteTarget` first turns an ambiguous name into a per-note error and lets the row report the resolved `path`. Building the index once before the loop avoids a per-note rebuild.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/write-resolution.test.ts`
Expected: PASS.

- [ ] **Step 5: Run bulk regressions**

Run: `npx tsx --test tests/bulk-cli.test.ts`
Expected: PASS (filter-based selections and canonical explicit paths unaffected).

- [ ] **Step 6: Commit**

```bash
git add src/tools/bulk.ts tests/write-resolution.test.ts
git commit -m "$(cat <<'EOF'
feat(bulk): resolve explicit paths per-note; isolate ambiguity to one row

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Align `insert_template`'s echoed path

**Files:**
- Modify: `src/tools/templates.ts` (`insertTemplate` return, line 304)
- Test: `tests/write-resolution.test.ts` (append)

**Interfaces:**
- Consumes: the resolved `path` already returned by `appendNote`/`prependNote`/`appendNoteSection` (Task 3).
- Produces: `insert_template` echoes the resolved note path.

- [ ] **Step 1: Write the failing test**

Append to `tests/write-resolution.test.ts`:

```ts
import { insertTemplate } from "../src/tools/templates.js";
import { writeNote } from "../src/tools/write.js";

describe("insert_template echoes the resolved path", () => {
  let fx: Fixture;
  before(async () => {
    fx = await makeVault([{ path: "projects/alpha.md", content: "# Alpha\n" }]);
    // A template folder + template so insert has something to expand.
    await writeNote(fx.vaultPath, {
      path: ".obsidian-templates/T", content: "inserted line",
    });
    process.env.OBSIDIAN_TEMPLATE_FOLDER = ".obsidian-templates";
  });
  after(() => {
    delete process.env.OBSIDIAN_TEMPLATE_FOLDER;
    return fx.cleanup();
  });

  test("append into a bare-named note echoes projects/alpha", async () => {
    const res = await insertTemplate(fx.vaultPath, {
      template: "T", path: "alpha", position: "append",
    });
    assert.equal(res.path, "projects/alpha");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/write-resolution.test.ts`
Expected: FAIL — `res.path` is `"alpha"` (raw input echoed at templates.ts:304).

- [ ] **Step 3: Echo the delegate's resolved path**

In `src/tools/templates.ts`, `insertTemplate` currently discards each delegate's `path`. Capture it. Change each branch to keep the returned path, and return it:

```ts
  let health: LinkHealth;
  let resolvedPath = path.replace(/\.md$/, "");
  if (position === "append") {
    const r = await appendNote(vaultPath, { path, content });
    health = { unresolved_links: r.unresolved_links, broken_anchors: r.broken_anchors };
    resolvedPath = r.path;
  } else if (position === "prepend") {
    const r = await prependNote(vaultPath, { path, content });
    health = { unresolved_links: r.unresolved_links, broken_anchors: r.broken_anchors };
    resolvedPath = r.path;
  } else {
    const r = await appendNoteSection(vaultPath, {
      path, heading: section!, content, create: create_section,
    });
    health = { unresolved_links: r.unresolved_links, broken_anchors: r.broken_anchors };
    resolvedPath = r.path;
  }
  return { path: resolvedPath, position, ...health };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/write-resolution.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/templates.ts tests/write-resolution.test.ts
git commit -m "$(cat <<'EOF'
feat(templates): insert_template echoes the resolved note path

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Update the inverted assertions in `tests/not-found.test.ts`

**Files:**
- Modify: `tests/not-found.test.ts` (write-side block, lines 138–156)

**Interfaces:** none (test-only).

- [ ] **Step 1: Understand what inverts**

The existing test `"write-side sites suggest candidates"` (line 138) asserts that `patch_note`/`append_note`/`prepend_note`/`delete_note`/`move_note` on `path: "alpha"` **reject** with the did-you-mean hint. After this change, `"alpha"` RESOLVES to `projects/alpha`, so those calls SUCCEED — the assertions are now wrong. The `suggestionNotes()` fixture has four `shared` notes, so a bare `"shared"` is the new "still errors" case (ambiguous), and a genuine miss (`"no-such-note"`) still errors bare.

- [ ] **Step 2: Rewrite the write-side test to assert resolution + ambiguity**

Replace the `test("write-side sites suggest candidates", ...)` block (lines 138–156) with:

```ts
  test("write-side sites resolve a bare basename instead of erroring", async () => {
    // "alpha" now resolves to projects/alpha, so these succeed rather than
    // producing the old did-you-mean rejection.
    const r = await patchNote(fx.vaultPath, {
      path: "alpha", find: "Body", replace: "Body!",
    });
    assert.equal(r.path, "projects/alpha");
    assert.equal(r.replacements, 1);
  });

  test("write-side sites fail loud on an ambiguous bare name", async () => {
    // Four notes share the basename "shared".
    await assert.rejects(
      () => deleteNote(fx.vaultPath, "shared"),
      /Ambiguous note name: shared/
    );
    await assert.rejects(
      () => moveNote(fx.vaultPath, { from: "shared", to: "x/shared" }),
      /Ambiguous note name: shared/
    );
  });

  test("write-side sites still error on a genuine miss (with suggestions)", async () => {
    // A title is not a resolvable write address, but still yields did-you-mean.
    await assert.rejects(
      () => deleteNote(fx.vaultPath, "Alpha Project"),
      HINT
    );
  });
```

(The `HINT` regex and imports at the top of the file already cover these tools. `patchNote`'s `find: "Body"` matches the `projects/alpha` fixture body `"Body. See [[index]]."`.)

- [ ] **Step 3: Run the modified file**

Run: `npx tsx --test tests/not-found.test.ts`
Expected: PASS — resolution, ambiguity, and genuine-miss cases all green.

- [ ] **Step 4: Commit**

```bash
git add tests/not-found.test.ts
git commit -m "$(cat <<'EOF'
test(not-found): write-side bare names now resolve; ambiguity/miss still error

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Full suite + build gate

**Files:** none (verification only).

- [ ] **Step 1: Run the entire test suite**

Run: `npm test`
Expected: PASS — all files. If any legacy test relied on a bare/wrong-case write erroring, update it the same way as Task 7 (resolve → succeed, ambiguous → fail loud, genuine miss → error). Investigate each failure against the resolution contract before changing it.

- [ ] **Step 2: Type-check / build**

Run: `npm run build`
Expected: clean compile (no TS errors). In particular the `editNote` return-type change (added `path`) must satisfy every caller.

- [ ] **Step 3: Commit any fixups**

```bash
git add -A
git commit -m "$(cat <<'EOF'
test: fix remaining write-name-resolution regressions across the suite

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

(Skip the commit if Steps 1–2 were already clean.)

---

## Task 9: Documentation — CLAUDE.md + README

**Files:**
- Modify: `CLAUDE.md` (after the "Note addressing (shared)" section)
- Modify: `README.md` (matching location)

**Interfaces:** none.

- [ ] **Step 1: Add the "Note addressing on writes (shared)" convention to CLAUDE.md**

Immediately after the existing **Note addressing (shared)** section, add:

```markdown
**Note addressing on writes (shared).** Every *edit-existing* write tool —
`add_tag`/`remove_tag`, `set_frontmatter`, `add`/`remove_property_values`,
`rename_property`, `patch_note`, `add_section`/`append_to_section`/
`replace_section`, `rename_section`, `set_task_state`, `delete_note`,
`move_note` (its `from` source), `bulk_edit`'s per-note paths,
`append_note`/`prepend_note` *without* `create`, and `insert_template` —
now addresses its target the same way the single-note readers do: a bare
basename (`alpha` → `projects/alpha`) or a wrong-case path (`Projects/Alpha`)
is resolved through the shared index (`VaultIndex.resolveForWrite` via
`resolveWriteTarget` in `src/tools/not-found.ts`) before any filesystem
change. The one write-appropriate divergence from readers: an **ambiguous**
bare name (a basename shared by several notes) **fails loud**, listing the
candidates (`Ambiguous note name: log. Candidates: daily/log, projects/log.
Pass the full path.`), rather than silently picking the shortest-path note as
readers/`get_links` do — a wrong-note *read* wastes a call; a wrong-note
*write* mutates the wrong file. As with readers, a **title or alias** is not a
resolvable write address (that is `resolve_note`'s job), and a slash-qualified
miss (`wrong-folder/alpha`) gets no basename fallback — it stays a not-found
error with did-you-mean candidates. **Create paths stay literal:**
`write_note`, `apply_template`, and the `create:true` branches of
`append_note`/`prepend_note` address the literal path, so a bare name always
creates the note you named and never redirects onto an existing folder note.
This also hardens `move_note`/`rename_section`, whose source resolution
previously picked a shortest-path winner silently. Stated once here; write-tool
descriptions carry no repetition.
```

- [ ] **Step 2: Mirror the change into README.md**

Add the same paragraph (or a README-appropriate condensation) at the matching location in `README.md`, keeping the two docs in sync per the CLAUDE.md docs rule.

- [ ] **Step 3: Verify no stale claims**

Grep both docs for language asserting writes are literal-only, and reconcile:

Run: `grep -n "literal\|raw path\|writes are literal" CLAUDE.md README.md`
Expected: any hit that now contradicts the new convention is updated or removed.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "$(cat <<'EOF'
docs: document write-side name resolution + ambiguity fail-loud convention

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**1. Spec coverage** (each spec section → task):
- Resolution contract (5 cases) → Task 1 (`resolveForWrite`) + Task 2 (`resolveWriteTarget`).
- Fail-loud on ambiguity → Tasks 1, 2 (primitive/helper), asserted in 3, 4, 5, 7.
- Insertion point 1 (`readRaw`/`editNote`) → Task 3.
- Insertion point 2 (direct callers: delete/move/task-state) → Task 4.
- `bulk_edit` → Task 5.
- `insert_template` (inherited resolution, path echo only) → Task 6.
- Create paths stay literal → asserted in Task 3 (append create branch), non-goal upheld throughout.
- Report resolved path in output + messages → Task 3 (editNote returns `path`), 4, 5, 6.
- `move_note`/`rename_section` incidental hardening → Task 4.
- Inverted existing tests → Task 7.
- Testing section (unit + integration + regression + create-guard) → Tasks 1–8.
- Documentation (both docs, addressing convention) → Task 9.
- All covered. No gaps.

**2. Placeholder scan:** One deliberate empty stub test is introduced in Task 4 Step 1 and explicitly deleted in Task 4 Step 7 (and called out in Step 1's trailing note) — it exists only to mark that the case is covered by the isolated fixture; not a lingering placeholder. No "TBD"/"add error handling"/"similar to Task N" left. Every code step shows concrete code.

**3. Type consistency:**
- `WriteResolution` — defined in Task 1 (`src/types.ts`), consumed by `resolveForWrite` (Task 1) and (transitively) the helpers (Task 2). Consistent `kind` values: `"resolved"|"ambiguous"|"unresolved"`.
- `resolveForWrite(target: string): WriteResolution` — same name/signature in Task 1 def and Tasks 2, 4, 5 uses.
- `resolveWriteTarget(index, notePath): string` / `resolveWriteTargetAsync(vaultPath, notePath): Promise<string>` — consistent across Tasks 2–6.
- `editNote` return `{ changed, content, path }` — the added `path` field is defined in Task 3 and consumed by all editNote callers in Task 3; `linkHealthAfterWrite(vaultPath, resolved, written)` signature matches the existing `(vaultPath, notePath, content)`.
- Ambiguity error string is identical everywhere: `Ambiguous note name: <name>. Candidates: <...>. Pass the full path.` (Task 2 throws it; Tasks 3–5, 7 match it).
- No dangling references.

---

## Execution Handoff

Plan complete. See below for the recommended execution path.
