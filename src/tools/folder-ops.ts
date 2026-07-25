import { mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { getIndex } from "./vault-index.js";
import {
  IGNORED_DIRS,
  canonicalName,
  resolveNotePath,
  resolveVaultFile,
  rewriteWikilinks,
} from "./vault.js";
import { withVaultWriteLock } from "./write-lock.js";
import { afterWrite, assertSyncableBeforeWrite, writeResolved } from "./write.js";
import { GIT_SYNC_ENV, resolveGitSyncMode } from "./env-flags.js";
import {
  CreateFolderParams,
  CreateFolderResult,
  DeleteFolderParams,
  DeleteFolderResult,
  MoveFolderParams,
  MoveFolderResult,
} from "../types.js";

/**
 * Folder-level CRUD. The read side is `list_folders` (folders.ts); this module
 * is the write side — create, move/rename, and delete.
 *
 * Folders are *implicit* in the vault model: `list_folders` derives them from
 * indexed note paths, so a directory holding no notes has no row there. These
 * tools operate on real directories on disk, which is why `create_folder` can
 * succeed and still leave `list_folders` unchanged until a note lands inside.
 *
 * Every operation here has an unbounded blast radius — one call can move or
 * delete an arbitrary subtree — so each reports {@link gitWarning} when
 * `OBSIDIAN_GIT_SYNC` is off (report-only: the operation still runs), and each
 * accepts `require_git` to escalate that warning into a refusal made before any
 * filesystem change.
 */

/* ------------------------------------------------------------- git posture -- */

/**
 * The report-only half of the git posture: with sync off, a folder operation
 * leaves no snapshot to roll back to. Returns null whenever a mode is active,
 * so a non-null `git_warning` always means "this was not recorded anywhere".
 */
function gitWarning(operation: string, scope: string): string | null {
  if (resolveGitSyncMode().mode !== "off") return null;
  return (
    `${GIT_SYNC_ENV} is off: ${operation} on '${scope}' was not snapshotted to git and ` +
    `cannot be rolled back. Set ${GIT_SYNC_ENV}=commit (or every-write/timer) to snapshot ` +
    `folder changes, or pass require_git:true to refuse them while sync is off.`
  );
}

/**
 * The fail-loud half: refuse before touching the filesystem when the caller
 * demanded a snapshot and there is no sync mode to provide one. Only the mode
 * is checked here — a mode that IS set but whose repo is unusable is caught by
 * {@link assertSyncableBeforeWrite}, which every operation calls anyway.
 */
function assertGitRequired(requireGit: boolean, operation: string): void {
  if (!requireGit) return;
  if (resolveGitSyncMode().mode === "off") {
    throw new Error(
      `${operation} requires git sync but ${GIT_SYNC_ENV} is off (require_git was set). ` +
        `Set ${GIT_SYNC_ENV}=commit (or every-write/timer), or drop require_git to proceed ` +
        `with a warning instead.`
    );
  }
}

/* ------------------------------------------------------------- path guards -- */

/**
 * Normalize and validate a user-supplied folder path. Beyond the traversal and
 * symlink guards every path gets from {@link resolveVaultFile}, folders carry
 * two refusals of their own: the vault root itself is never an operand (a
 * `delete_folder` of `""` would be a vault wipe), and neither are the machinery
 * directories the index deliberately ignores — `.obsidian` holds the vault's
 * configuration and `.git` its history, so a rename there breaks the tooling
 * the rest of this server depends on.
 */
function normalizeFolder(input: string, label: string): string {
  if (!input || typeof input !== "string") {
    throw new Error(`${label} must be a non-empty string`);
  }
  const cleaned = input.trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (cleaned === "" || cleaned === ".") {
    throw new Error(
      `${label} must name a folder inside the vault; the vault root is not a valid operand.`
    );
  }
  const segments = cleaned.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) {
    throw new Error("Invalid folder path: path traversal not allowed");
  }
  const first = segments[0];
  if (IGNORED_DIRS.has(first) || first.startsWith(".")) {
    throw new Error(
      `Refusing to operate on '${first}': hidden and machinery folders ` +
        `(${[...IGNORED_DIRS].sort().join(", ")}) are not user folders.`
    );
  }
  return cleaned;
}

async function pathExists(fullPath: string): Promise<boolean> {
  try {
    await stat(fullPath);
    return true;
  } catch {
    return false;
  }
}

/** Require an existing directory, distinguishing "missing" from "not a folder". */
async function assertDirectory(fullPath: string, folder: string): Promise<void> {
  let info;
  try {
    info = await stat(fullPath);
  } catch {
    throw new Error(`Folder not found: ${folder}`);
  }
  if (!info.isDirectory()) {
    throw new Error(`Not a folder: ${folder} (it is a file — use move_file or delete_note)`);
  }
}

/** Notes (canonical, no `.md`) and other files physically under a folder. */
interface FolderContents {
  notes: string[];
  files: string[];
}

/**
 * Every file under `folder`, walked from disk rather than the index.
 *
 * The index skips hidden and machinery directories, so an index-derived listing
 * would report a folder as empty when it still holds hidden data — and
 * `delete_folder`'s non-recursive guard would then wave through a subtree it
 * had never actually looked at. A symlinked directory is not descended into
 * (`isDirectory()` is false for a symlink), so it counts as a single file.
 */
async function collectContents(vaultPath: string, folder: string): Promise<FolderContents> {
  const notes: string[] = [];
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // Unreadable subdirectory — skip rather than fail the whole walk.
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      const rel = relative(vaultPath, full).split(sep).join("/");
      if (entry.name.toLowerCase().endsWith(".md")) notes.push(canonicalName(rel));
      else files.push(rel);
    }
  }

  await walk(join(vaultPath, folder));
  notes.sort((a, b) => a.localeCompare(b));
  files.sort((a, b) => a.localeCompare(b));
  return { notes, files };
}

/** Is `child` the folder itself, or nested under it? */
function isUnder(child: string, folder: string): boolean {
  return child === folder || child.startsWith(folder + "/");
}

/* ----------------------------------------------------------- create_folder -- */

/**
 * Create a folder (and any missing parents).
 *
 * Two honest limits follow from folders being implicit. The new folder holds no
 * notes, so `list_folders` will not show it until one lands there; and git does
 * not track empty directories, so with sync enabled this operation commits
 * nothing (`commitAfterWrite` no-ops on a clean index) rather than failing.
 * Fails loud when anything already exists at the path — a create that silently
 * succeeded on an existing folder would hide a typo in the path.
 */
export async function createFolder(
  ...args: Parameters<typeof createFolderImpl>
): ReturnType<typeof createFolderImpl> {
  return withVaultWriteLock(args[0], () => createFolderImpl(...args));
}

async function createFolderImpl(
  vaultPath: string,
  { path, require_git = false }: CreateFolderParams
): Promise<CreateFolderResult> {
  const folder = normalizeFolder(path, "path");
  const full = await resolveVaultFile(vaultPath, folder);
  assertGitRequired(require_git, "create_folder");

  if (await pathExists(full)) {
    const info = await stat(full);
    throw new Error(
      info.isDirectory()
        ? `Folder already exists: ${folder}`
        : `A file already exists at: ${folder}`
    );
  }

  await assertSyncableBeforeWrite(vaultPath);
  await mkdir(full, { recursive: true });
  await afterWrite(vaultPath, `create_folder: ${folder}`);

  return { path: folder, created: true, git_warning: gitWarning("create_folder", folder) };
}

/* ------------------------------------------------------------- move_folder -- */

/**
 * Move or rename a folder and everything under it, rewriting the wikilinks that
 * pointed into it — the folder-level analogue of `move_note`.
 *
 * Only **full-path** links (`[[projects/alpha]]`) are rewritten, because a
 * folder move preserves every basename: `[[alpha]]` still names the same note
 * afterwards. The one exception is a bare link whose shortest-path winner the
 * move changes (two notes sharing a basename, one of them moving nearer the
 * root); Obsidian re-resolves such a link the same way, so it is left alone
 * here too rather than pinned to one side.
 *
 * There is no `overwrite`: merging two subtrees is not a rename, and silently
 * clobbering a destination tree is not something a single flag should buy.
 */
export async function moveFolder(
  ...args: Parameters<typeof moveFolderImpl>
): ReturnType<typeof moveFolderImpl> {
  return withVaultWriteLock(args[0], () => moveFolderImpl(...args));
}

async function moveFolderImpl(
  vaultPath: string,
  { from, to, update_links = true, require_git = false }: MoveFolderParams
): Promise<MoveFolderResult> {
  const fromFolder = normalizeFolder(from, "from");
  const toFolder = normalizeFolder(to, "to");
  assertGitRequired(require_git, "move_folder");

  if (fromFolder === toFolder) {
    throw new Error("Source and destination are the same folder");
  }
  if (isUnder(toFolder, fromFolder)) {
    throw new Error(
      `Cannot move '${fromFolder}' into its own descendant '${toFolder}'.`
    );
  }

  const fromFull = await resolveVaultFile(vaultPath, fromFolder);
  const toFull = await resolveVaultFile(vaultPath, toFolder);
  await assertDirectory(fromFull, fromFolder);
  if (await pathExists(toFull)) {
    throw new Error(
      `Destination already exists: ${toFolder}. move_folder never merges or ` +
        `overwrites a destination tree — pick a new name, or move the contents note by note.`
    );
  }

  const { notes, files } = await collectContents(vaultPath, fromFolder);

  /** Where a path under `from` lands after the move. */
  const remap = (p: string): string => toFolder + p.slice(fromFolder.length);

  // Capture the pre-move index: after the rename the old paths resolve to
  // nothing, so both the backlink lookup and the rewrite map must be built now.
  let sources: string[] = [];
  const renames = new Map<string, string>(); // lowercased old canonical -> new canonical
  if (update_links) {
    const index = await getIndex(vaultPath);
    const seen = new Set<string>();
    for (const note of notes) {
      renames.set(note.toLowerCase(), remap(note));
      // The backlink map is keyed by the note's real on-disk path, so resolve
      // through the index first (same reason move_note does).
      const resolved = index.resolve(note) ?? note;
      for (const source of index.backlinks(resolved)) seen.add(source);
    }
    sources = [...seen].sort((a, b) => a.localeCompare(b));
  }

  await assertSyncableBeforeWrite(vaultPath);
  await mkdir(dirname(toFull), { recursive: true });
  await rename(fromFull, toFull);

  let updatedNotes = 0;
  let updatedLinks = 0;
  if (update_links && renames.size > 0) {
    for (const source of sources) {
      // A source inside the moved folder has itself moved: read it where it is
      // now, not where the pre-move index recorded it.
      const current = isUnder(source, fromFolder) ? remap(source) : source;
      let raw: string;
      try {
        raw = await readFile(await resolveNotePath(vaultPath, current), "utf-8");
      } catch {
        continue; // Source vanished between index and now — skip.
      }
      const { content, changed } = rewriteWikilinks(raw, (target) => {
        const norm = target.replace(/\.md$/i, "").replace(/\\/g, "/").toLowerCase();
        // A bare basename survives a folder move untouched; only a
        // folder-qualified reference names a path that no longer exists.
        if (!norm.includes("/")) return null;
        return renames.get(norm) ?? null;
      });
      if (changed > 0) {
        await writeResolved(vaultPath, current, content);
        updatedNotes++;
        updatedLinks += changed;
      }
    }
  }

  await afterWrite(vaultPath, `move_folder: ${fromFolder} → ${toFolder}`);

  return {
    from: fromFolder,
    to: toFolder,
    moved_notes: notes.length,
    moved_files: files.length,
    updated_notes: updatedNotes,
    updated_links: updatedLinks,
    git_warning: gitWarning("move_folder", `${fromFolder} → ${toFolder}`),
  };
}

/* ----------------------------------------------------------- delete_folder -- */

/**
 * Delete a folder and everything under it. Trash-safe by default (the subtree
 * is moved into the vault's `.trash`, Obsidian's convention and ignored by the
 * index) so the deletion stays recoverable; `permanent: true` unlinks outright.
 *
 * A non-empty folder is refused unless `recursive: true` — this is the only
 * tool on the surface whose blast radius is not bounded by an explicit list of
 * paths, so the caller states the intent to delete contents rather than
 * discovering it afterwards.
 *
 * `dangled_backlinks` reports notes *outside* the folder that linked to notes
 * *inside* it and now have a broken `[[wikilink]]`. Report-only, exactly as
 * `delete_note`'s field of the same name: those notes are never modified.
 */
export async function deleteFolder(
  ...args: Parameters<typeof deleteFolderImpl>
): ReturnType<typeof deleteFolderImpl> {
  return withVaultWriteLock(args[0], () => deleteFolderImpl(...args));
}

async function deleteFolderImpl(
  vaultPath: string,
  { path, recursive = false, permanent = false, require_git = false }: DeleteFolderParams
): Promise<DeleteFolderResult> {
  const folder = normalizeFolder(path, "path");
  assertGitRequired(require_git, "delete_folder");

  const full = await resolveVaultFile(vaultPath, folder);
  await assertDirectory(full, folder);

  const { notes, files } = await collectContents(vaultPath, folder);
  if (!recursive && notes.length + files.length > 0) {
    throw new Error(
      `Folder not empty: ${folder} contains ${notes.length} note(s) and ` +
        `${files.length} other file(s). Pass recursive:true to delete it and everything under it.`
    );
  }

  // Backlinks from the pre-delete index, before anything leaves the filesystem.
  // A link from one deleted note to another is not dangling — both are going —
  // so sources inside the folder are excluded.
  const index = await getIndex(vaultPath);
  const dangled = new Set<string>();
  for (const note of notes) {
    const resolved = index.resolve(note) ?? note;
    for (const source of index.backlinks(resolved)) {
      if (!isUnder(source, folder)) dangled.add(source);
    }
  }

  await assertSyncableBeforeWrite(vaultPath);

  let trashPath: string | undefined;
  if (permanent) {
    await rm(full, { recursive: true, force: true });
  } else {
    // Preserve the folder's relative path inside `.trash`, disambiguating a
    // repeated trashing of the same folder rather than clobbering the earlier
    // copy (same scheme as delete_note).
    let rel = join(".trash", folder);
    let dest = await resolveVaultFile(vaultPath, rel);
    for (let n = 1; await pathExists(dest); n++) {
      rel = join(".trash", `${folder}-${n}`);
      dest = await resolveVaultFile(vaultPath, rel);
    }
    await mkdir(dirname(dest), { recursive: true });
    await rename(full, dest);
    trashPath = rel.split(sep).join("/");
  }

  await afterWrite(
    vaultPath,
    `delete_folder: ${folder} (${permanent ? "permanent" : "trashed"})`
  );

  return {
    path: folder,
    deleted: true,
    trashed: !permanent,
    ...(trashPath !== undefined ? { trash_path: trashPath } : {}),
    deleted_notes: notes.length,
    deleted_files: files.length,
    dangled_backlinks: [...dangled].sort((a, b) => a.localeCompare(b)),
    git_warning: gitWarning("delete_folder", folder),
  };
}
