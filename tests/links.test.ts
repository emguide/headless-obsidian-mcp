import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { getLinks } from "../src/tools/links.js";
import { makeVault, sampleNotes, Fixture } from "./fixtures.js";

let fx: Fixture;
before(async () => {
  fx = await makeVault(sampleNotes());
});
after(() => fx.cleanup());

test("resolves outbound links via full path and via alias", async () => {
  const res = await getLinks(fx.vaultPath, "index");
  const targets = res.outbound_links.map((l) => l.path).sort();
  assert.deepEqual(targets, ["Beta Note", "projects/alpha"]);
});

test("flags wikilinks that resolve to no note", async () => {
  const res = await getLinks(fx.vaultPath, "index");
  assert.deepEqual(res.unresolved_links, ["missing-note"]);
});

test("computes backlinks across the vault", async () => {
  const res = await getLinks(fx.vaultPath, "projects/alpha");
  assert.deepEqual(res.backlinks, ["Beta Note", "daily/2026-07-22", "index"]);
});

test("accepts a basename and resolves it to the canonical path", async () => {
  const res = await getLinks(fx.vaultPath, "alpha");
  assert.equal(res.note, "projects/alpha");
});

test("accepts the .md extension", async () => {
  const res = await getLinks(fx.vaultPath, "index.md");
  assert.equal(res.note, "index");
});

test("throws for a note that does not exist", async () => {
  await assert.rejects(
    () => getLinks(fx.vaultPath, "does/not/exist"),
    /not found or not readable/
  );
});
