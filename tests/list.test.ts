import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { listNotes } from "../src/tools/list.js";
import { makeVault, sampleNotes, Fixture } from "./fixtures.js";

let fx: Fixture;
before(async () => {
  fx = await makeVault(sampleNotes());
});
after(() => fx.cleanup());

test("lists every note, sorted by path", async () => {
  const notes = await listNotes(fx.vaultPath);
  assert.deepEqual(
    notes.map((n) => n.path),
    ["Beta Note", "daily/2026-07-22", "index", "projects/alpha"]
  );
});

test("uses frontmatter title, falling back to basename", async () => {
  const notes = await listNotes(fx.vaultPath);
  const byPath = Object.fromEntries(notes.map((n) => [n.path, n]));
  assert.equal(byPath["index"].title, "Home"); // frontmatter title
  assert.equal(byPath["Beta Note"].title, "Beta Note"); // basename fallback
});

test("extracts the first heading as headline", async () => {
  const notes = await listNotes(fx.vaultPath);
  const alpha = notes.find((n) => n.path === "projects/alpha");
  assert.equal(alpha?.headline, "Alpha");
});

test("filters by folder without matching sibling prefixes", async () => {
  const notes = await listNotes(fx.vaultPath, { folder: "projects" });
  assert.deepEqual(
    notes.map((n) => n.path),
    ["projects/alpha"]
  );
});

test("respects limit", async () => {
  const notes = await listNotes(fx.vaultPath, { limit: 2 });
  assert.equal(notes.length, 2);
});

test("rejects a non-positive limit", async () => {
  await assert.rejects(
    () => listNotes(fx.vaultPath, { limit: 0 }),
    /positive integer/
  );
});
