import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { listTags, findByTag } from "../src/tools/tags.js";
import { makeVault, sampleNotes, Fixture } from "./fixtures.js";

let fx: Fixture;
before(async () => {
  fx = await makeVault(sampleNotes());
});
after(() => fx.cleanup());

test("aggregates counts and unifies frontmatter + inline tags", async () => {
  const tags = await listTags(fx.vaultPath);
  const map = Object.fromEntries(tags.map((t) => [t.tag, t.count]));
  assert.equal(map["productivity"], 2); // inline in alpha and Beta Note
  assert.equal(map["home"], 1); // frontmatter-only tag
  assert.equal(map["project/active"], 1); // nested frontmatter tag
});

test("sorts by count descending", async () => {
  const tags = await listTags(fx.vaultPath);
  assert.equal(tags[0].tag, "productivity");
  assert.equal(tags[0].count, 2);
});

test("find_by_tag any returns every note with the tag", async () => {
  const notes = await findByTag(fx.vaultPath, { tags: ["productivity"] });
  assert.deepEqual(
    notes.map((n) => n.path).sort(),
    ["Beta Note", "projects/alpha"]
  );
});

test("find_by_tag all requires every tag", async () => {
  const notes = await findByTag(fx.vaultPath, {
    tags: ["productivity", "project"],
    match: "all",
  });
  assert.deepEqual(
    notes.map((n) => n.path),
    ["projects/alpha"]
  );
});

test("find_by_tag ignores a leading # and is case-insensitive", async () => {
  const notes = await findByTag(fx.vaultPath, { tags: ["#PRODUCTIVITY"] });
  assert.equal(notes.length, 2);
});

test("find_by_tag matches nested tags", async () => {
  const notes = await findByTag(fx.vaultPath, { tags: ["project/active"] });
  assert.deepEqual(
    notes.map((n) => n.path),
    ["projects/alpha"]
  );
});

test("find_by_tag rejects an empty tag list", async () => {
  await assert.rejects(
    () => findByTag(fx.vaultPath, { tags: [] }),
    /non-empty array/
  );
});
