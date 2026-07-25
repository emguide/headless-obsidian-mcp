import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readNotes } from "../src/tools/read.js";
import { makeVault, sampleNotes, Fixture } from "./fixtures.js";

let fx: Fixture;
before(async () => {
  fx = await makeVault(sampleNotes());
});
after(() => fx.cleanup());

test("returns valid notes and collects missing ones in errors", async () => {
  const res = await readNotes(fx.vaultPath, ["index", "does-not-exist", "projects/alpha"]);
  assert.deepEqual(res.notes.map((n) => n.path).sort(), ["index", "projects/alpha"]);
  assert.equal(res.errors.length, 1);
  assert.equal(res.errors[0].path, "does-not-exist");
  assert.match(res.errors[0].error, /not found or not readable/);
});

test("all-valid batch yields an empty errors array", async () => {
  const res = await readNotes(fx.vaultPath, ["index"]);
  assert.equal(res.errors.length, 0);
  assert.equal(res.notes.length, 1);
});

test("path traversal still throws and aborts the whole batch", async () => {
  await assert.rejects(
    () => readNotes(fx.vaultPath, ["index", "../../etc/passwd"]),
    /path traversal/
  );
});

test("a note whose name contains '..' is not mistaken for path traversal", async () => {
  // An ellipsis title ("And then....md") contains "..", but not "../" — it is a
  // legitimate note, not a traversal attempt. The hand-rolled guard used to
  // reject it and (since traversal fails the whole batch) poison the rest.
  const dots = await makeVault([
    { path: "And then....md", content: "# And then...\nbody\n" },
    { path: "projects/alpha.md", content: "# Alpha\nbody\n" },
  ]);
  try {
    const res = await readNotes(dots.vaultPath, ["And then...", "projects/alpha"]);
    assert.equal(res.errors.length, 0, "no path should error");
    assert.deepEqual(
      res.notes.map((n) => n.path).sort(),
      ["And then...", "projects/alpha"]
    );
  } finally {
    await dots.cleanup();
  }
});

test("body is returned verbatim, preserving leading and trailing whitespace", async () => {
  // CLAUDE.md promises "Markdown body verbatim ... returned unmodified", and the
  // body-relative line convention (get_outline/list_tasks/search_notes) depends
  // on it: trimming a leading blank line shifts every body line number.
  const raw = await makeVault([
    {
      path: "spaced.md",
      content: "---\ntitle: Spaced\n---\n\n\n# Heading on body line 3\n\nlast\n\n",
    },
  ]);
  try {
    const [note] = (await readNotes(raw.vaultPath, ["spaced"])).notes;
    // gray-matter keeps the two blank lines after the closing fence; read_notes
    // must not strip them, so "# Heading" stays on body line 3 (1-based).
    assert.equal(note.contents, "\n\n# Heading on body line 3\n\nlast\n\n");
    const headingLine = note.contents.split("\n").indexOf("# Heading on body line 3") + 1;
    assert.equal(headingLine, 3, "heading stays on its body-relative line");
  } finally {
    await raw.cleanup();
  }
});
