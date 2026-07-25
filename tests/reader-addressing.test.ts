import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { getFrontmatter } from "../src/tools/frontmatter.js";
import { readSection } from "../src/tools/section.js";
import { readNotes } from "../src/tools/read.js";
import { getProperty } from "../src/tools/properties.js";
import { makeVault, Fixture } from "./fixtures.js";

/**
 * The single-note readers used to split into two addressing camps: some
 * resolved a human-facing name through the index (case-insensitive, basename
 * fallback), while get_frontmatter/read_section/read_notes required the literal
 * on-disk path. This unifies them on lenient index resolution so a bare
 * basename or a wrong-case name addresses the same note through every reader.
 */

let fx: Fixture;
before(async () => {
  fx = await makeVault([
    {
      path: "projects/alpha.md",
      content: "---\ntitle: Alpha\nstatus: active\n---\n# Alpha\n## Log\nentry one\n",
    },
  ]);
});
after(() => fx.cleanup());

test("get_frontmatter resolves a bare basename like get_property does", async () => {
  const viaBasename = await getFrontmatter(fx.vaultPath, "alpha");
  assert.equal(viaBasename.path, "projects/alpha");
  assert.equal(viaBasename.frontmatter.status, "active");
});

test("get_frontmatter resolves a wrong-case path", async () => {
  const viaCase = await getFrontmatter(fx.vaultPath, "Projects/Alpha");
  assert.equal(viaCase.path, "projects/alpha");
});

test("read_section resolves a bare basename", async () => {
  const section = await readSection(fx.vaultPath, { path: "alpha", section: "Log" });
  assert.equal(section.path, "projects/alpha");
  assert.match(section.content, /entry one/);
});

test("read_notes resolves a bare basename to the real note", async () => {
  const { notes, errors } = await readNotes(fx.vaultPath, ["alpha"]);
  assert.equal(errors.length, 0);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].path, "projects/alpha");
  assert.equal(notes[0].frontmatter.status, "active");
});

test("the two camps now agree: get_frontmatter matches get_property's resolution", async () => {
  const fm = await getFrontmatter(fx.vaultPath, "alpha");
  const prop = await getProperty(fx.vaultPath, { path: "alpha", key: "status" });
  assert.equal(fm.path, prop.path); // same canonical note, addressed by the same bare name
});

test("a wrong-folder miss still errors with a did-you-mean suggestion", async () => {
  // The name resolves to no real note (slash-qualified, no such path — and, post
  // Issue-2-fix, no basename fallback), so it is a genuine miss; the shared
  // not-found builder still points at the basename match projects/alpha.
  await assert.rejects(
    () => getFrontmatter(fx.vaultPath, "wrong-folder/alpha"),
    /Did you mean: projects\/alpha/
  );
  const { errors } = await readNotes(fx.vaultPath, ["wrong-folder/alpha"]);
  assert.equal(errors.length, 1);
  assert.match(errors[0].error, /Did you mean: projects\/alpha/);
});

test("a pure spelling typo with no exact-match identity gets the bare not-found message", async () => {
  // Documented behavior: did-you-mean is exact-match only, never fuzzy. "alfa"
  // is not a case-insensitive equal of "alpha", so no suggestion is offered.
  await assert.rejects(
    () => getFrontmatter(fx.vaultPath, "projects/alfa"),
    (e: Error) => /Note not found/.test(e.message) && !/Did you mean/.test(e.message)
  );
});
