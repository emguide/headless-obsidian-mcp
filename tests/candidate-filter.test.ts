import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { getIndex } from "../src/tools/vault-index.js";
import { resolveCandidates, validateCandidateFilter } from "../src/tools/candidate-filter.js";
import { makeVault, Fixture } from "./fixtures.js";

let fx: Fixture;
before(async () => {
  fx = await makeVault([
    { path: "work/a.md", content: ["---", "status: active", "tags: [proj, urgent]", "---", "# A", "alpha"].join("\n") },
    { path: "work/b.md", content: ["---", "status: done", "tags: [proj]", "---", "# B", "beta"].join("\n") },
    { path: "home/c.md", content: ["---", "tags: [urgent]", "---", "# C", "gamma"].join("\n") },
  ]);
});
after(() => fx.cleanup());

test("folder scopes to notes under the prefix", async () => {
  const idx = await getIndex(fx.vaultPath);
  const paths = resolveCandidates(idx, { folder: "work" }).map((e) => e.path).sort();
  assert.deepEqual(paths, ["work/a", "work/b"]);
});

test("tags with tagMatch=all requires every tag", async () => {
  const idx = await getIndex(fx.vaultPath);
  const paths = resolveCandidates(idx, { tags: ["proj", "urgent"], tagMatch: "all" }).map((e) => e.path);
  assert.deepEqual(paths, ["work/a"]);
});

test("tags with tagMatch=any (default) matches any tag", async () => {
  const idx = await getIndex(fx.vaultPath);
  const paths = resolveCandidates(idx, { tags: ["urgent"] }).map((e) => e.path).sort();
  assert.deepEqual(paths, ["home/c", "work/a"]);
});

test("where filters by frontmatter", async () => {
  const idx = await getIndex(fx.vaultPath);
  const paths = resolveCandidates(idx, { where: { status: "active" } }).map((e) => e.path);
  assert.deepEqual(paths, ["work/a"]);
});

test("filters compose (folder + tags + where)", async () => {
  const idx = await getIndex(fx.vaultPath);
  const paths = resolveCandidates(idx, { folder: "work", tags: ["proj"], where: { status: "active" } }).map((e) => e.path);
  assert.deepEqual(paths, ["work/a"]);
});

test("validateCandidateFilter rejects empty tags array", () => {
  assert.throws(() => validateCandidateFilter({ tags: [] }), /tags must be a non-empty array/);
});

test("validateCandidateFilter rejects non-object where", () => {
  assert.throws(() => validateCandidateFilter({ where: [] }), /where must be an object/);
});

test("validateCandidateFilter rejects bad match", () => {
  assert.throws(() => validateCandidateFilter({ match: "some" }), /match must be/);
});
