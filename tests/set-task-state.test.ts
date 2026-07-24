import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import matter from "gray-matter";
import { setTaskState } from "../src/tools/write.js";
import { listTasks } from "../src/tools/tasks.js";
import { makeVault, Fixture } from "./fixtures.js";

const read = (v: string, n: string) => readFile(join(v, n), "utf-8");

async function vault(): Promise<Fixture> {
  return makeVault([
    {
      path: "t.md",
      content: [
        "# Tasks",
        "- [ ] review draft",
        "  - [ ] nested item",
        "- [ ] review draft", // duplicate text on line 4 (1-based)
        "- [x] already done",
      ].join("\n"),
    },
  ]);
}

test("sets a uniquely-addressed task by text and rewrites only the marker", async () => {
  const fx = await vault();
  try {
    const res = await setTaskState(fx.vaultPath, {
      path: "t",
      text: "nested item",
      status: "done",
    });
    assert.equal(res.changed, true);
    assert.equal(res.status, "done");
    assert.equal(res.marker, "x");
    assert.equal(res.line, 3);
    assert.deepEqual(res.unresolved_links, []);
    assert.deepEqual(res.broken_anchors, []);
    const body = await read(fx.vaultPath, "t.md");
    assert.match(body, /^ {2}- \[x\] nested item$/m); // indentation preserved
  } finally {
    await fx.cleanup();
  }
});

test("ambiguous text errors and lists candidate lines", async () => {
  const fx = await vault();
  try {
    await assert.rejects(
      () => setTaskState(fx.vaultPath, { path: "t", text: "review draft", status: "done" }),
      /lines 2, 4/
    );
  } finally {
    await fx.cleanup();
  }
});

test("text + line disambiguates a duplicate", async () => {
  const fx = await vault();
  try {
    const res = await setTaskState(fx.vaultPath, {
      path: "t",
      text: "review draft",
      line: 4,
      status: "in_progress",
    });
    assert.equal(res.line, 4);
    assert.equal(res.marker, "/");
    const body = await read(fx.vaultPath, "t.md");
    assert.match(body, /^- \[\/\] review draft$/m);
    assert.match(body, /^- \[ \] review draft$/m); // line 2 untouched
  } finally {
    await fx.cleanup();
  }
});

test("stale text+line (text mismatch at line) errors", async () => {
  const fx = await vault();
  try {
    await assert.rejects(
      () => setTaskState(fx.vaultPath, { path: "t", text: "review draft", line: 5, status: "done" }),
      /does not match/i
    );
  } finally {
    await fx.cleanup();
  }
});

test("line alone addresses positionally", async () => {
  const fx = await vault();
  try {
    const res = await setTaskState(fx.vaultPath, { path: "t", line: 2, status: "cancelled" });
    assert.equal(res.text, "review draft");
    assert.equal(res.marker, "-");
  } finally {
    await fx.cleanup();
  }
});

test("no task at the given line errors", async () => {
  const fx = await vault();
  try {
    await assert.rejects(
      () => setTaskState(fx.vaultPath, { path: "t", line: 1, status: "done" }),
      /no task/i
    );
  } finally {
    await fx.cleanup();
  }
});

test("text not found errors", async () => {
  const fx = await vault();
  try {
    await assert.rejects(
      () => setTaskState(fx.vaultPath, { path: "t", text: "does not exist", status: "done" }),
      /not found/i
    );
  } finally {
    await fx.cleanup();
  }
});

test("neither text nor line errors", async () => {
  const fx = await vault();
  try {
    await assert.rejects(
      () => setTaskState(fx.vaultPath, { path: "t", status: "done" } as any),
      /text.*or.*line|provide/i
    );
  } finally {
    await fx.cleanup();
  }
});

test("already-in-state is a no-op", async () => {
  const fx = await vault();
  try {
    const res = await setTaskState(fx.vaultPath, { path: "t", line: 5, status: "done" });
    assert.equal(res.changed, false);
    assert.equal(res.marker, "x");
  } finally {
    await fx.cleanup();
  }
});

test("status 'other' is rejected", async () => {
  const fx = await vault();
  try {
    await assert.rejects(
      () => setTaskState(fx.vaultPath, { path: "t", line: 2, status: "other" as any }),
      /status/i
    );
  } finally {
    await fx.cleanup();
  }
});

test("note WITH frontmatter: body-relative line addresses the correct task and frontmatter is untouched", async () => {
  const frontmatterBlock = ["---", "title: Fixture Note", "status: active", "---"].join("\n");
  const fx = await makeVault([
    {
      path: "fm.md",
      content: [
        frontmatterBlock,
        "# Tasks",
        "- [ ] review draft",
        "  - [ ] nested item",
        "- [x] already done",
      ].join("\n"),
    },
  ]);
  try {
    // Body-relative line 3 is "  - [ ] nested item" (line 1 = "# Tasks").
    // If the implementation mistakenly indexed the RAW file (frontmatter +
    // body) instead of the body alone, line 3 would land inside/near the
    // frontmatter block or on the wrong body line instead of "nested item".
    const res = await setTaskState(fx.vaultPath, { path: "fm", line: 3, status: "done" });
    assert.equal(res.text, "nested item");
    assert.equal(res.marker, "x");
    assert.equal(res.line, 3);

    const raw = await read(fx.vaultPath, "fm.md");
    // Frontmatter block preserved byte-for-byte.
    assert.ok(raw.startsWith(frontmatterBlock + "\n"), "frontmatter block must be untouched");
    // Exactly the nested task's marker changed; the sibling and other tasks did not.
    assert.match(raw, /^ {2}- \[x\] nested item$/m);
    assert.match(raw, /^- \[ \] review draft$/m);
    assert.match(raw, /^- \[x\] already done$/m);
  } finally {
    await fx.cleanup();
  }
});

test("closing frontmatter fence with trailing whitespace: set_task_state agrees with list_tasks on line numbering", async () => {
  // NoteDocument's FENCE regex (`[ \t]*` after the closing "---") swallows the
  // trailing spaces on the closing fence into the frontmatter block, while
  // gray-matter (used by list_tasks/get_outline) does not — that whitespace
  // becomes the note's first "body" line. On a note like this the two body
  // splits disagree by one line unless set_task_state strips frontmatter the
  // same way the index does.
  const raw =
    "---\ntitle: X\ntags: [a]\n---   \n# H\n- [ ] alpha\n- [ ] beta\n";
  const fx = await makeVault([{ path: "trail.md", content: raw }]);
  try {
    // Sanity-check the premise: gray-matter's stripped body is a suffix of raw
    // (raw.endsWith(body)), which the fix relies on to reattach frontmatter
    // byte-for-byte via slicing.
    const body = matter(raw).content;
    assert.ok(raw.endsWith(body), "matter(raw).content must be a suffix of raw");

    const listed = await listTasks(fx.vaultPath, {});
    const betaRow = listed.results.find((t) => t.text === "beta");
    assert.ok(betaRow, "list_tasks must report the 'beta' task");
    const betaLine = betaRow!.line;

    // Handing list_tasks' reported line straight to set_task_state must land
    // on "beta" (not "alpha", not the heading) — the documented invariant.
    const res = await setTaskState(fx.vaultPath, {
      path: "trail",
      line: betaLine,
      text: "beta",
      status: "done",
    });
    assert.equal(res.text, "beta");
    assert.equal(res.marker, "x");
    assert.equal(res.line, betaLine);

    const after = await read(fx.vaultPath, "trail.md");
    // Frontmatter block (including its trailing-space closing fence) intact.
    assert.ok(
      after.startsWith("---\ntitle: X\ntags: [a]\n---   \n"),
      "frontmatter block, including trailing-space closing fence, must be byte-for-byte intact"
    );
    // Only beta's marker changed; alpha untouched.
    assert.match(after, /^- \[x\] beta$/m);
    assert.match(after, /^- \[ \] alpha$/m);
  } finally {
    await fx.cleanup();
  }
});
