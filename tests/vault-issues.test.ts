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
  const orphans = (await listVaultIssues(fx.vaultPath, { kind: "orphans" })) as Array<{ path: string }>;
  assert.ok(orphans.some((o) => o.path === "orphan"));
});

test("orphans list length equals the stats orphan_notes count", async () => {
  const orphans = await listVaultIssues(fx.vaultPath, { kind: "orphans" });
  const stats = await getVaultStats(fx.vaultPath);
  assert.equal(orphans.length, stats.orphan_notes);
});

test("unresolved_links groups broken targets by source note", async () => {
  const groups = (await listVaultIssues(fx.vaultPath, { kind: "unresolved_links" })) as Array<{
    source: string;
    targets: string[];
  }>;
  const home = groups.find((g) => g.source === "index");
  assert.ok(home, "index should have an unresolved link");
  assert.ok(home!.targets.includes("missing-note"));
});

test("sum of unresolved targets equals the stats unresolved_links count", async () => {
  const groups = (await listVaultIssues(fx.vaultPath, { kind: "unresolved_links" })) as Array<{
    targets: string[];
  }>;
  const stats = await getVaultStats(fx.vaultPath);
  const total = groups.reduce((n, g) => n + g.targets.length, 0);
  assert.equal(total, stats.unresolved_links);
});

test("limit caps the number of rows", async () => {
  const groups = await listVaultIssues(fx.vaultPath, { kind: "unresolved_links", limit: 1 });
  assert.ok(Array.isArray(groups));
  assert.ok(groups.length <= 1);
});

test("limit of 0 is rejected (must be a positive integer)", async () => {
  await assert.rejects(
    () => listVaultIssues(fx.vaultPath, { kind: "unresolved_links", limit: 0 as any }),
    /limit must be/
  );
});

test("rejects an unknown kind", async () => {
  await assert.rejects(
    () => listVaultIssues(fx.vaultPath, { kind: "bogus" as any }),
    /kind must be/
  );
});
