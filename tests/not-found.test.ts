import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { makeVault, Fixture } from "./fixtures.js";
import { getIndex } from "../src/tools/vault-index.js";
import {
  didYouMean,
  noteNotFoundMessage,
  noteNotFoundError,
} from "../src/tools/not-found.js";
import {
  appendNote,
  prependNote,
  deleteNote,
  moveNote,
  patchNote,
} from "../src/tools/write.js";
import { getFrontmatter } from "../src/tools/frontmatter.js";
import { getProperty } from "../src/tools/properties.js";
import { getOutline } from "../src/tools/outline.js";
import { getLinks } from "../src/tools/links.js";
import { readSection } from "../src/tools/section.js";
import { getRelatedNotes } from "../src/tools/related.js";
import { readNotes } from "../src/tools/read.js";

/**
 * Vault for suggestion tests: one richly-named note (title + alias), a set of
 * four notes sharing a basename (cap test), and a plain note for write tests.
 */
function suggestionNotes() {
  return [
    {
      path: "projects/alpha.md",
      content: [
        "---",
        "title: Alpha Project",
        "aliases:",
        "  - Alpha One",
        "status: active",
        "---",
        "# Alpha",
        "Body. See [[index]].",
      ].join("\n"),
    },
    { path: "index.md", content: "# Home\n[[projects/alpha]]" },
    { path: "a/shared.md", content: "# S1" },
    { path: "b/shared.md", content: "# S2" },
    { path: "c/shared.md", content: "# S3" },
    { path: "d/shared.md", content: "# S4" },
  ];
}

describe("didYouMean / noteNotFoundMessage", () => {
  let fx: Fixture;
  before(async () => {
    fx = await makeVault(suggestionNotes());
  });
  after(() => fx.cleanup());

  test("missing folder prefix suggests the real path", async () => {
    const index = await getIndex(fx.vaultPath);
    assert.deepEqual(didYouMean(index, "alpha"), ["projects/alpha"]);
  });

  test("wrong folder and wrong case still resolve via basename", async () => {
    const index = await getIndex(fx.vaultPath);
    assert.deepEqual(didYouMean(index, "Projects/Alpha"), ["projects/alpha"]);
    assert.deepEqual(didYouMean(index, "archive/alpha"), ["projects/alpha"]);
  });

  test("title and alias match exactly (resolve_note semantics)", async () => {
    const index = await getIndex(fx.vaultPath);
    assert.deepEqual(didYouMean(index, "Alpha Project"), ["projects/alpha"]);
    assert.deepEqual(didYouMean(index, "alpha one"), ["projects/alpha"]);
  });

  test(".md suffix on the failed path is ignored", async () => {
    const index = await getIndex(fx.vaultPath);
    assert.deepEqual(didYouMean(index, "alpha.md"), ["projects/alpha"]);
  });

  test("no exact match yields no candidates and a bare message", async () => {
    const index = await getIndex(fx.vaultPath);
    assert.deepEqual(didYouMean(index, "totally-unknown"), []);
    assert.equal(
      noteNotFoundMessage(index, "totally-unknown"),
      "Note not found: totally-unknown"
    );
  });

  test("candidates are capped at 3", async () => {
    const index = await getIndex(fx.vaultPath);
    const got = didYouMean(index, "wrong/shared");
    assert.equal(got.length, 3);
    assert.deepEqual(got, ["a/shared", "b/shared", "c/shared"]);
  });

  test("the failed path itself is never suggested", async () => {
    const index = await getIndex(fx.vaultPath);
    // Input equals the canonical path of a real note: suggesting it back
    // ("Did you mean: projects/alpha?") would be nonsense.
    assert.deepEqual(didYouMean(index, "projects/alpha"), []);
  });

  test("message format matches the spec, with a custom base preserved", async () => {
    const index = await getIndex(fx.vaultPath);
    assert.equal(
      noteNotFoundMessage(index, "alpha"),
      "Note not found: alpha. Did you mean: projects/alpha?"
    );
    assert.equal(
      noteNotFoundMessage(index, "alpha.md", "Note not found or not readable"),
      "Note not found or not readable: alpha. Did you mean: projects/alpha?"
    );
    assert.equal(
      noteNotFoundMessage(index, "wrong\\shared"),
      "Note not found: wrong/shared. Did you mean: a/shared, b/shared, c/shared?"
    );
  });

  test("noteNotFoundError degrades to the bare message when the index fails", async () => {
    const err = await noteNotFoundError(
      "/nonexistent-vault-for-not-found-test",
      "ghost"
    );
    assert.equal(err.message, "Note not found: ghost");
  });
});

describe("enriched not-found errors across tools", () => {
  let fx: Fixture;
  before(async () => {
    fx = await makeVault(suggestionNotes());
  });
  after(() => fx.cleanup());

  const HINT = /Did you mean: projects\/alpha\?/;

  test("write-side sites suggest candidates", async () => {
    // patchNote/appendNote/prependNote now resolve a bare basename like "alpha"
    // to "projects/alpha" (writer-name-resolution) instead of erroring, so this
    // uses a slash-qualified miss ("archive/alpha") to still exercise the
    // not-found+hint path: a slash-qualified name gets no basename fallback in
    // resolveForWrite (see not-found.ts / vault-index.ts), so it stays
    // genuinely unresolved and still throws with a suggestion.
    await assert.rejects(
      () => patchNote(fx.vaultPath, { path: "archive/alpha", find: "x", replace: "y" }),
      HINT
    );
    await assert.rejects(
      () => appendNote(fx.vaultPath, { path: "archive/alpha", content: "x" }),
      HINT
    );
    await assert.rejects(
      () => prependNote(fx.vaultPath, { path: "archive/alpha", content: "x" }),
      HINT
    );
    // deleteNote/moveNote (source) now ALSO resolve a bare/wrong-case name
    // (writer-name-resolution task 4), so — like the patch/append/prepend
    // calls above — a slash-qualified miss is used here to still exercise the
    // not-found+hint path without actually deleting/moving the shared
    // "projects/alpha" fixture note that later tests in this describe block
    // depend on.
    await assert.rejects(() => deleteNote(fx.vaultPath, "archive/alpha"), HINT);
    await assert.rejects(
      () => moveNote(fx.vaultPath, { from: "archive/alpha", to: "elsewhere/alpha" }),
      HINT
    );
  });

  test("index-backed read sites suggest candidates", async () => {
    await assert.rejects(() => getProperty(fx.vaultPath, { path: "Alpha Project", key: "status" }), HINT);
    await assert.rejects(() => getOutline(fx.vaultPath, "Alpha Project"), HINT);
    await assert.rejects(() => getLinks(fx.vaultPath, "Alpha Project"), HINT);
    await assert.rejects(
      () => getRelatedNotes(fx.vaultPath, { path: "Alpha Project" }),
      HINT
    );
  });

  test("file-reading read sites suggest candidates", async () => {
    // These readers now resolve a bare basename ("alpha" -> projects/alpha) just
    // like the index-backed ones, so a genuine miss here must NOT be a valid
    // note name. A title ("Alpha Project") does not resolve as a path (only
    // resolve_note matches titles), yet still produces the did-you-mean hint.
    await assert.rejects(() => getFrontmatter(fx.vaultPath, "Alpha Project"), HINT);
    await assert.rejects(
      () => readSection(fx.vaultPath, { path: "Alpha Project", section: "Alpha" }),
      HINT
    );
  });

  test("read_notes enriches per-path errors without failing the batch", async () => {
    // "Alpha Project" is a title, not a path/basename, so it does not resolve —
    // it lands in errors (with a hint); "projects/alpha" reads normally.
    const res = await readNotes(fx.vaultPath, ["Alpha Project", "projects/alpha"]);
    assert.equal(res.notes.length, 1);
    assert.equal(res.notes[0].path, "projects/alpha");
    assert.equal(res.errors.length, 1);
    assert.match(res.errors[0].error, HINT);
  });

  test("a genuinely unknown name still errors bare", async () => {
    await assert.rejects(
      () => deleteNote(fx.vaultPath, "no-such-note"),
      (err: Error) => {
        assert.equal(err.message, "Note not found: no-such-note");
        return true;
      }
    );
  });
});
