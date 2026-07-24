import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { searchNotes } from "../src/tools/search.js";
import { listTasks } from "../src/tools/tasks.js";
import { makeVault, Fixture } from "./fixtures.js";

let fx: Fixture;
before(async () => {
  fx = await makeVault([
    {
      path: "fm.md",
      content: [
        "---",
        "tags: [work]",
        "status: active needle", // frontmatter hit for the null case
        "---",
        "# Head",
        "",
        "- [ ] needle task",
        "needle in body",
      ].join("\n"),
    },
    { path: "plain.md", content: "# Plain\nneedle here\n" },
    {
      // Trailing-space closing fence: gray-matter vs NoteDocument divergence.
      path: "tricky.md",
      content: "---\nk: v\n---   \n- [ ] tricky needle\n",
    },
  ]);
});
after(async () => {
  await fx.cleanup();
});

function matchesOf(result: Awaited<ReturnType<typeof searchNotes>>, path: string) {
  const file = result.results.find((r) => r.path === path);
  assert.ok(file, `expected a result for ${path}`);
  return file.matches;
}

test("body hits carry body_line = line_number minus the frontmatter block", async () => {
  const result = await searchNotes(fx.vaultPath, { pattern: "needle" });
  const matches = matchesOf(result, "fm");
  const task = matches.find((m) => m.content.includes("- [ ]"));
  const body = matches.find((m) => m.content.includes("in body"));
  assert.ok(task && body);
  assert.equal(task.line_number, 7);
  assert.equal(task.body_line, 3);
  assert.equal(body.line_number, 8);
  assert.equal(body.body_line, 4);
});

test("a hit inside the frontmatter block has body_line null", async () => {
  const result = await searchNotes(fx.vaultPath, { pattern: "needle" });
  const fmHit = matchesOf(result, "fm").find((m) => m.content.includes("status:"));
  assert.ok(fmHit);
  assert.equal(fmHit.line_number, 3);
  assert.equal(fmHit.body_line, null);
});

test("without frontmatter, body_line equals line_number", async () => {
  const result = await searchNotes(fx.vaultPath, { pattern: "needle" });
  const hit = matchesOf(result, "plain")[0];
  assert.equal(hit.line_number, 2);
  assert.equal(hit.body_line, 2);
});

test("body_line matches list_tasks' line for the same task (the handoff)", async () => {
  const result = await searchNotes(fx.vaultPath, { pattern: "needle" });
  const tasks = (await listTasks(fx.vaultPath)).results;

  for (const path of ["fm", "tricky"]) {
    const hit = matchesOf(result, path).find((m) => m.content.includes("- [ ]"));
    const task = tasks.find((t) => t.path === path);
    assert.ok(hit && task, `expected a task hit and row for ${path}`);
    assert.equal(hit.body_line, task.line, `body_line/list_tasks divergence in ${path}`);
  }
});

test("filtered search (index pre-resolved) annotates body_line the same way", async () => {
  const result = await searchNotes(fx.vaultPath, { pattern: "needle", tags: ["work"] });
  const task = matchesOf(result, "fm").find((m) => m.content.includes("- [ ]"));
  assert.ok(task);
  assert.equal(task.body_line, 3);
});
