import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { listVaultIssues } from "../src/tools/vault-issues.js";
import { getVaultStats } from "../src/tools/stats.js";
import { makeVault, sampleNotes, Fixture, FixtureNote } from "./fixtures.js";

let fx: Fixture;
before(async () => {
  // sampleNotes has: index -> [[missing-note]] (unresolved) + interlinked notes.
  // Add a truly orphan note (no links in or out).
  const notes: FixtureNote[] = [
    ...sampleNotes(),
    { path: "orphan.md", content: "# Orphan\nNo links here." },
  ];
  fx = await makeVault(notes);
});
after(() => fx.cleanup());

test("orphans lists notes with no inbound or outbound resolved links", async () => {
  const orphans = (await listVaultIssues(fx.vaultPath, { kind: "orphans" })).results as Array<{ path: string }>;
  assert.ok(orphans.some((o) => o.path === "orphan"));
});

test("orphans list length equals the stats orphan_notes count", async () => {
  const orphans = await listVaultIssues(fx.vaultPath, { kind: "orphans" });
  const stats = await getVaultStats(fx.vaultPath);
  assert.equal(orphans.results.length, stats.orphan_notes);
});

test("unresolved_links groups broken targets by source note", async () => {
  const groups = (await listVaultIssues(fx.vaultPath, { kind: "unresolved_links" })).results as Array<{
    source: string;
    targets: string[];
  }>;
  const home = groups.find((g) => g.source === "index");
  assert.ok(home, "index should have an unresolved link");
  assert.ok(home!.targets.includes("missing-note"));
});

test("sum of unresolved targets equals the stats unresolved_links count", async () => {
  const groups = (await listVaultIssues(fx.vaultPath, { kind: "unresolved_links" })).results as Array<{
    targets: string[];
  }>;
  const stats = await getVaultStats(fx.vaultPath);
  const total = groups.reduce((n, g) => n + g.targets.length, 0);
  assert.equal(total, stats.unresolved_links);
});

test("limit caps the number of rows", async () => {
  const groups = await listVaultIssues(fx.vaultPath, { kind: "unresolved_links", limit: 1 });
  assert.ok(Array.isArray(groups.results));
  assert.ok(groups.results.length <= 1);
});

test("limit of 0 is unbounded (not rejected)", async () => {
  const result = await listVaultIssues(fx.vaultPath, { kind: "unresolved_links", limit: 0 });
  assert.equal(result.truncated, false);
});

test("negative limit is rejected (must be a positive integer)", async () => {
  await assert.rejects(
    () => listVaultIssues(fx.vaultPath, { kind: "unresolved_links", limit: -1 as any }),
    /limit must be/
  );
});

test("rejects an unknown kind", async () => {
  await assert.rejects(
    () => listVaultIssues(fx.vaultPath, { kind: "bogus" as any }),
    /kind must be/
  );
});

test("orphans: limit truncates and reports returned/omitted", async () => {
  const extraOrphans: FixtureNote[] = [
    { path: "orphan2.md", content: "# Orphan 2\nNo links here." },
    { path: "orphan3.md", content: "# Orphan 3\nNo links here." },
  ];
  const fx2 = await makeVault([...sampleNotes(), { path: "orphan.md", content: "# Orphan\nNo links here." }, ...extraOrphans]);
  try {
    const full = await listVaultIssues(fx2.vaultPath, { kind: "orphans" });
    assert.ok(full.results.length >= 3, "expect at least 3 orphan notes in this fixture");

    const limited = await listVaultIssues(fx2.vaultPath, { kind: "orphans", limit: 2 });
    assert.equal(limited.truncated, true);
    assert.equal(limited.returned, 2);
    assert.equal(limited.results.length, 2);
    assert.equal(limited.omitted, full.results.length - 2);

    const unlimited = await listVaultIssues(fx2.vaultPath, { kind: "orphans", limit: 0 });
    assert.equal(unlimited.truncated, false);
    assert.equal(unlimited.omitted, 0);
    assert.equal(unlimited.results.length, full.results.length);
  } finally {
    await fx2.cleanup();
  }
});

test("unresolved_links: limit truncates by GROUP count, not target count", async () => {
  // broken-a carries TWO unresolved targets so group-count (3) diverges from
  // target-count (4) — this distinguishes group-truncation from a bug that
  // would (mis)count/limit by flattened target count instead.
  const notes: FixtureNote[] = [
    { path: "broken-a.md", content: "# A\nSee [[nope-a]] and [[nope-d]]." },
    { path: "broken-b.md", content: "# B\nSee [[nope-b]]." },
    { path: "broken-c.md", content: "# C\nSee [[nope-c]]." },
  ];
  const fx3 = await makeVault(notes);
  try {
    const full = await listVaultIssues(fx3.vaultPath, { kind: "unresolved_links" });
    assert.equal(full.results.length, 3, "expect 3 source-note groups");
    const fullTargetCount = full.results.reduce((n, g) => n + g.targets.length, 0);
    assert.equal(fullTargetCount, 4, "expect 4 flattened targets across 3 groups");

    const limited = await listVaultIssues(fx3.vaultPath, { kind: "unresolved_links", limit: 2 });
    assert.equal(limited.truncated, true);
    assert.equal(limited.returned, 2);
    assert.equal(limited.results.length, 2);
    assert.equal(limited.omitted, 1);

    const unlimited = await listVaultIssues(fx3.vaultPath, { kind: "unresolved_links", limit: 0 });
    assert.equal(unlimited.truncated, false);
    assert.equal(unlimited.omitted, 0);
    assert.equal(unlimited.results.length, 3);
  } finally {
    await fx3.cleanup();
  }
});

test("conflicts kind: lists conflict copies paired with their original", async () => {
  const notes: FixtureNote[] = [
    { path: "projects/alpha.md", content: "# Alpha\n" },
    { path: "projects/alpha (conflicted 2026-07-24 143022).md", content: "# Alpha local\n" },
    { path: "notes/plain.md", content: "# Plain\n" },
  ];
  const fx4 = await makeVault(notes);
  try {
    const res = await listVaultIssues(fx4.vaultPath, { kind: "conflicts" });
    assert.equal(res.results.length, 1);
    assert.equal(res.results[0].path, "projects/alpha (conflicted 2026-07-24 143022)");
    assert.equal(res.results[0].original, "projects/alpha");
    assert.match(res.results[0].created, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    await fx4.cleanup();
  }
});

test("conflicts kind: include_context is rejected (no links to contextualize)", async () => {
  const fx5 = await makeVault([{ path: "a.md", content: "# A\n" }]);
  try {
    await assert.rejects(
      () => listVaultIssues(fx5.vaultPath, { kind: "conflicts", include_context: true }),
      /include_context/
    );
  } finally {
    await fx5.cleanup();
  }
});
