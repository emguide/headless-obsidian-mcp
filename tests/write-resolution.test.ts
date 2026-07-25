import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { makeVault, Fixture } from "./fixtures.js";
import { getIndex } from "../src/tools/vault-index.js";

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
