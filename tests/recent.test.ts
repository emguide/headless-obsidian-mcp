import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { listRecentNotes } from "../src/tools/recent.js";
import { makeVault, sampleNotes, Fixture } from "./fixtures.js";

let fx: Fixture;
before(async () => {
  fx = await makeVault(sampleNotes());
});
after(() => fx.cleanup());

test("orders by mtime, newest first", async () => {
  const notes = await listRecentNotes(fx.vaultPath);
  assert.equal(notes[0].path, "daily/2026-07-22"); // newest mtime
  assert.equal(notes[notes.length - 1].path, "Beta Note"); // oldest mtime
});

test("respects limit", async () => {
  const notes = await listRecentNotes(fx.vaultPath, { limit: 2 });
  assert.deepEqual(
    notes.map((n) => n.path),
    ["daily/2026-07-22", "projects/alpha"]
  );
});

test("since excludes older notes", async () => {
  const notes = await listRecentNotes(fx.vaultPath, {
    since: "2026-07-15",
  });
  assert.deepEqual(
    notes.map((n) => n.path).sort(),
    ["daily/2026-07-22", "projects/alpha"]
  );
});

test("where filters on frontmatter equality", async () => {
  const notes = await listRecentNotes(fx.vaultPath, {
    where: { status: "active" },
  });
  assert.deepEqual(
    notes.map((n) => n.path),
    ["projects/alpha"]
  );
});

test("date_field sorts by frontmatter date, overriding mtime order", async () => {
  // Two notes whose `updated` order is the opposite of their mtime order, so
  // the result proves date_field (not mtime) drove the sort.
  const local = await makeVault([
    {
      path: "old-file-new-date.md",
      content: "---\nupdated: 2026-08-01\n---\n# A",
      mtime: new Date("2026-01-01T00:00:00Z"),
    },
    {
      path: "new-file-old-date.md",
      content: "---\nupdated: 2026-02-01\n---\n# B",
      mtime: new Date("2026-12-31T00:00:00Z"),
    },
  ]);
  try {
    const byMtime = await listRecentNotes(local.vaultPath);
    assert.equal(byMtime[0].path, "new-file-old-date"); // newest mtime wins

    const byField = await listRecentNotes(local.vaultPath, {
      date_field: "updated",
    });
    assert.equal(byField[0].path, "old-file-new-date"); // newest `updated` wins
  } finally {
    await local.cleanup();
  }
});

test("date_field falls back to mtime when a note lacks the field", async () => {
  // daily/2026-07-22 has no `updated`; it falls back to its (newest) mtime and
  // still leads over alpha's older `updated: 2026-07-20`.
  const notes = await listRecentNotes(fx.vaultPath, { date_field: "updated" });
  assert.equal(notes[0].path, "daily/2026-07-22");
});

test("rejects an invalid since date", async () => {
  await assert.rejects(
    () => listRecentNotes(fx.vaultPath, { since: "not-a-date" }),
    /valid date/
  );
});
