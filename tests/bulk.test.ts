import { test } from "node:test";
import assert from "node:assert/strict";
import { before, after } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NoteDocument } from "../src/tools/note-document.js";
import { validateOperations, applyOperations, resolveSelection } from "../src/tools/bulk.js";
import { makeVault, sampleNotes, type Fixture } from "./fixtures.js";

test("validateOperations rejects an unknown op", () => {
  assert.throws(() => validateOperations([{ op: "frobnicate" }]), /unknown op/i);
});

test("validateOperations rejects a non-array", () => {
  assert.throws(() => validateOperations({}), /operations must be a non-empty array/);
});

test("validateOperations requires args for each op", () => {
  assert.throws(() => validateOperations([{ op: "add_tag" }]), /tags must be a non-empty array/);
  assert.throws(() => validateOperations([{ op: "rename_property", from: "a" }]), /to must be a non-empty string/);
});

test("applyOperations applies multiple ops in order and reports change", () => {
  const doc = NoteDocument.parse("---\nstatus: draft\n---\n# Body\n");
  const changed = applyOperations(doc, [
    { op: "add_tag", tags: ["review"] },
    { op: "set_frontmatter", set: { status: "active" } },
  ]);
  assert.equal(changed, true);
  const out = doc.serialize();
  assert.match(out, /status: active/);
  assert.match(out, /- review/);
});

test("applyOperations returns false when every op is a no-op", () => {
  const doc = NoteDocument.parse("---\ntags:\n  - review\n---\n# Body\n");
  const changed = applyOperations(doc, [{ op: "add_tag", tags: ["review"] }]);
  assert.equal(changed, false);
});

let fx: Fixture;
before(async () => {
  fx = await makeVault(sampleNotes());
});
after(async () => {
  await fx.cleanup();
});

test("resolveSelection returns explicit paths canonicalized", async () => {
  const paths = await resolveSelection(fx.vaultPath, { paths: ["projects/alpha.md", "index"] });
  assert.deepEqual(paths.sort(), ["index", "projects/alpha"]);
});

test("resolveSelection by where filter", async () => {
  const paths = await resolveSelection(fx.vaultPath, { where: { status: "active" } });
  assert.deepEqual(paths, ["projects/alpha"]);
});

test("resolveSelection by tag filter", async () => {
  const paths = await resolveSelection(fx.vaultPath, { tags: ["productivity"] });
  assert.ok(paths.includes("projects/alpha"));
  assert.ok(paths.includes("Beta Note"));
});

test("resolveSelection folder scope with a filter", async () => {
  const paths = await resolveSelection(fx.vaultPath, { folder: "projects", tags: ["project"] });
  assert.deepEqual(paths, ["projects/alpha"]);
});

test("resolveSelection rejects paths + filter together", async () => {
  await assert.rejects(
    () => resolveSelection(fx.vaultPath, { paths: ["a"], where: { status: "x" } }),
    /not both/
  );
});

test("resolveSelection rejects an empty select", async () => {
  await assert.rejects(() => resolveSelection(fx.vaultPath, {}), /requires/);
});

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bulkEdit } from "../src/tools/bulk.js";
import { GIT_AUTOCOMMIT_ENV } from "../src/tools/git-guard.js";
const readNote = (v: string, name: string) => readFile(join(v, name), "utf-8");
const execFileAsync = promisify(execFile);
const git = (cwd: string, args: string[]) => execFileAsync("git", ["-C", cwd, ...args]);

test("bulkEdit dry_run returns matches and writes nothing", async () => {
  const local = await makeVault(sampleNotes());
  const res = await bulkEdit(local.vaultPath, {
    select: { tags: ["productivity"] },
    operations: [{ op: "add_tag", tags: ["reviewed"] }],
    dry_run: true,
  });
  assert.equal(res.dry_run, true);
  assert.equal(res.matched_count, res.matched!.length);
  // No write happened.
  const alpha = await readNote(local.vaultPath, "projects/alpha.md");
  assert.doesNotMatch(alpha, /reviewed/);
  await local.cleanup();
});

test("bulkEdit applies ops to every matched note", async () => {
  const local = await makeVault(sampleNotes());
  const res = await bulkEdit(local.vaultPath, {
    select: { where: { status: "active" } },
    operations: [{ op: "set_frontmatter", set: { reviewed: true } }],
  });
  assert.equal(res.dry_run, false);
  assert.equal(res.applied_count, 1);
  assert.equal(res.failed_count, 0);
  const alpha = await readNote(local.vaultPath, "projects/alpha.md");
  assert.match(alpha, /reviewed: true/);
  await local.cleanup();
});

test("bulkEdit expected_count mismatch aborts before writing", async () => {
  const local = await makeVault(sampleNotes());
  await assert.rejects(
    () => bulkEdit(local.vaultPath, {
      select: { where: { status: "active" } },
      operations: [{ op: "add_tag", tags: ["x"] }],
      expected_count: 5,
    }),
    /expected_count 5 but 1/
  );
  const alpha = await readNote(local.vaultPath, "projects/alpha.md");
  assert.doesNotMatch(alpha, /- x\b/);
  await local.cleanup();
});

test("bulkEdit isolates a per-note failure and reports it", async () => {
  const local = await makeVault(sampleNotes());
  const res = await bulkEdit(local.vaultPath, {
    select: { paths: ["projects/alpha", "does/not/exist"] },
    operations: [{ op: "add_tag", tags: ["x"] }],
  });
  assert.equal(res.applied_count, 1);
  assert.equal(res.failed_count, 1);
  const bad = res.results!.find((r) => r.path === "does/not/exist");
  assert.equal(bad!.ok, false);
  assert.match(bad!.error!, /not found|ENOENT/i);
  await local.cleanup();
});

test("bulkEdit reports changed:false for an idempotent no-op", async () => {
  const local = await makeVault(sampleNotes());
  const res = await bulkEdit(local.vaultPath, {
    select: { paths: ["index"] },
    operations: [{ op: "add_tag", tags: ["moc"] }], // already present
  });
  const r = res.results!.find((x) => x.path === "index");
  assert.equal(r!.ok, true);
  assert.equal(r!.changed, false);
  await local.cleanup();
});

test("bulkEdit takes exactly one snapshot for a multi-note batch", async () => {
  const local = await makeVault(sampleNotes());
  await git(local.vaultPath, ["init"]);
  await git(local.vaultPath, ["config", "user.email", "t@t.t"]);
  await git(local.vaultPath, ["config", "user.name", "t"]);
  await git(local.vaultPath, ["add", "-A"]);
  await git(local.vaultPath, ["commit", "--no-verify", "-m", "init"]);

  // Leave the tree DIRTY so the guard has pre-existing state to snapshot.
  // (On a clean tree snapshotBeforeWrite is a no-op — see git-guard.ts:43-45.)
  await writeFile(join(local.vaultPath, "scratch.md"), "# scratch\n", "utf-8");

  const before = (await git(local.vaultPath, ["rev-list", "--count", "HEAD"])).stdout.trim();

  process.env[GIT_AUTOCOMMIT_ENV] = "1";
  try {
    const res = await bulkEdit(local.vaultPath, {
      select: { tags: ["productivity"] }, // matches >=2 notes
      operations: [{ op: "add_tag", tags: ["snapshot-check"] }],
    });
    assert.ok(res.applied_count! >= 2);
  } finally {
    delete process.env[GIT_AUTOCOMMIT_ENV];
  }

  const after = (await git(local.vaultPath, ["rev-list", "--count", "HEAD"])).stdout.trim();
  // Exactly ONE snapshot commit — not one per matched note — captured the
  // pre-existing dirty state. The batch writes themselves stay uncommitted.
  assert.equal(Number(after) - Number(before), 1);
  await local.cleanup();
});
