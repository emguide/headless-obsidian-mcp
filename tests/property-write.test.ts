import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { makeVault } from "./fixtures.js";
import {
  addNotePropertyValues,
  removeNotePropertyValues,
  renameNoteProperty,
} from "../src/tools/write.js";

const NOTE = { path: "n.md", content: "---\ntitle: N\naliases: [a, b]\n---\nbody\n" };

test("addNotePropertyValues appends and persists", async () => {
  const { vaultPath, cleanup } = await makeVault([NOTE]);
  try {
    const res = await addNotePropertyValues(vaultPath, {
      path: "n",
      key: "aliases",
      values: ["c"],
    });
    assert.deepEqual(res.values, ["a", "b", "c"]);
    const raw = await readFile(join(vaultPath, "n.md"), "utf-8");
    assert.match(raw, /aliases:/);
    assert.match(raw, /- c/);
  } finally {
    await cleanup();
  }
});

test("removeNotePropertyValues removes and persists", async () => {
  const { vaultPath, cleanup } = await makeVault([NOTE]);
  try {
    const res = await removeNotePropertyValues(vaultPath, {
      path: "n",
      key: "aliases",
      values: ["a"],
    });
    assert.deepEqual(res.values, ["b"]);
  } finally {
    await cleanup();
  }
});

test("renameNoteProperty renames and persists", async () => {
  const { vaultPath, cleanup } = await makeVault([NOTE]);
  try {
    const res = await renameNoteProperty(vaultPath, {
      path: "n",
      from: "aliases",
      to: "akas",
    });
    assert.equal(res.to, "akas");
    const raw = await readFile(join(vaultPath, "n.md"), "utf-8");
    assert.match(raw, /akas:/);
    assert.doesNotMatch(raw, /aliases:/);
  } finally {
    await cleanup();
  }
});

test("addNotePropertyValues rejects markdown before writing", async () => {
  const { vaultPath, cleanup } = await makeVault([NOTE]);
  try {
    await assert.rejects(
      () => addNotePropertyValues(vaultPath, { path: "n", key: "aliases", values: ["[[x]]"] }),
      /markdown/i
    );
  } finally {
    await cleanup();
  }
});
