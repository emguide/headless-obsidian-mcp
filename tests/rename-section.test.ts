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
