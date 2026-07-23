import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { resolveNote } from "../src/tools/resolve.js";
import { makeVault, Fixture } from "./fixtures.js";

let fx: Fixture;
before(async () => {
  fx = await makeVault([
    {
      path: "work/alpha.md",
      content: [
        "---",
        "title: Alpha Project",
        "aliases: [Alpha, Project A]",
        "---",
        "# Alpha",
      ].join("\n"),
    },
    {
      path: "personal/journal.md",
      content: [
        "---",
        "title: My Journal",
        "aliases: Diary",
        "---",
        "# Journal",
      ].join("\n"),
    },
    // Two notes sharing a title -> ambiguous.
    {
      path: "a/meeting.md",
      content: ["---", "title: Meeting Notes", "---", "# a"].join("\n"),
    },
    {
      path: "b/meeting.md",
      content: ["---", "title: Meeting Notes", "---", "# b"].join("\n"),
    },
    // A note whose title equals another note's basename, and whose own
    // basename matches too: title should win as matched_on.
    {
      path: "standup.md",
      content: ["---", "title: Standup", "---", "# Standup"].join("\n"),
    },
  ]);
});
after(() => fx.cleanup());

test("resolves a unique title to a single path", async () => {
  const res = await resolveNote(fx.vaultPath, "Alpha Project");
  assert.equal(res.resolved, "work/alpha");
  assert.equal(res.matches.length, 1);
  assert.equal(res.matches[0].matched_on, "title");
  assert.equal(res.matches[0].path, "work/alpha");
});

test("resolves a unique basename", async () => {
  const res = await resolveNote(fx.vaultPath, "journal");
  assert.equal(res.resolved, "personal/journal");
  assert.equal(res.matches[0].matched_on, "basename");
});

test("resolves an alias from a YAML array", async () => {
  const res = await resolveNote(fx.vaultPath, "Project A");
  assert.equal(res.resolved, "work/alpha");
  assert.equal(res.matches[0].matched_on, "alias");
});

test("resolves an alias given as a single YAML string", async () => {
  const res = await resolveNote(fx.vaultPath, "Diary");
  assert.equal(res.resolved, "personal/journal");
  assert.equal(res.matches[0].matched_on, "alias");
});

test("is case-insensitive", async () => {
  const res = await resolveNote(fx.vaultPath, "aLpHa PrOjEcT");
  assert.equal(res.resolved, "work/alpha");
});

test("ambiguous query lists all candidates sorted by path, resolved null", async () => {
  const res = await resolveNote(fx.vaultPath, "Meeting Notes");
  assert.equal(res.resolved, null);
  assert.deepEqual(
    res.matches.map((m) => m.path),
    ["a/meeting", "b/meeting"]
  );
  assert.ok(res.matches.every((m) => m.matched_on === "title"));
});

test("a note matching by both title and basename appears once, title wins", async () => {
  const res = await resolveNote(fx.vaultPath, "standup");
  assert.equal(res.matches.length, 1);
  assert.equal(res.matches[0].path, "standup");
  assert.equal(res.matches[0].matched_on, "title");
  assert.equal(res.resolved, "standup");
});

test("no match returns empty matches and null resolved (no throw)", async () => {
  const res = await resolveNote(fx.vaultPath, "nonexistent note xyz");
  assert.deepEqual(res.matches, []);
  assert.equal(res.resolved, null);
  assert.equal(res.query, "nonexistent note xyz");
});

test("empty or whitespace query throws", async () => {
  await assert.rejects(() => resolveNote(fx.vaultPath, "   "));
  await assert.rejects(() => resolveNote(fx.vaultPath, ""));
});
