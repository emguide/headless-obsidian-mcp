import { test } from "node:test";
import assert from "node:assert/strict";
import { listTasks } from "../src/tools/tasks.js";
import { makeVault } from "./fixtures.js";

const NOTES = [
  {
    path: "projects/alpha.md",
    content: [
      "---",
      "tags: [work]",
      "status: active",
      "---",
      "# Alpha",
      "- [ ] above headings? no — this is under Alpha",
      "## Log",
      "- [ ] review draft",
      "- [x] ship it",
      "- [/] wip item",
    ].join("\n"),
  },
  {
    path: "personal/todo.md",
    content: ["- [ ] buy milk", "- [-] skip gym"].join("\n"),
  },
];

test("lists tasks with section context and note path", async () => {
  const fx = await makeVault(NOTES);
  try {
    const res = await listTasks(fx.vaultPath, { folder: "projects" });
    // Lines are BODY-relative 1-based, matching get_outline/read_section.
    assert.deepEqual(
      res.results.map((t) => [t.path, t.text, t.status, t.line, t.section]),
      [
        ["projects/alpha", "above headings? no — this is under Alpha", "open", 2, "Alpha"],
        ["projects/alpha", "review draft", "open", 4, "Alpha > Log"],
        ["projects/alpha", "ship it", "done", 5, "Alpha > Log"],
        ["projects/alpha", "wip item", "in_progress", 6, "Alpha > Log"],
      ]
    );
    assert.equal(res.truncated, false);
  } finally {
    await fx.cleanup();
  }
});

test("task above any heading has null section", async () => {
  const fx = await makeVault(NOTES);
  try {
    const res = await listTasks(fx.vaultPath, { folder: "personal" });
    assert.equal(res.results[0].section, null);
    assert.equal(res.results[0].text, "buy milk");
  } finally {
    await fx.cleanup();
  }
});

test("status filter keeps any of the listed statuses", async () => {
  const fx = await makeVault(NOTES);
  try {
    const res = await listTasks(fx.vaultPath, { status: ["open", "in_progress"] });
    const statuses = new Set(res.results.map((t) => t.status));
    assert.deepEqual([...statuses].sort(), ["in_progress", "open"]);
    assert.ok(res.results.every((t) => t.status !== "done" && t.status !== "cancelled"));
  } finally {
    await fx.cleanup();
  }
});

test("candidate filters (tags/where) scope the task set", async () => {
  const fx = await makeVault(NOTES);
  try {
    const res = await listTasks(fx.vaultPath, { tags: ["work"], where: { status: "active" } });
    assert.ok(res.results.length > 0);
    assert.ok(res.results.every((t) => t.path === "projects/alpha"));
  } finally {
    await fx.cleanup();
  }
});

test("pagination envelope reports the window", async () => {
  const fx = await makeVault(NOTES);
  try {
    const res = await listTasks(fx.vaultPath, { limit: 2, offset: 1 });
    assert.equal(res.returned, 2);
    assert.equal(res.skipped, 1);
    assert.ok(res.omitted >= 1);
    assert.equal(res.truncated, true);
  } finally {
    await fx.cleanup();
  }
});

test("rejects an invalid status name", async () => {
  const fx = await makeVault(NOTES);
  try {
    await assert.rejects(
      () => listTasks(fx.vaultPath, { status: ["nope"] as any }),
      /status/
    );
  } finally {
    await fx.cleanup();
  }
});
