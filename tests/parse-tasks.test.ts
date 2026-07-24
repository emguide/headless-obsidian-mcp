import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTasks, markerToStatus, statusToMarker } from "../src/tools/vault.js";

test("maps each marker to its named status", () => {
  const body = [
    "- [ ] open task",
    "- [x] done task",
    "- [X] also done",
    "- [/] in progress",
    "- [-] cancelled",
    "- [>] forwarded",
    "- [?] unknown marker",
    "- [] empty brackets",
  ].join("\n");
  const tasks = parseTasks(body);
  assert.deepEqual(
    tasks.map((t) => [t.text, t.status, t.marker]),
    [
      ["open task", "open", " "],
      ["done task", "done", "x"],
      ["also done", "done", "X"],
      ["in progress", "in_progress", "/"],
      ["cancelled", "cancelled", "-"],
      ["forwarded", "forwarded", ">"],
      ["unknown marker", "other", "?"],
      ["empty brackets", "open", " "],
    ]
  );
});

test("records 0-based line, indent, and bullet variants; skips fenced blocks and plain bullets", () => {
  const body = [
    "# Heading",          // line 0
    "- plain bullet",     // line 1 — NOT a task
    "* [ ] star bullet",  // line 2
    "  + [x] nested plus",// line 3 — indent 2
    "```",                // line 4
    "- [ ] in code fence",// line 5 — excluded
    "```",                // line 6
    "- [ ] after fence",  // line 7
  ].join("\n");
  const tasks = parseTasks(body);
  assert.deepEqual(
    tasks.map((t) => [t.text, t.line, t.indent, t.marker]),
    [
      ["star bullet", 2, 0, " "],
      ["nested plus", 3, 2, "x"],
      ["after fence", 7, 0, " "],
    ]
  );
});

test("marker/status maps round-trip for writable statuses", () => {
  for (const s of ["open", "done", "in_progress", "cancelled", "forwarded"] as const) {
    assert.equal(markerToStatus(statusToMarker(s)), s);
  }
  assert.equal(markerToStatus("z"), "other");
});
