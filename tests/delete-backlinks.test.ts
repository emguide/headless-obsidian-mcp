import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { deleteNote } from "../src/tools/write.js";
import { makeVault, sampleNotes, Fixture } from "./fixtures.js";

let fx: Fixture;
before(async () => {
  fx = await makeVault(sampleNotes());
});
after(() => fx.cleanup());

test("delete_note reports the notes whose links it dangled", async () => {
  // projects/alpha is linked from index, Beta Note, and daily/2026-07-22.
  const res = await deleteNote(fx.vaultPath, "projects/alpha");
  assert.deepEqual(res.dangled_backlinks.sort(), ["Beta Note", "daily/2026-07-22", "index"]);
  assert.equal(res.deleted, true);
  assert.equal(res.trashed, true);
});

test("delete_note returns an empty array when nothing linked to the note", async () => {
  const res = await deleteNote(fx.vaultPath, "daily/2026-07-22", { permanent: true });
  assert.deepEqual(res.dangled_backlinks, []);
  assert.equal(res.trashed, false);
});
