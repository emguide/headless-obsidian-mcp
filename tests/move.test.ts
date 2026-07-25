import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { moveNote, moveFile, deleteNote, writeNote } from "../src/tools/write.js";
import { getLinks } from "../src/tools/links.js";
import { makeVault, Fixture } from "./fixtures.js";

const read = (vault: string, name: string) => readFile(join(vault, name), "utf-8");
const exists = (vault: string, name: string) =>
  stat(join(vault, name)).then(() => true, () => false);

/* --------------------------------------------------------------- move_note -- */

let fx: Fixture;
before(async () => {
  fx = await makeVault([
    {
      path: "index.md",
      content:
        "---\ntitle: Home\n---\n# Home\n" +
        "See [[projects/alpha]], [[alpha]], and [[projects/alpha|the project]].\n",
    },
    { path: "projects/alpha.md", content: "---\ntitle: Alpha\n---\n# Alpha\nBack to [[index]].\n" },
    { path: "assets/pic.png", content: "binary-ish" },
  ]);
});
after(() => fx.cleanup());

test("moveNote renames the file and rewrites every backlink form", async () => {
  const result = await moveNote(fx.vaultPath, { from: "projects/alpha", to: "projects/beta" });
  assert.equal(result.from, "projects/alpha");
  assert.equal(result.to, "projects/beta");
  assert.equal(result.overwritten, false);
  assert.equal(result.updated_notes, 1);
  assert.equal(result.updated_links, 3);

  assert.equal(await exists(fx.vaultPath, "projects/alpha.md"), false);
  assert.equal(await exists(fx.vaultPath, "projects/beta.md"), true);

  const index = await read(fx.vaultPath, "index.md");
  // Full-path link, basename link, and aliased link are all rewritten; alias kept.
  assert.match(index, /\[\[projects\/beta\]\]/);
  assert.match(index, /\[\[beta\]\]/);
  assert.match(index, /\[\[projects\/beta\|the project\]\]/);
  assert.doesNotMatch(index, /alpha/);
});

test("moveNote refuses to clobber an existing destination without overwrite", async () => {
  const local = await makeVault([
    { path: "a.md", content: "# A\n" },
    { path: "b.md", content: "# B\n" },
  ]);
  await assert.rejects(() => moveNote(local.vaultPath, { from: "a", to: "b" }), /already exists/);
  const forced = await moveNote(local.vaultPath, { from: "a", to: "b", overwrite: true });
  assert.equal(forced.overwritten, true);
  assert.equal(await read(local.vaultPath, "b.md"), "# A\n");
  await local.cleanup();
});

test("moveNote errors on a missing source and on a no-op move", async () => {
  const local = await makeVault([{ path: "x.md", content: "# X\n" }]);
  await assert.rejects(() => moveNote(local.vaultPath, { from: "ghost", to: "y" }), /not found/);
  await assert.rejects(() => moveNote(local.vaultPath, { from: "x", to: "x" }), /same note/);
  await local.cleanup();
});

test("a slash-qualified target with no matching note is unresolved, not a hidden backlink", async () => {
  // Root cause of the move_note desync the reviewer found: the index used to
  // apply its basename fallback even to slash-qualified targets, so
  // [[wrong-folder/alpha]] silently resolved to projects/alpha. That both hid a
  // genuinely broken link from unresolved_links AND made it a phantom backlink
  // of projects/alpha that move_note refused to rewrite (its predicate only
  // touches slash-less basename links) — so a move "broke" a link it claimed to
  // protect. With the fallback gone, the link is honestly unresolved from the
  // start; a move of projects/alpha never counted it as a backlink at all.
  const local = await makeVault([
    { path: "home.md", content: "# Home\nSee [[wrong-folder/alpha]].\n" },
    { path: "projects/alpha.md", content: "# Alpha\n" },
  ]);

  const before = await getLinks(local.vaultPath, "home");
  assert.deepEqual(before.unresolved_links, ["wrong-folder/alpha"]);
  assert.deepEqual(before.outbound_links, []);

  const result = await moveNote(local.vaultPath, {
    from: "projects/alpha",
    to: "archive/alpha2",
  });
  // The bogus link was never a real backlink of projects/alpha — nothing to rewrite.
  assert.equal(result.updated_notes, 0);
  // The move leaves the pre-existing broken link exactly as it was.
  assert.match(await read(local.vaultPath, "home.md"), /\[\[wrong-folder\/alpha\]\]/);
  assert.equal(await exists(local.vaultPath, "archive/alpha2.md"), true);
  await local.cleanup();
});

test("moveNote resolves a wrong-cased `from` before rewriting backlinks", async () => {
  // Regression: move_note looked up backlinks with the raw canonicalName(from)
  // string instead of resolving it through the index first. On a case-
  // insensitive filesystem, move_note({from:"projects/alpha"}) against a
  // Projects/Alpha.md file renamed the file fine but rewrote ZERO backlinks —
  // the backlink map is keyed by the note's real on-disk path (Projects/Alpha),
  // so the exact, case-sensitive Map.get missed it (updated_notes:0, as if there
  // were no backlinks). Its sibling rename_section resolved first; move_note now
  // does too.
  const local = await makeVault([
    { path: "Projects/Alpha.md", content: "# Alpha\n" },
    { path: "home.md", content: "# Home\n[[Alpha]] and [[Projects/Alpha]]\n" },
  ]);

  // The index-level facts the fix hinges on, asserted on every filesystem: the
  // raw wrong-cased canon misses the backlink map key; resolving first hits it.
  const { getIndex } = await import("../src/tools/vault-index.js");
  const index = await getIndex(local.vaultPath);
  assert.deepEqual(index.backlinks("projects/alpha"), []);
  assert.equal(index.resolve("projects/alpha"), "Projects/Alpha");
  assert.deepEqual(index.backlinks("Projects/Alpha"), ["home"]);

  // On a case-insensitive filesystem the wrong-cased path still opens the real
  // file, so the whole move runs and both backlink forms must be rewritten. On
  // a case-sensitive filesystem the file cannot be opened by that path, so the
  // end-to-end move legitimately can't run — skip only that half there.
  const caseInsensitive = await exists(local.vaultPath, "projects/alpha.md");
  if (caseInsensitive) {
    const result = await moveNote(local.vaultPath, {
      from: "projects/alpha",
      to: "Projects/Gamma",
    });
    assert.equal(result.updated_notes, 1);
    assert.equal(result.updated_links, 2);
    const home = await read(local.vaultPath, "home.md");
    assert.match(home, /\[\[Gamma\]\]/);
    assert.match(home, /\[\[Projects\/Gamma\]\]/);
    assert.doesNotMatch(home, /Alpha/);
  }
  await local.cleanup();
});

test("moveNote with update_links:false leaves backlinks untouched", async () => {
  const local = await makeVault([
    { path: "home.md", content: "# Home\n[[target]]\n" },
    { path: "target.md", content: "# Target\n" },
  ]);
  const result = await moveNote(local.vaultPath, {
    from: "target",
    to: "renamed",
    update_links: false,
  });
  assert.equal(result.updated_links, 0);
  assert.equal(result.updated_notes, 0);
  assert.match(await read(local.vaultPath, "home.md"), /\[\[target\]\]/);
  assert.equal(await exists(local.vaultPath, "renamed.md"), true);
  await local.cleanup();
});

/* --------------------------------------------------------------- move_file -- */

test("moveFile moves an arbitrary file without touching links", async () => {
  const result = await moveFile(fx.vaultPath, { from: "assets/pic.png", to: "assets/image.png" });
  assert.deepEqual(result, { from: "assets/pic.png", to: "assets/image.png", overwritten: false });
  assert.equal(await exists(fx.vaultPath, "assets/pic.png"), false);
  assert.equal(await exists(fx.vaultPath, "assets/image.png"), true);
});

test("moveFile errors on missing source and refuses to clobber", async () => {
  const local = await makeVault([
    { path: "one.txt", content: "1" },
    { path: "two.txt", content: "2" },
  ]);
  await assert.rejects(() => moveFile(local.vaultPath, { from: "nope.txt", to: "x.txt" }), /not found/);
  await assert.rejects(
    () => moveFile(local.vaultPath, { from: "one.txt", to: "two.txt" }),
    /already exists/
  );
  await local.cleanup();
});

test("moveFile rejects path traversal on either end", async () => {
  const local = await makeVault([{ path: "f.txt", content: "x" }]);
  await assert.rejects(
    () => moveFile(local.vaultPath, { from: "../escape.txt", to: "f.txt" }),
    /path traversal/
  );
  await assert.rejects(
    () => moveFile(local.vaultPath, { from: "f.txt", to: "../escape.txt" }),
    /path traversal/
  );
  await local.cleanup();
});

/* ------------------------------------------------------- trash-safe delete -- */

test("deleteNote moves the note to .trash by default", async () => {
  const local = await makeVault([{ path: "doomed.md", content: "# Doomed\n" }]);
  const result = await deleteNote(local.vaultPath, "doomed");
  assert.equal(result.deleted, true);
  assert.equal(result.trashed, true);
  assert.equal(result.trash_path, ".trash/doomed.md");
  assert.equal(await exists(local.vaultPath, "doomed.md"), false);
  assert.equal(await read(local.vaultPath, ".trash/doomed.md"), "# Doomed\n");
  await local.cleanup();
});

test("deleteNote disambiguates repeated trashings with a numeric suffix", async () => {
  const local = await makeVault([{ path: "dup.md", content: "first\n" }]);
  await deleteNote(local.vaultPath, "dup");
  await writeNote(local.vaultPath, { path: "dup", content: "second\n" });
  const second = await deleteNote(local.vaultPath, "dup");
  assert.equal(second.trash_path, ".trash/dup-1.md");
  assert.equal(await read(local.vaultPath, ".trash/dup.md"), "first\n");
  assert.equal(await read(local.vaultPath, ".trash/dup-1.md"), "second\n");
  await local.cleanup();
});

test("deleteNote with permanent:true unlinks and does not populate .trash", async () => {
  const local = await makeVault([{ path: "gone.md", content: "x\n" }]);
  const result = await deleteNote(local.vaultPath, "gone", { permanent: true });
  assert.equal(result.trashed, false);
  assert.equal(await exists(local.vaultPath, "gone.md"), false);
  assert.equal(await exists(local.vaultPath, ".trash/gone.md"), false);
  await local.cleanup();
});

test("deleteNote still errors when the note does not exist", async () => {
  const local = await makeVault([{ path: "real.md", content: "x\n" }]);
  await assert.rejects(() => deleteNote(local.vaultPath, "imaginary"), /not found/);
  await local.cleanup();
});
