import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { listNotes } from "../src/tools/list.js";
import { findByTag } from "../src/tools/tags.js";
import { listRecentNotes } from "../src/tools/recent.js";
import { getRelatedNotes } from "../src/tools/related.js";
import { queryNotes } from "../src/tools/properties.js";
import { makeVault, Fixture } from "./fixtures.js";

// A vault where folder, tags, and frontmatter each partition the notes
// differently, so a filter that fails to apply is detectable.
let fx: Fixture;
before(async () => {
  fx = await makeVault([
    {
      path: "work/a.md",
      content: ["---", "status: active", "tags: [proj, urgent]", "---", "# A", "links [[work/b]]"].join("\n"),
      mtime: new Date("2026-07-21T10:00:00Z"),
    },
    {
      path: "work/b.md",
      content: ["---", "status: done", "tags: [proj]", "---", "# B", "links [[work/a]]"].join("\n"),
      mtime: new Date("2026-07-20T10:00:00Z"),
    },
    {
      path: "home/c.md",
      content: ["---", "status: active", "tags: [urgent]", "---", "# C", "links [[work/a]]"].join("\n"),
      mtime: new Date("2026-07-22T10:00:00Z"),
    },
  ]);
});
after(() => fx.cleanup());

const paths = (r: { results: { path: string }[] }) => r.results.map((n) => n.path).sort();

/* ------------------------------------------------------------- list_notes -- */

test("list_notes: tags filter (default any)", async () => {
  assert.deepEqual(paths(await listNotes(fx.vaultPath, { tags: ["urgent"] })), ["home/c", "work/a"]);
});

test("list_notes: tags match=all", async () => {
  assert.deepEqual(paths(await listNotes(fx.vaultPath, { tags: ["proj", "urgent"], match: "all" })), ["work/a"]);
});

test("list_notes: where filter", async () => {
  assert.deepEqual(paths(await listNotes(fx.vaultPath, { where: { status: "active" } })), ["home/c", "work/a"]);
});

test("list_notes: folder + tags + where compose", async () => {
  assert.deepEqual(
    paths(await listNotes(fx.vaultPath, { folder: "work", tags: ["proj"], where: { status: "active" } })),
    ["work/a"]
  );
});

/* ------------------------------------------------------------ find_by_tag -- */

test("find_by_tag: match still governs the tag set", async () => {
  assert.deepEqual(paths(await findByTag(fx.vaultPath, { tags: ["proj", "urgent"], match: "all" })), ["work/a"]);
});

test("find_by_tag: added folder narrows", async () => {
  // #urgent is on work/a and home/c; folder=work drops home/c.
  assert.deepEqual(paths(await findByTag(fx.vaultPath, { tags: ["urgent"], folder: "work" })), ["work/a"]);
});

test("find_by_tag: added where narrows (always all)", async () => {
  // #proj is on work/a and work/b; status=active drops work/b.
  assert.deepEqual(paths(await findByTag(fx.vaultPath, { tags: ["proj"], where: { status: "active" } })), ["work/a"]);
});

/* ------------------------------------------------------- list_recent_notes -- */

test("list_recent_notes: folder scope preserves recency ordering", async () => {
  const r = await listRecentNotes(fx.vaultPath, { folder: "work" });
  // work/a (07-21) newer than work/b (07-20); home/c excluded by folder.
  assert.deepEqual(r.results.map((n) => n.path), ["work/a", "work/b"]);
});

test("list_recent_notes: tags filter", async () => {
  assert.deepEqual(paths(await listRecentNotes(fx.vaultPath, { tags: ["urgent"] })), ["home/c", "work/a"]);
});

test("list_recent_notes: where + since still apply together", async () => {
  const r = await listRecentNotes(fx.vaultPath, {
    where: { status: "active" },
    since: "2026-07-22T00:00:00Z",
  });
  // active: work/a, home/c; since 07-22 keeps only home/c.
  assert.deepEqual(paths(r), ["home/c"]);
});

/* ------------------------------------------------------- get_related_notes -- */

test("get_related_notes: folder scopes the scored candidate pool", async () => {
  // work/a is linked by work/b and home/c; folder=home keeps only home/c.
  const r = await getRelatedNotes(fx.vaultPath, { path: "work/a", folder: "home" });
  assert.deepEqual(r.results.map((n) => n.path), ["home/c"]);
});

test("get_related_notes: tags scope the candidate pool", async () => {
  // Candidates carrying #proj (besides the source): work/b only.
  const r = await getRelatedNotes(fx.vaultPath, { path: "work/a", tags: ["proj"] });
  assert.deepEqual(r.results.map((n) => n.path), ["work/b"]);
});

test("get_related_notes: source note is never itself a candidate", async () => {
  const r = await getRelatedNotes(fx.vaultPath, { path: "work/a" });
  assert.ok(!r.results.some((n) => n.path === "work/a"));
});

/* ------------------------------------------------------------ query_notes -- */

test("query_notes: match still governs the where conditions", async () => {
  // any of {status active, tags contains urgent}: work/a, work/b(no)... status:
  const r = await queryNotes(fx.vaultPath, {
    where: { status: "active", tags: "urgent" },
    match: "any",
  });
  // active OR tagged urgent => work/a, home/c (work/b is neither).
  assert.deepEqual(paths(r), ["home/c", "work/a"]);
});

test("query_notes: added folder narrows", async () => {
  assert.deepEqual(
    paths(await queryNotes(fx.vaultPath, { where: { status: "active" }, folder: "work" })),
    ["work/a"]
  );
});

test("query_notes: added tags narrows (any membership)", async () => {
  // status=active: work/a, home/c; tags=[proj] keeps only work/a.
  assert.deepEqual(
    paths(await queryNotes(fx.vaultPath, { where: { status: "active" }, tags: ["proj"] })),
    ["work/a"]
  );
});
