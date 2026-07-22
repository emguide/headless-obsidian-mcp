import { test } from "node:test";
import assert from "node:assert/strict";
import { makeVault } from "./fixtures.js";
import {
  listProperties,
  getPropertyValues,
  queryNotes,
  getProperty,
} from "../src/tools/properties.js";

function vault() {
  return makeVault([
    { path: "a.md", content: "---\ntitle: A\nstatus: active\npriority: 5\ntags: [x]\n---\nbody\n" },
    { path: "b.md", content: "---\ntitle: B\nstatus: active\npriority: 2\naliases: [k, j]\n---\nbody\n" },
    { path: "c.md", content: "---\ntitle: C\nstatus: done\nnull_field:\n---\nbody\n" },
  ]);
}

test("listProperties reports keys, counts, and types", async () => {
  const { vaultPath, cleanup } = await vault();
  try {
    const props = await listProperties(vaultPath);
    const status = props.find((p) => p.key === "status");
    assert.equal(status?.count, 3);
    assert.deepEqual(status?.types, ["string"]);
    const priority = props.find((p) => p.key === "priority");
    assert.equal(priority?.count, 2);
    assert.deepEqual(priority?.types, ["number"]);
    const nullField = props.find((p) => p.key === "null_field");
    assert.deepEqual(nullField?.types, ["null"]);
  } finally {
    await cleanup();
  }
});

test("listProperties omits tags when include_tags is false", async () => {
  const { vaultPath, cleanup } = await vault();
  try {
    const props = await listProperties(vaultPath, { include_tags: false });
    assert.equal(props.some((p) => p.key === "tags"), false);
  } finally {
    await cleanup();
  }
});

test("getPropertyValues facets distinct values with counts", async () => {
  const { vaultPath, cleanup } = await vault();
  try {
    const res = await getPropertyValues(vaultPath, { key: "status" });
    assert.equal(res.values.find((v) => v.value === "active")?.count, 2);
    assert.equal(res.values.find((v) => v.value === "done")?.count, 1);
  } finally {
    await cleanup();
  }
});

test("getPropertyValues counts array elements individually", async () => {
  const { vaultPath, cleanup } = await vault();
  try {
    const res = await getPropertyValues(vaultPath, { key: "aliases" });
    assert.equal(res.values.find((v) => v.value === "k")?.count, 1);
    assert.equal(res.values.find((v) => v.value === "j")?.count, 1);
  } finally {
    await cleanup();
  }
});

test("queryNotes finds notes by condition", async () => {
  const { vaultPath, cleanup } = await vault();
  try {
    const hits = await queryNotes(vaultPath, {
      where: { status: "active", priority: { gt: 3 } },
    });
    assert.deepEqual(hits.map((h) => h.path), ["a"]);
  } finally {
    await cleanup();
  }
});

test("queryNotes with match any", async () => {
  const { vaultPath, cleanup } = await vault();
  try {
    const hits = await queryNotes(vaultPath, {
      where: { status: "done", priority: { gte: 5 } },
      match: "any",
    });
    assert.deepEqual(hits.map((h) => h.path).sort(), ["a", "c"]);
  } finally {
    await cleanup();
  }
});

test("getProperty distinguishes present, null, and absent", async () => {
  const { vaultPath, cleanup } = await vault();
  try {
    assert.deepEqual(
      await getProperty(vaultPath, { path: "a", key: "status" }),
      { path: "a", key: "status", value: "active", present: true }
    );
    const nul = await getProperty(vaultPath, { path: "c", key: "null_field" });
    assert.equal(nul.present, true);
    assert.equal(nul.value, null);
    const absent = await getProperty(vaultPath, { path: "a", key: "nope" });
    assert.equal(absent.present, false);
  } finally {
    await cleanup();
  }
});
