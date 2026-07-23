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
