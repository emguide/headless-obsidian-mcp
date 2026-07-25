import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { getFrontmatter } from "../src/tools/frontmatter.js";
import { getVaultStats } from "../src/tools/stats.js";
import { listVaultIssues } from "../src/tools/vault-issues.js";
import { makeVault, Fixture, sampleNotes } from "./fixtures.js";

/* ---------------------------------------------------------- frontmatter -- */

test("getFrontmatter returns the parsed metadata without the body", async () => {
  const fx = await makeVault([
    { path: "n.md", content: "---\ntitle: N\nstatus: active\ntags: [x, y]\n---\n# Body\ntext\n" },
  ]);
  const result = await getFrontmatter(fx.vaultPath, "n");
  assert.equal(result.path, "n");
  assert.deepEqual(result.frontmatter, { title: "N", status: "active", tags: ["x", "y"] });
  await fx.cleanup();
});

test("getFrontmatter returns an empty object for a note with no frontmatter", async () => {
  const fx = await makeVault([{ path: "bare.md", content: "# Bare\nno frontmatter\n" }]);
  const result = await getFrontmatter(fx.vaultPath, "bare");
  assert.deepEqual(result.frontmatter, {});
  await fx.cleanup();
});

test("getFrontmatter errors on a missing note and rejects path traversal", async () => {
  const fx = await makeVault([{ path: "real.md", content: "---\na: 1\n---\n" }]);
  await assert.rejects(() => getFrontmatter(fx.vaultPath, "ghost"), /not found/);
  await assert.rejects(() => getFrontmatter(fx.vaultPath, "../escape"), /path traversal/);
  await fx.cleanup();
});

/* ----------------------------------------------------------- vault stats -- */

let fx: Fixture;
before(async () => {
  fx = await makeVault(sampleNotes());
});
after(() => fx.cleanup());

test("getVaultStats counts notes, tags, and links from the shared index", async () => {
  const stats = await getVaultStats(fx.vaultPath);
  assert.equal(stats.notes, 4);
  assert.ok(stats.total_size_bytes > 0);
  assert.ok(stats.distinct_tags >= 1);
  assert.equal(stats.tagged_notes + stats.untagged_notes, stats.notes);
  // The sample vault has a [[missing-note]] link that resolves to nothing.
  assert.ok(stats.unresolved_links >= 1);
  assert.ok(stats.resolved_links >= 1);
  assert.equal(typeof stats.last_modified, "string");
  assert.equal(typeof stats.first_modified, "string");
});

test("getVaultStats reports zeros and nulls for an empty vault", async () => {
  const empty = await makeVault([]);
  const stats = await getVaultStats(empty.vaultPath);
  assert.equal(stats.notes, 0);
  assert.equal(stats.total_size_bytes, 0);
  assert.equal(stats.distinct_tags, 0);
  assert.equal(stats.last_modified, null);
  assert.equal(stats.first_modified, null);
  await empty.cleanup();
});

test("conflict_notes counts conflict copies (matches list_vault_issues conflicts)", async (t) => {
  const fx2 = await makeVault([
    { path: "a.md", content: "# A\n" },
    { path: "a (conflicted 2026-07-24 143022).md", content: "# A local\n" },
    { path: "b (conflicted 2026-07-24 150000).md", content: "# B local\n" },
  ]);
  t.after(() => fx2.cleanup());
  const stats = await getVaultStats(fx2.vaultPath);
  assert.equal(stats.conflict_notes, 2);
  const issues = await listVaultIssues(fx2.vaultPath, { kind: "conflicts", limit: 0 });
  assert.equal(issues.results.length, stats.conflict_notes);
});
