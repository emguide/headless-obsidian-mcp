import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createFolder, moveFolder, deleteFolder } from "../src/tools/folder-ops.js";
import { listFolders } from "../src/tools/folders.js";
import { makeVault, sampleNotes, Fixture, FixtureNote } from "./fixtures.js";
import { clearIndexCache } from "../src/tools/vault-index.js";
import { GIT_SYNC_ENV } from "../src/tools/env-flags.js";

const execFileAsync = promisify(execFile);

let fx: Fixture;

/**
 * A vault whose `projects/` folder is linked into from three directions: a
 * root note using the full path, a note using a bare basename, and a sibling
 * inside the folder. move_folder must treat all three differently.
 */
function linkedVault(): FixtureNote[] {
  return [
    ...sampleNotes(),
    {
      path: "projects/beta.md",
      content: "# Beta\nSibling link [[projects/alpha]] and bare [[alpha]].",
    },
    { path: "projects/assets/diagram.png", content: "PNGDATA" },
    { path: "notes/mentions.md", content: "# Mentions\nBare link to [[alpha]]." },
    {
      path: "notes/fenced.md",
      content: "# Fenced\n```\n[[projects/alpha]]\n```\nOutside: [[projects/alpha]].",
    },
  ];
}

beforeEach(async () => {
  delete process.env[GIT_SYNC_ENV];
  fx = await makeVault(linkedVault());
});
afterEach(async () => {
  delete process.env[GIT_SYNC_ENV];
  await fx.cleanup();
});

const exists = async (p: string): Promise<boolean> => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};
const inVault = (...parts: string[]) => join(fx.vaultPath, ...parts);
const readNote = (rel: string) => readFile(inVault(rel), "utf-8");

/* ------------------------------------------------------------ create_folder -- */

test("create_folder creates the directory, including missing parents", async () => {
  const result = await createFolder(fx.vaultPath, { path: "archive/2026/q3" });
  assert.equal(result.path, "archive/2026/q3");
  assert.equal(result.created, true);
  assert.ok((await stat(inVault("archive/2026/q3"))).isDirectory());
});

test("create_folder normalizes separators and trailing slashes", async () => {
  const result = await createFolder(fx.vaultPath, { path: "archive/2026/" });
  assert.equal(result.path, "archive/2026");
  assert.ok(await exists(inVault("archive/2026")));
});

test("a created folder stays invisible to list_folders until a note lands in it", async () => {
  await createFolder(fx.vaultPath, { path: "empty-shell" });
  clearIndexCache();
  const before = await listFolders(fx.vaultPath, { limit: 0 });
  assert.ok(!before.results.some((f) => f.path === "empty-shell"));

  await writeFile(inVault("empty-shell/note.md"), "# Note\n");
  clearIndexCache();
  const after = await listFolders(fx.vaultPath, { limit: 0 });
  assert.ok(after.results.some((f) => f.path === "empty-shell"));
});

test("create_folder fails loud on an existing folder or an existing file", async () => {
  await assert.rejects(
    () => createFolder(fx.vaultPath, { path: "projects" }),
    /Folder already exists: projects/
  );
  await assert.rejects(
    () => createFolder(fx.vaultPath, { path: "index.md" }),
    /A file already exists at: index\.md/
  );
});

/* ------------------------------------------------------------- path guards -- */

test("the vault root is never a valid folder operand", async () => {
  for (const path of ["", ".", "/", "   ", "//"]) {
    await assert.rejects(
      () => deleteFolder(fx.vaultPath, { path }),
      /non-empty string|vault root is not a valid operand/,
      `root operand "${path}" must be refused`
    );
  }
});

test("machinery and hidden folders are refused for every operation", async () => {
  for (const path of [".obsidian", ".git", ".trash", "node_modules", ".hidden/sub"]) {
    await assert.rejects(
      () => deleteFolder(fx.vaultPath, { path }),
      /not user folders/,
      `${path} must be refused`
    );
    await assert.rejects(() => createFolder(fx.vaultPath, { path }), /not user folders/);
    await assert.rejects(
      () => moveFolder(fx.vaultPath, { from: path, to: "elsewhere" }),
      /not user folders/
    );
    await assert.rejects(
      () => moveFolder(fx.vaultPath, { from: "projects", to: path }),
      /not user folders/
    );
  }
});

test("traversal is refused on every folder operand", async () => {
  for (const path of ["../escape", "projects/../../escape", "projects/.."]) {
    await assert.rejects(
      () => createFolder(fx.vaultPath, { path }),
      /traversal not allowed|not user folders/
    );
    await assert.rejects(
      () => deleteFolder(fx.vaultPath, { path }),
      /traversal not allowed|not user folders/
    );
  }
});

test("a file addressed as a folder is refused with a pointer to the right tool", async () => {
  await assert.rejects(
    () => deleteFolder(fx.vaultPath, { path: "index.md" }),
    /Not a folder: index\.md .*move_file or delete_note/
  );
});

test("a missing folder is a plain not-found", async () => {
  await assert.rejects(
    () => deleteFolder(fx.vaultPath, { path: "no-such-folder" }),
    /Folder not found: no-such-folder/
  );
  await assert.rejects(
    () => moveFolder(fx.vaultPath, { from: "no-such-folder", to: "x" }),
    /Folder not found: no-such-folder/
  );
});

/* -------------------------------------------------------------- move_folder -- */

test("move_folder moves every note and file under the folder", async () => {
  const result = await moveFolder(fx.vaultPath, { from: "projects", to: "archive/projects" });

  assert.equal(result.from, "projects");
  assert.equal(result.to, "archive/projects");
  assert.equal(result.moved_notes, 2); // alpha, beta
  assert.equal(result.moved_files, 1); // assets/diagram.png
  assert.equal(await exists(inVault("projects")), false);
  assert.ok(await exists(inVault("archive/projects/alpha.md")));
  assert.ok(await exists(inVault("archive/projects/assets/diagram.png")));
});

test("move_folder rewrites folder-qualified links but leaves bare basenames alone", async () => {
  const result = await moveFolder(fx.vaultPath, { from: "projects", to: "archive/projects" });

  // index.md and Beta Note.md used the full path — both rewritten.
  assert.match(await readNote("index.md"), /\[\[archive\/projects\/alpha\]\]/);
  assert.match(await readNote("Beta Note.md"), /\[\[archive\/projects\/alpha\]\]/);
  // A bare basename still names the same note after a folder move.
  assert.match(await readNote("notes/mentions.md"), /\[\[alpha\]\]/);
  assert.ok(result.updated_links >= 3);
  assert.ok(result.updated_notes >= 3);
});

test("move_folder rewrites links inside the moved notes themselves", async () => {
  await moveFolder(fx.vaultPath, { from: "projects", to: "archive/projects" });
  const beta = await readNote("archive/projects/beta.md");
  assert.match(beta, /\[\[archive\/projects\/alpha\]\]/, "sibling full-path link follows the move");
  assert.match(beta, /\[\[alpha\]\]/, "sibling bare link is untouched");
});

test("move_folder never rewrites a link inside a fenced code block", async () => {
  await moveFolder(fx.vaultPath, { from: "projects", to: "archive/projects" });
  const fenced = await readNote("notes/fenced.md");
  assert.match(fenced, /```\n\[\[projects\/alpha\]\]\n```/, "code sample stays verbatim");
  assert.match(fenced, /Outside: \[\[archive\/projects\/alpha\]\]/);
});

test("move_folder with update_links:false leaves the graph untouched", async () => {
  const result = await moveFolder(fx.vaultPath, {
    from: "projects",
    to: "archive/projects",
    update_links: false,
  });
  assert.equal(result.updated_notes, 0);
  assert.equal(result.updated_links, 0);
  assert.match(await readNote("index.md"), /\[\[projects\/alpha\]\]/);
});

test("move_folder refuses an existing destination rather than merging", async () => {
  await mkdir(inVault("archive"), { recursive: true });
  await assert.rejects(
    () => moveFolder(fx.vaultPath, { from: "projects", to: "archive" }),
    /Destination already exists: archive.*never merges/s
  );
  // Nothing moved.
  assert.ok(await exists(inVault("projects/alpha.md")));
});

test("move_folder refuses a move into its own descendant, and a no-op move", async () => {
  await assert.rejects(
    () => moveFolder(fx.vaultPath, { from: "projects", to: "projects/nested" }),
    /into its own descendant/
  );
  await assert.rejects(
    () => moveFolder(fx.vaultPath, { from: "projects", to: "projects" }),
    /same folder/
  );
});

test("move_folder renaming a leaf folder keeps sibling folders intact", async () => {
  await moveFolder(fx.vaultPath, { from: "notes", to: "reference" });
  assert.ok(await exists(inVault("reference/mentions.md")));
  assert.ok(await exists(inVault("projects/alpha.md")));
});

/* ------------------------------------------------------------ delete_folder -- */

test("delete_folder refuses a non-empty folder without recursive", async () => {
  await assert.rejects(
    () => deleteFolder(fx.vaultPath, { path: "projects" }),
    /Folder not empty: projects contains 2 note\(s\) and 1 other file\(s\)/
  );
  assert.ok(await exists(inVault("projects/alpha.md")), "nothing deleted");
});

test("delete_folder removes an empty folder without recursive", async () => {
  await createFolder(fx.vaultPath, { path: "scratch" });
  const result = await deleteFolder(fx.vaultPath, { path: "scratch" });
  assert.equal(result.deleted, true);
  assert.equal(result.deleted_notes, 0);
  assert.equal(result.deleted_files, 0);
  assert.equal(await exists(inVault("scratch")), false);
});

test("delete_folder is trash-safe by default: the subtree is recoverable", async () => {
  const result = await deleteFolder(fx.vaultPath, { path: "projects", recursive: true });

  assert.equal(result.trashed, true);
  assert.equal(result.trash_path, ".trash/projects");
  assert.equal(result.deleted_notes, 2);
  assert.equal(result.deleted_files, 1);
  assert.equal(await exists(inVault("projects")), false);
  // Every file survives under .trash, contents intact.
  assert.match(await readNote(".trash/projects/alpha.md"), /# Alpha/);
  assert.ok(await exists(inVault(".trash/projects/assets/diagram.png")));
});

test("delete_folder disambiguates a repeated trashing instead of clobbering", async () => {
  await createFolder(fx.vaultPath, { path: "scratch" });
  await writeFile(inVault("scratch/first.md"), "# First\n");
  const one = await deleteFolder(fx.vaultPath, { path: "scratch", recursive: true });
  assert.equal(one.trash_path, ".trash/scratch");

  await createFolder(fx.vaultPath, { path: "scratch" });
  await writeFile(inVault("scratch/second.md"), "# Second\n");
  const two = await deleteFolder(fx.vaultPath, { path: "scratch", recursive: true });
  assert.equal(two.trash_path, ".trash/scratch-1");

  assert.match(await readNote(".trash/scratch/first.md"), /# First/);
  assert.match(await readNote(".trash/scratch-1/second.md"), /# Second/);
});

test("delete_folder permanent:true unlinks outright, leaving no trash copy", async () => {
  const result = await deleteFolder(fx.vaultPath, {
    path: "projects",
    recursive: true,
    permanent: true,
  });
  assert.equal(result.trashed, false);
  assert.equal(result.trash_path, undefined);
  assert.equal(await exists(inVault("projects")), false);
  assert.equal(await exists(inVault(".trash/projects")), false);
});

test("delete_folder reports outside backlinks as dangled, not inside ones", async () => {
  const result = await deleteFolder(fx.vaultPath, { path: "projects", recursive: true });

  // index.md, Beta Note.md, daily/2026-07-22.md, notes/mentions.md and
  // notes/fenced.md all link into projects/ from outside.
  assert.ok(result.dangled_backlinks.includes("index"));
  assert.ok(result.dangled_backlinks.includes("Beta Note"));
  assert.ok(result.dangled_backlinks.includes("notes/mentions"));
  // projects/beta linked to projects/alpha, but both are gone — not dangling.
  assert.ok(!result.dangled_backlinks.some((p) => p.startsWith("projects/")));
  // Report-only: the linking notes are never modified.
  assert.match(await readNote("index.md"), /\[\[projects\/alpha\]\]/);
});

test("a hidden file keeps a folder non-empty, so recursive is still required", async () => {
  await createFolder(fx.vaultPath, { path: "sneaky" });
  await writeFile(inVault("sneaky/.hidden-data"), "payload");
  await assert.rejects(
    () => deleteFolder(fx.vaultPath, { path: "sneaky" }),
    /Folder not empty/,
    "an index-derived listing would have called this empty"
  );
});

/* -------------------------------------------------------------- git posture -- */

test("with sync off, every folder write returns a git_warning naming the variable", async () => {
  const created = await createFolder(fx.vaultPath, { path: "scratch" });
  const moved = await moveFolder(fx.vaultPath, { from: "notes", to: "reference" });
  const deleted = await deleteFolder(fx.vaultPath, { path: "scratch" });

  for (const [label, warning] of [
    ["create_folder", created.git_warning],
    ["move_folder", moved.git_warning],
    ["delete_folder", deleted.git_warning],
  ] as const) {
    assert.ok(warning !== null, `${label} must warn while sync is off`);
    assert.match(warning!, /OBSIDIAN_GIT_SYNC is off/);
    assert.match(warning!, /cannot be rolled back/);
    assert.match(warning!, /require_git/);
  }
});

test("the warning is report-only: the operation still happens", async () => {
  const result = await deleteFolder(fx.vaultPath, { path: "projects", recursive: true });
  assert.notEqual(result.git_warning, null);
  assert.equal(result.deleted, true);
  assert.equal(await exists(inVault("projects")), false);
});

test("require_git refuses while sync is off, before touching the filesystem", async () => {
  await assert.rejects(
    () => deleteFolder(fx.vaultPath, { path: "projects", recursive: true, require_git: true }),
    /requires git sync but OBSIDIAN_GIT_SYNC is off/
  );
  assert.ok(await exists(inVault("projects/alpha.md")), "nothing deleted");

  await assert.rejects(
    () => createFolder(fx.vaultPath, { path: "scratch", require_git: true }),
    /require_git was set/
  );
  assert.equal(await exists(inVault("scratch")), false, "nothing created");

  await assert.rejects(
    () => moveFolder(fx.vaultPath, { from: "notes", to: "reference", require_git: true }),
    /requires git sync/
  );
  assert.ok(await exists(inVault("notes/mentions.md")), "nothing moved");
});

test("with sync on in a real repo: no warning, require_git passes, changes are committed", async (t) => {
  const g = (...args: string[]) => execFileAsync("git", ["-C", fx.vaultPath, ...args]);
  try {
    await g("init", "-q");
  } catch {
    t.skip("git unavailable");
    return;
  }
  await g("config", "user.email", "t@example.com");
  await g("config", "user.name", "T");
  await g("add", "-A");
  await g("commit", "-q", "-m", "seed");

  process.env[GIT_SYNC_ENV] = "commit";

  const moved = await moveFolder(fx.vaultPath, {
    from: "projects",
    to: "archive/projects",
    require_git: true,
  });
  assert.equal(moved.git_warning, null, "an active mode leaves nothing to warn about");

  const { stdout: log } = await g("log", "--oneline", "-1");
  assert.match(log, /move_folder: projects → archive\/projects/);
  const { stdout: status } = await g("status", "--porcelain");
  assert.equal(status.trim(), "", "the move landed in a commit, working tree clean");

  const deleted = await deleteFolder(fx.vaultPath, {
    path: "archive",
    recursive: true,
    require_git: true,
  });
  assert.equal(deleted.git_warning, null);
  const { stdout: log2 } = await g("log", "--oneline", "-1");
  assert.match(log2, /delete_folder: archive \(trashed\)/);
});

test("create_folder commits nothing with sync on: git does not track empty directories", async (t) => {
  const g = (...args: string[]) => execFileAsync("git", ["-C", fx.vaultPath, ...args]);
  try {
    await g("init", "-q");
  } catch {
    t.skip("git unavailable");
    return;
  }
  await g("config", "user.email", "t@example.com");
  await g("config", "user.name", "T");
  await g("add", "-A");
  await g("commit", "-q", "-m", "seed");
  const { stdout: before } = await g("rev-parse", "HEAD");

  process.env[GIT_SYNC_ENV] = "commit";
  const result = await createFolder(fx.vaultPath, { path: "scratch", require_git: true });

  assert.equal(result.created, true);
  assert.equal(result.git_warning, null);
  assert.ok(await exists(inVault("scratch")), "the directory exists on disk");
  const { stdout: after } = await g("rev-parse", "HEAD");
  assert.equal(after.trim(), before.trim(), "no commit — an empty directory is invisible to git");
});
