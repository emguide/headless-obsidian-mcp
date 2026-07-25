import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { makeVault, Fixture } from "./fixtures.js";
import { getIndex } from "../src/tools/vault-index.js";
import {
  resolveWriteTarget,
  resolveWriteTargetAsync,
} from "../src/tools/not-found.js";
import {
  addTag,
  patchNote,
  setNoteFrontmatter,
  appendNote,
  prependNote,
  writeNote,
  deleteNote,
  moveNote,
  setTaskState,
  renameSectionInVault,
} from "../src/tools/write.js";
import { getFrontmatter } from "../src/tools/frontmatter.js";
import { readRaw } from "../src/tools/write.js";
import { bulkEdit } from "../src/tools/bulk.js";

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

  test("a genuinely missing name with no create still errors on patch/append/prepend", async () => {
    // "nope" matches no note anywhere in the fixture (no slash, no basename
    // match), so it stays unresolved and falls through to the literal
    // not-found path — must ERROR, never silently redirect to some other note.
    await assert.rejects(
      () => patchNote(fx.vaultPath, { path: "nope", find: "x", replace: "y" }),
      /Note not found/
    );
    await assert.rejects(
      () => appendNote(fx.vaultPath, { path: "nope", content: "x" }),
      /Note not found/
    );
    await assert.rejects(
      () => prependNote(fx.vaultPath, { path: "nope", content: "x" }),
      /Note not found/
    );
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
    const alpha = res.results!.find((r) => r.path.endsWith("alpha"))!;
    const log = res.results!.find((r) => r.path === "log")!;
    assert.equal(alpha.ok, true);
    assert.equal(log.ok, false);
    assert.match((log as any).error, /Ambiguous note name: log/);
  });
});
