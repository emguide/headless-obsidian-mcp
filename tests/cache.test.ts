import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, utimes, rm } from "node:fs/promises";
import { join } from "node:path";
import { listTags } from "../src/tools/tags.js";
import { listNotes } from "../src/tools/list.js";
import { getLinks } from "../src/tools/links.js";
import { makeVault, sampleNotes } from "./fixtures.js";

test("re-reads a file after its mtime changes", async () => {
  const fx = await makeVault(sampleNotes());
  try {
    const before = await listTags(fx.vaultPath);
    assert.ok(!before.some((t) => t.tag === "brandnew"));

    // Rewrite a note with a new tag and a newer mtime.
    const target = join(fx.vaultPath, "daily/2026-07-22.md");
    await writeFile(target, "# Daily\nUpdated. #brandnew\n", "utf-8");
    await utimes(target, new Date("2026-07-23T10:00:00Z"), new Date("2026-07-23T10:00:00Z"));

    const after = await listTags(fx.vaultPath);
    assert.ok(after.some((t) => t.tag === "brandnew"));
  } finally {
    await fx.cleanup();
  }
});

test("drops entries for deleted files", async () => {
  const fx = await makeVault(sampleNotes());
  try {
    const before = await listNotes(fx.vaultPath);
    assert.ok(before.results.some((n) => n.path === "Beta Note"));

    await rm(join(fx.vaultPath, "Beta Note.md"));

    const after = await listNotes(fx.vaultPath);
    assert.ok(!after.results.some((n) => n.path === "Beta Note"));
  } finally {
    await fx.cleanup();
  }
});

test("reflects new backlinks when a linking note is added", async () => {
  const fx = await makeVault(sampleNotes());
  try {
    const before = await getLinks(fx.vaultPath, "index");
    assert.ok(!before.backlinks.includes("late"));

    const target = join(fx.vaultPath, "late.md");
    await writeFile(target, "# Late\nSee [[index]].\n", "utf-8");

    const after = await getLinks(fx.vaultPath, "index");
    assert.ok(after.backlinks.includes("late"));
  } finally {
    await fx.cleanup();
  }
});
