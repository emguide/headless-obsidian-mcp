import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { makeVault, Fixture } from "./fixtures.js";
import { getIndex } from "../src/tools/vault-index.js";
import {
  resolveWriteTarget,
  resolveWriteTargetAsync,
} from "../src/tools/not-found.js";

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
