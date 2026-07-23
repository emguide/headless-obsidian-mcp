import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { renameSectionInVault } from "../src/tools/write.js";
import { makeVault, Fixture } from "./fixtures.js";

const read = (v: string, n: string) => readFile(join(v, n), "utf-8");

let fx: Fixture;
before(async () => {
  fx = await makeVault([
    {
      path: "target.md",
      content: "---\ntitle: Target\n---\n# Target\n\n## Old Heading\n\nbody\n",
    },
    {
      path: "refs.md",
      content:
        "# Refs\n" +
        "Full [[target#Old Heading]], base [[target#old heading|alias]], " +
        "embed ![[target#Old Heading]], block [[target#^blk]], " +
        "other [[target#Other]], note [[target]].\n",
    },
    { path: "folder/deep.md", content: "# Deep\nLink [[target#Old Heading]].\n" },
  ]);
});
after(() => fx.cleanup());

test("renameSectionInVault renames heading and rewrites inbound anchors", async () => {
  const r = await renameSectionInVault(fx.vaultPath, {
    path: "target",
    from: "Old Heading",
    to: "New Heading",
  });
  assert.equal(r.from, "Old Heading");
  assert.equal(r.to, "New Heading");
  assert.equal(r.updated_notes, 2); // refs.md + folder/deep.md

  const target = await read(fx.vaultPath, "target.md");
  assert.match(target, /## New Heading/);
  assert.doesNotMatch(target, /Old Heading/);

  const refs = await read(fx.vaultPath, "refs.md");
  assert.match(refs, /\[\[target#New Heading\]\]/);                 // full-path, case match
  assert.match(refs, /\[\[target#New Heading\|alias\]\]/);          // case-insensitive + alias kept
  assert.match(refs, /!\[\[target#New Heading\]\]/);                // embed preserved
  assert.match(refs, /\[\[target#\^blk\]\]/);                       // block ref untouched
  assert.match(refs, /\[\[target#Other\]\]/);                       // non-matching anchor untouched
  assert.match(refs, /\[\[target\]\]/);                             // anchorless link untouched

  const deep = await read(fx.vaultPath, "folder/deep.md");
  assert.match(deep, /\[\[target#New Heading\]\]/);
});

test("renameSectionInVault with update_anchors:false leaves inbound anchors alone", async () => {
  const fx2 = await makeVault([
    { path: "t.md", content: "# T\n\n## H\n\nx\n" },
    { path: "r.md", content: "# R\n[[t#H]]\n" },
  ]);
  const r = await renameSectionInVault(fx2.vaultPath, {
    path: "t",
    from: "H",
    to: "H2",
    update_anchors: false,
  });
  assert.equal(r.updated_notes, 0);
  assert.match(await read(fx2.vaultPath, "t.md"), /## H2/);
  assert.match(await read(fx2.vaultPath, "r.md"), /\[\[t#H\]\]/); // stale, but untouched
  await fx2.cleanup();
});

test("renameSectionInVault fails loud on ambiguous heading", async () => {
  const fx3 = await makeVault([{ path: "a.md", content: "# A\n\n## Log\n\n## Log\n\n" }]);
  await assert.rejects(
    renameSectionInVault(fx3.vaultPath, { path: "a", from: "Log", to: "X" }),
    /Ambiguous section/
  );
  await fx3.cleanup();
});

test("renameSectionInVault rewrites the renamed note's own self-reference anchors", async () => {
  const fx4 = await makeVault([
    {
      path: "thenote.md",
      content:
        "# Thenote\n\n" +
        "## Old Heading\n\n" +
        "See also [[thenote#Old Heading]] and [[#Old Heading]].\n\n" +
        "## Other Heading\n\n" +
        "Unrelated [[thenote#Other Heading]] and [[#Other Heading]] stay put.\n",
    },
  ]);

  const r = await renameSectionInVault(fx4.vaultPath, {
    path: "thenote",
    from: "Old Heading",
    to: "New Heading",
  });

  const note = await read(fx4.vaultPath, "thenote.md");
  assert.match(note, /## New Heading/);
  assert.match(note, /\[\[thenote#New Heading\]\]/);
  assert.match(note, /\[\[#New Heading\]\]/);
  assert.doesNotMatch(note, /Old Heading/);

  // The differently-headed self-references are untouched.
  assert.match(note, /\[\[thenote#Other Heading\]\]/);
  assert.match(note, /\[\[#Other Heading\]\]/);

  // No other notes were touched, but the two self-anchors count as updated_links.
  assert.equal(r.updated_notes, 0);
  assert.equal(r.updated_links, 2);

  await fx4.cleanup();
});

test("renameSectionInVault with update_anchors:false leaves the note's own self-references alone too", async () => {
  const fx5 = await makeVault([
    {
      path: "thenote.md",
      content:
        "# Thenote\n\n" +
        "## Old Heading\n\n" +
        "See also [[thenote#Old Heading]] and [[#Old Heading]].\n",
    },
  ]);

  const r = await renameSectionInVault(fx5.vaultPath, {
    path: "thenote",
    from: "Old Heading",
    to: "New Heading",
    update_anchors: false,
  });

  const note = await read(fx5.vaultPath, "thenote.md");
  assert.match(note, /## New Heading/); // heading itself still renamed
  assert.match(note, /\[\[thenote#Old Heading\]\]/); // self-ref left stale, untouched
  assert.match(note, /\[\[#Old Heading\]\]/); // bare self-link left stale, untouched
  assert.equal(r.updated_links, 0);
  assert.equal(r.updated_notes, 0);

  await fx5.cleanup();
});
