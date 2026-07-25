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

test("resolveSelection accepts a folder-only filter", async () => {
  // `folder` is part of the shared candidate-filter vocabulary, so it's a
  // valid selection on its own: every note under the folder, no tags/where.
  const paths = await resolveSelection(fx.vaultPath, { folder: "projects" });
  assert.deepEqual(paths, ["projects/alpha"]);
});

test("resolveSelection treats a blank/whitespace folder as no filter", async () => {
  // A whitespace-only folder is not a real filter — it must still error rather
  // than silently selecting the whole vault.
  await assert.rejects(() => resolveSelection(fx.vaultPath, { folder: "   " }), /requires/);
});

test("resolveSelection: match governs tags only, not where", async () => {
  // alpha carries BOTH `project` and `project/active`; Beta carries neither.
  // With match:"all" on two tags, only alpha matches. The `where` condition
  // (status:active, which alpha satisfies) rides along as an independent `all`
  // — match does not fold it in. This is the fixed behavior: match is the
  // primary (tags) filter's combinator, never the where combinator.
  const paths = await resolveSelection(fx.vaultPath, {
    tags: ["project", "project/active"],
    where: { status: "active" },
    match: "all",
  });
  assert.deepEqual(paths, ["projects/alpha"]);
});

test("resolveSelection: default tag match is any", async () => {
  // productivity is on alpha and Beta; a bogus second tag with the default
  // (any) still matches both. Under the old match-defaults-to-all this would
  // have matched nothing.
  const paths = await resolveSelection(fx.vaultPath, {
    tags: ["productivity", "does-not-exist"],
  });
  assert.ok(paths.includes("projects/alpha"));
  assert.ok(paths.includes("Beta Note"));
});

test("resolveSelection limit caps the match count", async () => {
  const all = await resolveSelection(fx.vaultPath, { where: { status: { exists: true } } });
  assert.ok(all.length > 1, "fixture should have >1 note with a status");
  const capped = await resolveSelection(fx.vaultPath, { where: { status: { exists: true } }, limit: 1 });
  assert.equal(capped.length, 1);
});

test("resolveSelection limit: 0 is unbounded (vault-wide convention)", async () => {
  const all = await resolveSelection(fx.vaultPath, { where: { status: { exists: true } } });
  const zero = await resolveSelection(fx.vaultPath, { where: { status: { exists: true } }, limit: 0 });
  assert.deepEqual(zero, all);
});

test("resolveSelection rejects a negative limit", async () => {
  await assert.rejects(
    () => resolveSelection(fx.vaultPath, { where: { status: { exists: true } }, limit: -1 }),
    /limit must be a non-negative integer/
  );
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

test("resolveSelection rejects a non-object where", async () => {
  await assert.rejects(
    () => resolveSelection(fx.vaultPath, { where: "draft" as any }),
    /where must be an object/
  );
});

test("resolveSelection rejects an empty paths array with no filter", async () => {
  await assert.rejects(
    () => resolveSelection(fx.vaultPath, { paths: [] }),
    /paths is empty/
  );
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

test("bulkEdit applies ops to a folder-only selection", async () => {
  const local = await makeVault(sampleNotes());
  const res = await bulkEdit(local.vaultPath, {
    select: { folder: "projects" },
    operations: [{ op: "add_tag", tags: ["reviewed"] }],
  });
  assert.equal(res.dry_run, false);
  assert.equal(res.applied_count, 1);
  assert.equal(res.failed_count, 0);
  const alpha = await readNote(local.vaultPath, "projects/alpha.md");
  assert.match(alpha, /- reviewed/);
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
  // The per-note error funnels through the shared not-found builder: the
  // polished "Note not found: <name>" message, never a raw ENOENT leaking the
  // absolute filesystem path.
  assert.match(bad!.error!, /Note not found: does\/not\/exist/);
  assert.doesNotMatch(bad!.error!, /ENOENT/);
  assert.doesNotMatch(bad!.error!, new RegExp(local.vaultPath));
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

  // Leave the tree DIRTY so the commit-after-write funnel has pre-existing
  // state to fold into its single end-of-batch commit alongside the batch's
  // own changes (git-sync.ts's commitAfterWrite stages everything with `git
  // add -A`, so both land in that one commit).
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
  // Exactly ONE commit for the whole batch — not one per matched note.
  assert.equal(Number(after) - Number(before), 1);
  await local.cleanup();
});
