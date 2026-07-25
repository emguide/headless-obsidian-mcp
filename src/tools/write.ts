import { readFile, writeFile, mkdir, unlink, rename, stat } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { parseMatter, stringifyMatter } from "./matter-safe.js";
import { withVaultWriteLock } from "./write-lock.js";
import { getIndex } from "./vault-index.js";
import {
  resolveNotePath,
  resolveVaultFile,
  rewriteWikilinks,
  headingMatchesAnchor,
  parseTasks,
  statusToMarker,
  canonicalName,
  WRITABLE_TASK_STATUSES,
} from "./vault.js";
import { commitAfterWrite, commitAndSync, isGitRepo } from "./git-sync.js";
import { resolveGitSyncMode, GIT_SYNC_ENV } from "./env-flags.js";
import { linkHealthOf, LinkHealth } from "./link-health.js";
import { backlinkContext } from "./link-context.js";
import { noteNotFoundError, resolveWriteTargetAsync } from "./not-found.js";
import { SetTaskStateParams, WritableTaskStatus, LinkContextLine } from "../types.js";
import {
  NoteDocument,
  frontmatterTagList,
  addTags,
  removeTags,
  setFrontmatter,
  addPropertyValues,
  removePropertyValues,
  renameProperty,
  addSection,
  appendToSection,
  replaceSection,
  validateFrontmatterValue,
  renameSection,
} from "./note-document.js";

/**
 * Names of every tool that mutates the vault. Backs the reads/writes
 * meta-groups of the OBSIDIAN_TOOLS policy (tool-policy.ts) and the derived
 * writes_enabled config field.
 */
export const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "write_note",
  "append_note",
  "prepend_note",
  "delete_note",
  "move_note",
  "move_file",
  "create_folder",
  "move_folder",
  "delete_folder",
  "patch_note",
  "add_tag",
  "remove_tag",
  "set_frontmatter",
  "add_property_values",
  "remove_property_values",
  "rename_property",
  "add_section",
  "append_to_section",
  "replace_section",
  "rename_section",
  "bulk_edit",
  "apply_template",
  "insert_template",
  "set_task_state",
]);

/** Whether a tool name mutates the vault. */
export function isWriteTool(name: string): boolean {
  return WRITE_TOOL_NAMES.has(name);
}

async function fileExists(fullPath: string): Promise<boolean> {
  try {
    await stat(fullPath);
    return true;
  } catch {
    return false;
  }
}

/** Resolve + path-guard a note path and write it, creating parent dirs. */
export async function writeResolved(
  vaultPath: string,
  notePath: string,
  content: string
): Promise<void> {
  const fullPath = await resolveNotePath(vaultPath, notePath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf-8");
}

/**
 * Fail-closed BEFORE any filesystem change: when git sync is enabled and the
 * vault is not a usable repo, refuse the write up front so nothing lands on
 * disk (preserving the old guard's "nothing written" guarantee).
 */
export async function assertSyncableBeforeWrite(vaultPath: string): Promise<void> {
  const { mode } = resolveGitSyncMode();
  if (mode === "off") return;
  if (!(await isGitRepo(vaultPath))) {
    throw new Error(
      `${GIT_SYNC_ENV} is enabled but '${vaultPath}' is not a git repository. ` +
        `Refusing to write without a commit.`
    );
  }
}

/**
 * The post-write funnel: commit the change with a tool-derived message, then
 * (every-write mode only) pull+push. Timer mode commits only — the background
 * timer performs the remote sync.
 *
 * In every-write mode the commit and the pull/push run under a SINGLE held git
 * lock via {@link commitAndSync}, so a background timer tick (or a concurrent
 * write) can never slip between this write's commit and its push. Timer mode
 * takes the lock only for the commit (the timer owns remote sync).
 */
export async function afterWrite(vaultPath: string, message: string): Promise<void> {
  if (resolveGitSyncMode().mode === "every-write") {
    await commitAndSync(vaultPath, message);
  } else {
    await commitAfterWrite(vaultPath, message);
  }
}

/**
 * The single funnel every mutation passes through: fail-closed BEFORE any
 * filesystem change when git sync is enabled but unusable, then resolve +
 * path-guard the target, write the file, and commit the change with a
 * tool-derived message. Centralizing this keeps the safety guarantees in one
 * place. Operations that touch several files (e.g. move_note updating
 * backlinks) call {@link assertSyncableBeforeWrite} once up front, do their
 * file operations via {@link writeResolved} directly, then call
 * {@link afterWrite} once at the end.
 */
async function commitWrite(
  vaultPath: string,
  notePath: string,
  content: string,
  message: string
): Promise<void> {
  await assertSyncableBeforeWrite(vaultPath);
  await writeResolved(vaultPath, notePath, content);
  await afterWrite(vaultPath, message);
}

/**
 * Compute the resulting note's link-graph health after a content write, so a
 * write can never damage the graph silently (the report-only counterpart to
 * `delete_note`'s `dangled_backlinks`). Refreshing the index picks up any
 * newly-created target notes; the written `content` is passed straight through
 * to {@link linkHealthOf} so the just-written note is scored from exactly what
 * landed on disk rather than a possibly-stale index copy. Failures degrade to
 * an empty (graph-intact) report rather than sinking the write that succeeded.
 */
async function linkHealthAfterWrite(
  vaultPath: string,
  notePath: string,
  content: string
): Promise<LinkHealth> {
  try {
    const index = await getIndex(vaultPath);
    return linkHealthOf(index, canonicalName(notePath), content);
  } catch {
    return { unresolved_links: [], broken_anchors: [] };
  }
}

/** Read an existing note's raw text, or throw a friendly not-found error. */
export async function readRaw(vaultPath: string, notePath: string): Promise<string> {
  const resolved = await resolveWriteTargetAsync(vaultPath, notePath);
  const fullPath = await resolveNotePath(vaultPath, resolved);
  try {
    return await readFile(fullPath, "utf-8");
  } catch {
    throw await noteNotFoundError(vaultPath, resolved);
  }
}

/**
 * Load an existing note, mutate it, and write it back through the guarded
 * funnel. The mutate callback may return `false` to signal "no change", in
 * which case the write (and its git snapshot) is skipped. Returning `void` or
 * `true` performs the write. Resolves `notePath` once via
 * {@link resolveWriteTargetAsync} (bare basename / wrong-case, fail-loud on
 * ambiguity) and returns the resolved path alongside whether a write happened
 * and the note's final serialized content (the written text, or the unchanged
 * original on a no-op), so callers can echo the resolved path and report the
 * resulting note's link health from it.
 */
async function editNote(
  vaultPath: string,
  notePath: string,
  mutate: (doc: NoteDocument, resolved: string) => boolean | void,
  message: (resolved: string) => string
): Promise<{ changed: boolean; content: string; path: string }> {
  // Read, mutate and write as one critical section: a concurrent edit that
  // interleaved here would have its change silently discarded by whichever
  // write landed second.
  return withVaultWriteLock(vaultPath, async () => {
    const resolved = await resolveWriteTargetAsync(vaultPath, notePath);
    const raw = await readRaw(vaultPath, resolved);
    const doc = NoteDocument.parse(raw);
    const changed = mutate(doc, resolved);
    if (changed === false) return { changed: false, content: raw, path: resolved };
    const content = doc.serialize();
    await commitWrite(vaultPath, resolved, content, message(resolved));
    return { changed: true, content, path: resolved };
  });
}

/**
 * Validate any leading frontmatter block in a content string against the same
 * rules the dedicated frontmatter tools enforce (no nested maps, no non-scalar
 * arrays, no markdown in string values). A no-op when the content has no leading
 * frontmatter block. Throws before any write, so a rejected write takes no git
 * snapshot and makes no filesystem change. Malformed YAML surfaces as a clean
 * `Invalid frontmatter in content` error rather than a raw parser stack.
 */
function validateContentFrontmatter(content: string): void {
  let doc: NoteDocument;
  try {
    doc = NoteDocument.parse(content);
  } catch (err) {
    const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
    throw new Error(`Invalid frontmatter in content: ${msg}`);
  }
  for (const [key, value] of Object.entries(doc.data)) {
    validateFrontmatterValue(key, value);
  }
}

/* ---------------------------------------------------------------- content -- */

export interface WriteNoteParams {
  path: string;
  content: string;
  /** Allow replacing an existing note. Default false (refuse to clobber). */
  overwrite?: boolean;
  /**
   * Optional structured frontmatter. When provided (and non-empty), each field
   * is validated and the note is serialized with canonical block-style YAML;
   * `content` is then the body only. Passing this together with a frontmatter
   * block inline in `content` is an error.
   */
  frontmatter?: Record<string, unknown>;
}

export async function writeNote(
  vaultPath: string,
  { path, content, overwrite = false, frontmatter }: WriteNoteParams
): Promise<{ path: string; created: boolean } & LinkHealth> {
  if (typeof content !== "string") throw new Error("content must be a string");

  const hasFrontmatterParam =
    frontmatter != null && Object.keys(frontmatter).length > 0;
  let finalContent: string;
  if (hasFrontmatterParam) {
    // A structured param plus an inline block is ambiguous — refuse to guess.
    if (NoteDocument.hasFrontmatterFence(content)) {
      throw new Error(
        "Provide frontmatter either as the `frontmatter` parameter or inline in content, not both."
      );
    }
    for (const [key, value] of Object.entries(frontmatter!)) {
      validateFrontmatterValue(key, value);
    }
    finalContent = stringifyMatter(content, frontmatter!);
  } else {
    validateContentFrontmatter(content);
    finalContent = content;
  }

  // Exists-check and write as one critical section: two concurrent creates
  // could otherwise both see "missing" and the second clobber the first,
  // despite overwrite:false promising to refuse exactly that.
  const { existed, health } = await withVaultWriteLock(vaultPath, async () => {
    const fullPath = await resolveNotePath(vaultPath, path);
    const existedNow = await fileExists(fullPath);
    if (existedNow && !overwrite) {
      throw new Error(
        `Note already exists: ${canonicalName(path)}. Pass overwrite:true to replace it.`
      );
    }
    await commitWrite(
      vaultPath,
      path,
      finalContent,
      `write_note: ${canonicalName(path)} (${existedNow ? "overwritten" : "created"})`
    );
    return {
      existed: existedNow,
      health: await linkHealthAfterWrite(vaultPath, path, finalContent),
    };
  });
  return { path: canonicalName(path), created: !existed, ...health };
}

export interface AppendNoteParams {
  path: string;
  content: string;
  /** Create the note if it does not exist. Default false. */
  create?: boolean;
}

export async function appendNote(
  vaultPath: string,
  { path, content, create = false }: AppendNoteParams
): Promise<{ path: string; created: boolean } & LinkHealth> {
  if (typeof content !== "string") throw new Error("content must be a string");
  // Read and append as one critical section (see write-lock.ts): a concurrent
  // append that read the same `raw` would lose one of the two additions.
  return withVaultWriteLock(vaultPath, async () => {
    const fullPath = await resolveNotePath(vaultPath, path);
    const existed = await fileExists(fullPath);
    // `create:true` always targets the literal path — a bare/wrong-case name
    // must never be redirected onto a different note when the intent is to
    // create a brand new one. Only the non-create ("existing note") branch
    // resolves, since only there is redirecting to the intended note correct.
    if (!existed && create) {
      validateContentFrontmatter(content);
      const created = content.endsWith("\n") ? content : content + "\n";
      await commitWrite(vaultPath, path, created, `append_note: ${canonicalName(path)}`);
      const health = await linkHealthAfterWrite(vaultPath, path, created);
      return { path: canonicalName(path), created: true, ...health };
    }
    const resolved = await resolveWriteTargetAsync(vaultPath, path);
    const raw = await readRaw(vaultPath, resolved);
    const separator = raw.length === 0 || raw.endsWith("\n") ? "" : "\n";
    const next = raw + separator + content + (content.endsWith("\n") ? "" : "\n");
    await commitWrite(vaultPath, resolved, next, `append_note: ${resolved}`);
    const health = await linkHealthAfterWrite(vaultPath, resolved, next);
    return { path: resolved, created: false, ...health };
  });
}

export interface PrependNoteParams {
  path: string;
  content: string;
  /** Create the note if it does not exist. Default false. */
  create?: boolean;
}

/**
 * Prepend text to the start of a note's body. Any frontmatter block is
 * preserved byte-for-byte and the text is inserted after it (never before the
 * YAML fence), so the note's metadata stays intact.
 */
export async function prependNote(
  vaultPath: string,
  { path, content, create = false }: PrependNoteParams
): Promise<{ path: string; created: boolean } & LinkHealth> {
  if (typeof content !== "string") throw new Error("content must be a string");
  // Read and prepend as one critical section (see write-lock.ts).
  return withVaultWriteLock(vaultPath, async () => {
    const fullPath = await resolveNotePath(vaultPath, path);
    const existed = await fileExists(fullPath);
    // See appendNote: create:true always targets the literal path (never
    // redirected onto a different note); only the existing-note branch resolves.
    if (!existed && create) {
      validateContentFrontmatter(content);
      const created = content.endsWith("\n") ? content : content + "\n";
      await commitWrite(vaultPath, path, created, `prepend_note: ${canonicalName(path)}`);
      const health = await linkHealthAfterWrite(vaultPath, path, created);
      return { path: canonicalName(path), created: true, ...health };
    }
    const resolved = await resolveWriteTargetAsync(vaultPath, path);
    const raw = await readRaw(vaultPath, resolved);
    const doc = NoteDocument.parse(raw);
    const insert = content.endsWith("\n") ? content : content + "\n";
    doc.body = insert + doc.body;
    const next = doc.serialize();
    await commitWrite(vaultPath, resolved, next, `prepend_note: ${resolved}`);
    const health = await linkHealthAfterWrite(vaultPath, resolved, next);
    return { path: resolved, created: false, ...health };
  });
}

export interface DeleteNoteOptions {
  /** Permanently unlink the file instead of moving it to the vault's .trash. */
  permanent?: boolean;
  /**
   * Decorate each dangled backlink with the source line(s) linking to the
   * deleted note (call-time reads against the pre-delete index, where the
   * note still resolves). Opt-in; without it the rows stay bare paths.
   */
  include_context?: boolean;
}

/**
 * Delete a note. By default this is trash-safe: the note is moved to a `.trash`
 * folder inside the vault (Obsidian's convention, ignored by the index) so the
 * deletion is recoverable. Pass `permanent: true` to unlink it outright. Errors
 * if the note does not exist.
 */
/**
 * Serialized against other writes to the same vault (see write-lock.ts):
 * this operation reads before it writes, and spans several notes.
 */
export async function deleteNote(
  ...args: Parameters<typeof deleteNoteImpl>
): ReturnType<typeof deleteNoteImpl> {
  return withVaultWriteLock(args[0], () => deleteNoteImpl(...args));
}

async function deleteNoteImpl(
  vaultPath: string,
  notePath: string,
  { permanent = false, include_context = false }: DeleteNoteOptions = {}
): Promise<{
  path: string;
  deleted: boolean;
  trashed: boolean;
  trash_path?: string;
  dangled_backlinks: string[] | Array<{ path: string; context: LinkContextLine[] }>;
}> {
  const resolved = await resolveWriteTargetAsync(vaultPath, notePath);
  const fullPath = await resolveNotePath(vaultPath, resolved);
  if (!(await fileExists(fullPath))) {
    throw await noteNotFoundError(vaultPath, resolved);
  }

  // Capture backlinks from the pre-delete index before touching the filesystem,
  // so the caller learns which notes now contain a broken [[wikilink]]. Context
  // must be resolved against this pre-delete index too: after the delete the
  // note no longer resolves, so its backlink lines could not be identified.
  const index = await getIndex(vaultPath);
  const backlinkPaths = index.backlinks(canonicalName(resolved));
  const dangled_backlinks = include_context
    ? await backlinkContext(index, backlinkPaths, canonicalName(resolved))
    : backlinkPaths;

  await assertSyncableBeforeWrite(vaultPath);

  if (permanent) {
    await unlink(fullPath);
    await afterWrite(vaultPath, `delete_note: ${canonicalName(resolved)} (permanent)`);
    return { path: canonicalName(resolved), deleted: true, trashed: false, dangled_backlinks };
  }

  // Move into `.trash`, preserving the note's relative path. If a note of the
  // same name was trashed before, disambiguate with a numeric suffix rather
  // than clobbering the earlier copy.
  const canon = canonicalName(resolved);
  let trashRel = join(".trash", `${canon}.md`);
  let trashFull = await resolveVaultFile(vaultPath, trashRel);
  for (let n = 1; await fileExists(trashFull); n++) {
    trashRel = join(".trash", `${canon}-${n}.md`);
    trashFull = await resolveVaultFile(vaultPath, trashRel);
  }
  await mkdir(dirname(trashFull), { recursive: true });
  await rename(fullPath, trashFull);
  await afterWrite(vaultPath, `delete_note: ${canon} (trashed)`);
  return {
    path: canon,
    deleted: true,
    trashed: true,
    trash_path: trashRel.split(sep).join("/"),
    dangled_backlinks,
  };
}

/* -------------------------------------------------------------- move/patch -- */

export interface MoveNoteParams {
  from: string;
  to: string;
  /** Allow replacing an existing note at the destination. Default false. */
  overwrite?: boolean;
  /** Rewrite wikilinks in other notes that point to the moved note. Default true. */
  update_links?: boolean;
}

/**
 * Move or rename a note. By default every wikilink elsewhere in the vault that
 * pointed to the old location is rewritten to the new one (Obsidian's rename
 * behaviour), so the link graph is never broken. Full-path links become the new
 * full path; bare-basename links become the new basename. Refuses to overwrite
 * an existing destination unless `overwrite` is set.
 */
/**
 * Serialized against other writes to the same vault (see write-lock.ts):
 * this operation reads before it writes, and spans several notes.
 */
export async function moveNote(
  ...args: Parameters<typeof moveNoteImpl>
): ReturnType<typeof moveNoteImpl> {
  return withVaultWriteLock(args[0], () => moveNoteImpl(...args));
}

async function moveNoteImpl(
  vaultPath: string,
  { from, to, overwrite = false, update_links = true }: MoveNoteParams
): Promise<{
  from: string;
  to: string;
  overwritten: boolean;
  updated_notes: number;
  updated_links: number;
}> {
  // Resolve the source name (bare/wrong-case), failing loud on ambiguity. This
  // supersedes the previous silent shortest-path pick that the later
  // index.resolve(fromCanon) (kept below, for backlink keying) used to make.
  // The destination `to` stays literal — it addresses a create target, never
  // an existing note to redirect onto.
  const fromResolved = await resolveWriteTargetAsync(vaultPath, from);
  const fromFull = await resolveNotePath(vaultPath, fromResolved);
  const toFull = await resolveNotePath(vaultPath, to);
  const fromCanon = canonicalName(fromResolved);
  const toCanon = canonicalName(to);
  if (fromCanon === toCanon) {
    throw new Error("Source and destination are the same note");
  }
  if (!(await fileExists(fromFull))) {
    throw await noteNotFoundError(vaultPath, fromResolved);
  }
  const destExisted = await fileExists(toFull);
  if (destExisted && !overwrite) {
    throw new Error(
      `Note already exists: ${toCanon}. Pass overwrite:true to replace it.`
    );
  }

  // Capture backlinks from the pre-move index before touching the filesystem.
  // Resolve fromCanon through the index first (as rename_section does): the
  // backlink map is keyed by the note's real on-disk path, so a lookup with a
  // wrong-cased input (`projects/alpha` for `Projects/Alpha.md`) would miss the
  // key on a case-insensitive filesystem and silently rewrite zero backlinks.
  let backlinks: string[] = [];
  let resolvedFrom = fromCanon;
  // Held for the rewrite pass below, which must ask the PRE-move index what a
  // bare `[[basename]]` actually pointed at.
  let index: Awaited<ReturnType<typeof getIndex>> | null = null;
  if (update_links) {
    index = await getIndex(vaultPath);
    resolvedFrom = index.resolve(fromCanon) ?? fromCanon; // now a case-exact hit
    backlinks = index.backlinks(resolvedFrom);
  }

  await assertSyncableBeforeWrite(vaultPath);
  await mkdir(dirname(toFull), { recursive: true });
  await rename(fromFull, toFull);

  let updatedNotes = 0;
  let updatedLinks = 0;
  if (update_links && backlinks.length > 0) {
    const fromLower = resolvedFrom.toLowerCase();
    const oldBase = resolvedFrom.split("/").pop()!.toLowerCase();
    const newBase = toCanon.split("/").pop()!;
    for (const backlink of backlinks) {
      let raw: string;
      try {
        raw = await readFile(await resolveNotePath(vaultPath, backlink), "utf-8");
      } catch {
        continue; // Backlink note vanished between index and now - skip.
      }
      const { content, changed } = rewriteWikilinks(raw, (target) => {
        const norm = target.replace(/\.md$/i, "").replace(/\\/g, "/").toLowerCase();
        if (norm === fromLower) return toCanon; // full-path reference
        if (!norm.includes("/") && norm === oldBase) {
          // A bare basename is only ours if it actually RESOLVES to the moved
          // note. Another note can share the basename and own this link — with
          // `a/log` and `b/log`, a bare `[[log]]` resolves to `a/log` by the
          // shortest-path rule, so moving `b/log` must leave it alone rather
          // than silently repointing it and breaking `a/log`'s backlink.
          return index?.resolve(norm) === resolvedFrom ? newBase : null;
        }
        return null;
      });
      if (changed > 0) {
        await writeResolved(vaultPath, backlink, content);
        updatedNotes++;
        updatedLinks += changed;
      }
    }
  }

  await afterWrite(vaultPath, `move_note: ${fromCanon} → ${toCanon}`);

  return {
    from: fromCanon,
    to: toCanon,
    overwritten: destExisted,
    updated_notes: updatedNotes,
    updated_links: updatedLinks,
  };
}

export interface MoveFileParams {
  from: string;
  to: string;
  /** Allow replacing an existing file at the destination. Default false. */
  overwrite?: boolean;
}

/** Normalize a raw file path to forward slashes for stable output. */
function normalizeFilePath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

/**
 * Move or rename an arbitrary file in the vault (attachments, images, or notes
 * referenced by literal path). Unlike {@link moveNote} this treats the path
 * literally - no `.md` is appended and no wikilinks are rewritten. Refuses to
 * overwrite an existing destination unless `overwrite` is set.
 */
/**
 * Serialized against other writes to the same vault (see write-lock.ts):
 * this operation reads before it writes, and spans several notes.
 */
export async function moveFile(
  ...args: Parameters<typeof moveFileImpl>
): ReturnType<typeof moveFileImpl> {
  return withVaultWriteLock(args[0], () => moveFileImpl(...args));
}

async function moveFileImpl(
  vaultPath: string,
  { from, to, overwrite = false }: MoveFileParams
): Promise<{ from: string; to: string; overwritten: boolean }> {
  const fromFull = await resolveVaultFile(vaultPath, from);
  const toFull = await resolveVaultFile(vaultPath, to);
  if (normalizeFilePath(from) === normalizeFilePath(to)) {
    throw new Error("Source and destination are the same file");
  }
  if (!(await fileExists(fromFull))) {
    throw new Error(`File not found: ${normalizeFilePath(from)}`);
  }
  const destExisted = await fileExists(toFull);
  if (destExisted && !overwrite) {
    throw new Error(
      `File already exists: ${normalizeFilePath(to)}. Pass overwrite:true to replace it.`
    );
  }
  await assertSyncableBeforeWrite(vaultPath);
  await mkdir(dirname(toFull), { recursive: true });
  await rename(fromFull, toFull);
  await afterWrite(vaultPath, `move_file: ${normalizeFilePath(from)} → ${normalizeFilePath(to)}`);
  return {
    from: normalizeFilePath(from),
    to: normalizeFilePath(to),
    overwritten: destExisted,
  };
}

export interface PatchNoteParams {
  path: string;
  /** Exact literal text to find. */
  find: string;
  /** Replacement text. */
  replace: string;
  /** Replace every occurrence instead of only the first. Default false. */
  all?: boolean;
}

/**
 * Apply a literal find/replace patch to a note's raw text. The match is an exact
 * string (never a regex, so no injection or catastrophic-backtracking risk).
 * Replaces the first occurrence by default, or every occurrence with `all`.
 * Errors if the text to find is not present, so a stale patch fails loudly
 * rather than silently doing nothing.
 */
export async function patchNote(
  vaultPath: string,
  { path, find, replace, all = false }: PatchNoteParams
): Promise<{ path: string; replacements: number } & LinkHealth> {
  if (typeof find !== "string" || find.length === 0) {
    throw new Error("find must be a non-empty string");
  }
  if (typeof replace !== "string") {
    throw new Error("replace must be a string");
  }
  // Read, match and write as one critical section (see write-lock.ts): the
  // occurrence counts above are only meaningful against the text we then write.
  return withVaultWriteLock(vaultPath, async () => {
    const resolved = await resolveWriteTargetAsync(vaultPath, path);
    const raw = await readRaw(vaultPath, resolved);
    const parts = raw.split(find);
    const occurrences = parts.length - 1;
    if (occurrences === 0) {
      throw new Error(`Text to patch was not found in ${resolved}`);
    }
    // Fail loud on a non-unique match rather than silently patching the first: an
    // ambiguous find is the write most likely to hit the wrong text.
    if (!all && occurrences > 1) {
      throw new Error(
        `Text to patch occurs ${occurrences} times in ${resolved}; ` +
          `set all:true to replace all, or make find unique`
      );
    }

    const replacements = all ? occurrences : 1;
    const next = parts.join(replace);
    await commitWrite(vaultPath, resolved, next, `patch_note: ${resolved}`);
    const health = await linkHealthAfterWrite(vaultPath, resolved, next);
    return { path: resolved, replacements, ...health };
  });
}

export interface RenameSectionParams {
  path: string;
  from: string;
  to: string;
  /** Rewrite inbound `[[note#from]]` anchors elsewhere in the vault. Default true. */
  update_anchors?: boolean;
}

/**
 * Rename a heading in a note and (by default) rewrite every inbound
 * `[[note#oldHeading]]` anchor across the vault to the new heading — the
 * heading-level analogue of {@link moveNote}. Anchors match case-insensitively
 * (literal text, not Obsidian slugs); block refs (`#^id`) are never rewritten.
 * Fails loud on a missing or ambiguous `from` heading.
 */
/**
 * Serialized against other writes to the same vault (see write-lock.ts):
 * this operation reads before it writes, and spans several notes.
 */
export async function renameSectionInVault(
  ...args: Parameters<typeof renameSectionInVaultImpl>
): ReturnType<typeof renameSectionInVaultImpl> {
  return withVaultWriteLock(args[0], () => renameSectionInVaultImpl(...args));
}

async function renameSectionInVaultImpl(
  vaultPath: string,
  { path, from, to, update_anchors = true }: RenameSectionParams
): Promise<{
  path: string;
  from: string;
  to: string;
  updated_notes: number;
  updated_links: number;
}> {
  if (typeof from !== "string" || from.trim().length === 0) {
    throw new Error("from must be a non-empty string");
  }
  if (typeof to !== "string" || to.trim().length === 0) {
    throw new Error("to must be a non-empty string");
  }

  const resolvedPath = await resolveWriteTargetAsync(vaultPath, path);
  const canon = canonicalName(resolvedPath);

  // Capture backlinks + resolve the canonical note path from the pre-write index.
  // Also gates the self-anchor rewrite below: when update_anchors is false,
  // notePath is never index-resolved, so noteLower/noteBase built from it
  // would be unreliable for matching — gating avoids relying on them at all.
  let backlinks: string[] = [];
  let notePath = canon;
  let index: Awaited<ReturnType<typeof getIndex>> | null = null;
  if (update_anchors) {
    index = await getIndex(vaultPath);
    notePath = index.resolve(canon) ?? canon;
    backlinks = index.backlinks(notePath);
  }
  const noteLower = notePath.toLowerCase();
  const noteBase = notePath.split("/").pop()!.toLowerCase();

  // Does a wikilink target (already trimmed) point at THIS note?
  //
  // `allowEmpty` distinguishes the two callers. Inside the renamed note an
  // empty target is a bare `[[#anchor]]` self-link and IS ours; inside a
  // backlink note the very same form is that note's own self-link and is NOT
  // ours — treating it as ours rewrote unrelated notes' `[[#Heading]]` links
  // to a heading they do not have.
  //
  // A bare basename must additionally RESOLVE to this note: another note can
  // share the basename and own the link.
  const pointsToThisNote = (target: string, allowEmpty: boolean): boolean => {
    const norm = target.replace(/\.md$/i, "").replace(/\\/g, "/").toLowerCase();
    if (norm === "") return allowEmpty;
    if (norm === noteLower) return true;
    if (!norm.includes("/") && norm === noteBase) {
      return index?.resolve(norm) === notePath;
    }
    return false;
  };

  // Rename the local heading (fails loud before any snapshot on missing/ambiguous).
  const raw = await readRaw(vaultPath, resolvedPath);
  const doc = NoteDocument.parse(raw);
  const oldHeading = renameSection(doc, from, to, resolvedPath);

  // Rewrite the renamed note's OWN self-reference anchors — both the bare
  // self-link form (`[[#Old Heading]]`, empty target) and the full
  // self-reference form (`[[thenote#Old Heading]]`). The backlink graph
  // excludes self-links (see vault-index.ts), so without this the renamed
  // note's own body would keep pointing at the heading text that no longer
  // exists. This is purely additive over `rewriteWikilinks` — never touches
  // the link target, only the anchor, and only when it matches oldHeading.
  // Gated by update_anchors: false means "rename the heading only, touch no
  // anchors anywhere" — consistent, least-surprise behavior.
  let selfRewritten = doc.serialize();
  let selfChanged = 0;
  if (update_anchors) {
    const rewritten = rewriteWikilinks(
      selfRewritten,
      () => null, // never change the note target
      (target, anchor) => {
        if (!pointsToThisNote(target, true)) return null;
        return headingMatchesAnchor(oldHeading, anchor) ? to.trim() : null;
      }
    );
    selfRewritten = rewritten.content;
    selfChanged = rewritten.changed;
  }

  await assertSyncableBeforeWrite(vaultPath);
  await writeResolved(vaultPath, resolvedPath, selfRewritten);

  let updatedNotes = 0;
  // Self-anchor rewrites count toward updated_links (inbound-anchor-equivalent
  // edits), but NOT toward updated_notes — that counter means "other notes
  // touched", and the renamed note itself is always touched by definition.
  let updatedLinks = selfChanged;
  if (update_anchors && backlinks.length > 0) {
    for (const backlink of backlinks) {
      let btext: string;
      try {
        btext = await readFile(await resolveNotePath(vaultPath, backlink), "utf-8");
      } catch {
        continue;
      }
      const { content, changed } = rewriteWikilinks(
        btext,
        () => null, // never change the note target
        (target, anchor) => {
          if (!pointsToThisNote(target, false)) return null;
          return headingMatchesAnchor(oldHeading, anchor) ? to.trim() : null;
        }
      );
      if (changed > 0) {
        await writeResolved(vaultPath, backlink, content);
        updatedNotes++;
        updatedLinks += changed;
      }
    }
  }

  await afterWrite(vaultPath, `rename_section: ${canon} (${oldHeading} → ${to.trim()})`);

  return { path: canon, from: oldHeading, to: to.trim(), updated_notes: updatedNotes, updated_links: updatedLinks };
}

/* -------------------------------------------------------------------- tasks -- */

/**
 * Serialized against other writes to the same vault (see write-lock.ts): this
 * operation reads the whole note, rewrites one marker character, and writes the
 * whole note back — so a concurrent edit interleaving at the read would have its
 * change silently discarded by whichever write landed second.
 */
export async function setTaskState(
  ...args: Parameters<typeof setTaskStateImpl>
): ReturnType<typeof setTaskStateImpl> {
  return withVaultWriteLock(args[0], () => setTaskStateImpl(...args));
}

/**
 * Change one checkbox task's state, rewriting only its marker character.
 * Addressing (`text` and/or `line`) and `parseTasks` both use 1-based
 * body-relative line numbers — the same convention as `list_tasks` and
 * `get_outline`. Frontmatter is stripped via the shared safe parser (`parseMatter`)
 * — the SAME stripper `list_tasks`/`get_outline` use via the shared index —
 * rather than `NoteDocument`, because `NoteDocument`'s fence regex swallows
 * trailing whitespace on the closing `---` fence into the frontmatter block
 * while gray-matter does not; on such a note the two would otherwise disagree
 * by one body line. The original frontmatter block is reattached byte-for-byte
 * by slicing it off `raw` (gray-matter's stripped body is always a suffix of
 * `raw`), matching the body-only-edit convention used by the section tools.
 */
async function setTaskStateImpl(
  vaultPath: string,
  { path, text, line, status }: SetTaskStateParams
): Promise<{
  path: string;
  line: number;
  text: string;
  status: WritableTaskStatus;
  marker: string;
  changed: boolean;
} & LinkHealth> {
  if (!WRITABLE_TASK_STATUSES.includes(status)) {
    throw new Error(
      `status must be one of: ${WRITABLE_TASK_STATUSES.join(", ")} (got "${status}")`
    );
  }
  const hasText = typeof text === "string" && text.length > 0;
  const hasLine = typeof line === "number";
  if (!hasText && !hasLine) {
    throw new Error("Provide `text` and/or `line` to address the task");
  }
  if (hasLine && (!Number.isInteger(line) || (line as number) < 1)) {
    throw new Error("line must be a positive integer (1-based)");
  }

  const resolved = await resolveWriteTargetAsync(vaultPath, path);
  const canon = canonicalName(resolved);
  const raw = await readRaw(vaultPath, resolved);
  // parseTasks/`.line` operate on the frontmatter-stripped body, so both the
  // parse and the line-array edit below must use gray-matter's `body` — never
  // `raw`, and never NoteDocument's body — to match list_tasks/get_outline
  // exactly (see the fence-regex divergence note in the doc comment above).
  const body = parseMatter(raw).content;
  const bodyLines = body.split("\n");
  const tasks = parseTasks(body);

  // Locate the target task. parseTasks lines are 0-based; `line` is 1-based.
  let target;
  if (hasLine) {
    const zero = (line as number) - 1;
    target = tasks.find((t) => t.line === zero);
    if (!target) {
      throw new Error(`No task at line ${line} in ${canon}`);
    }
    if (hasText && target.text !== text) {
      throw new Error(
        `Task text at line ${line} does not match "${text}" in ${canon} (found "${target.text}")`
      );
    }
  } else {
    const matches = tasks.filter((t) => t.text === text);
    if (matches.length === 0) {
      throw new Error(`Task "${text}" not found in ${canon}`);
    }
    if (matches.length > 1) {
      const lines = matches.map((m) => m.line + 1).join(", ");
      throw new Error(
        `Task "${text}" occurs at lines ${lines} in ${canon}; pass \`line\` to disambiguate`
      );
    }
    target = matches[0];
  }

  const marker = statusToMarker(status);
  const oneBasedLine = target.line + 1;

  // No-op when already in the requested state — skip the write and snapshot.
  if (target.marker === marker) {
    const health = await linkHealthAfterWrite(vaultPath, resolved, raw);
    return {
      path: canon,
      line: oneBasedLine,
      text: target.text,
      status,
      marker,
      changed: false,
      ...health,
    };
  }

  // Rewrite ONLY the marker char on the target line, preserving everything else.
  const original = bodyLines[target.line];
  const rewritten = original.replace(/\[(.?)\]/, `[${marker}]`);
  bodyLines[target.line] = rewritten;
  const newBody = bodyLines.join("\n");
  // Reattach the original frontmatter block byte-for-byte: gray-matter's
  // stripped body is always a suffix of raw, so slicing off exactly its
  // length recovers the original block (including e.g. a trailing-whitespace
  // closing fence) untouched — only the target line's marker changes.
  const block = raw.slice(0, raw.length - body.length);
  const next = block + newBody;

  await commitWrite(vaultPath, resolved, next, `set_task_state: ${canon} (${status})`);
  const health = await linkHealthAfterWrite(vaultPath, resolved, next);
  return {
    path: canon,
    line: oneBasedLine,
    text: target.text,
    status,
    marker,
    changed: true,
    ...health,
  };
}

/* ------------------------------------------------------------------- tags -- */

export interface TagParams {
  path: string;
  tags: string[];
}

export async function addTag(
  vaultPath: string,
  { path, tags }: TagParams
): Promise<{ path: string; tags: string[] }> {
  if (!Array.isArray(tags) || tags.length === 0) {
    throw new Error("tags must be a non-empty array");
  }
  let resultTags: string[] = [];
  const { path: resolved } = await editNote(
    vaultPath,
    path,
    (doc) => {
      const next = addTags(doc, tags);
      resultTags = next ?? frontmatterTagList(doc.data);
      return next != null;
    },
    (resolved) => `add_tag: ${resolved}`
  );
  return { path: resolved, tags: resultTags };
}

export async function removeTag(
  vaultPath: string,
  { path, tags }: TagParams
): Promise<{ path: string; tags: string[] }> {
  if (!Array.isArray(tags) || tags.length === 0) {
    throw new Error("tags must be a non-empty array");
  }
  let resultTags: string[] = [];
  const { path: resolved } = await editNote(
    vaultPath,
    path,
    (doc) => {
      const next = removeTags(doc, tags);
      resultTags = next ?? frontmatterTagList(doc.data);
      return next != null;
    },
    (resolved) => `remove_tag: ${resolved}`
  );
  return { path: resolved, tags: resultTags };
}

/* ------------------------------------------------------------ frontmatter -- */

export interface SetFrontmatterParams {
  path: string;
  set?: Record<string, unknown>;
  unset?: string[];
}

export async function setNoteFrontmatter(
  vaultPath: string,
  { path, set, unset }: SetFrontmatterParams
): Promise<{ path: string; changed: boolean }> {
  if (!set && !unset) throw new Error("Provide `set` and/or `unset`");
  const { changed, path: resolved } = await editNote(
    vaultPath,
    path,
    (doc) => setFrontmatter(doc, set, unset),
    (resolved) => `set_frontmatter: ${resolved}`
  );
  return { path: resolved, changed };
}

/* -------------------------------------------------------------- properties -- */

export interface PropertyValuesParams {
  path: string;
  key: string;
  values: unknown[];
}

export async function addNotePropertyValues(
  vaultPath: string,
  { path, key, values }: PropertyValuesParams
): Promise<{ path: string; key: string; values: unknown[] }> {
  if (!key || typeof key !== "string") throw new Error("key must be a non-empty string");
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("values must be a non-empty array");
  }
  let result: unknown[] = [];
  const { path: resolved } = await editNote(
    vaultPath,
    path,
    (doc) => {
      const next = addPropertyValues(doc, key, values);
      const current = doc.data[key];
      result = next ?? (Array.isArray(current) ? current : current == null ? [] : [current]);
      return next != null;
    },
    (resolved) => `add_property_values: ${resolved}`
  );
  return { path: resolved, key, values: result };
}

export async function removeNotePropertyValues(
  vaultPath: string,
  { path, key, values }: PropertyValuesParams
): Promise<{ path: string; key: string; values: unknown[] }> {
  if (!key || typeof key !== "string") throw new Error("key must be a non-empty string");
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("values must be a non-empty array");
  }
  let result: unknown[] = [];
  const { path: resolved } = await editNote(
    vaultPath,
    path,
    (doc) => {
      const next = removePropertyValues(doc, key, values);
      const current = doc.data[key];
      result = next ?? (Array.isArray(current) ? current : current == null ? [] : [current]);
      return next != null;
    },
    (resolved) => `remove_property_values: ${resolved}`
  );
  return { path: resolved, key, values: result };
}

export interface RenamePropertyParams {
  path: string;
  from: string;
  to: string;
}

export async function renameNoteProperty(
  vaultPath: string,
  { path, from, to }: RenamePropertyParams
): Promise<{ path: string; from: string; to: string }> {
  if (!from || typeof from !== "string") throw new Error("from must be a non-empty string");
  if (!to || typeof to !== "string") throw new Error("to must be a non-empty string");
  const { path: resolved } = await editNote(
    vaultPath,
    path,
    (doc) => renameProperty(doc, from, to),
    (resolved) => `rename_property: ${resolved}`
  );
  return { path: resolved, from, to };
}

/* --------------------------------------------------------------- sections -- */

export interface AddSectionParams {
  path: string;
  heading: string;
  content: string;
  level?: number;
  after?: string;
}

export async function addNoteSection(
  vaultPath: string,
  { path, heading, content, level, after }: AddSectionParams
): Promise<{ path: string; heading: string } & LinkHealth> {
  const { content: written, path: resolved } = await editNote(
    vaultPath,
    path,
    (doc, resolved) => addSection(doc, heading, content ?? "", level ?? 2, after, resolved),
    (resolved) => `add_section: ${resolved}`
  );
  const health = await linkHealthAfterWrite(vaultPath, resolved, written);
  return { path: resolved, heading, ...health };
}

export interface SectionEditParams {
  path: string;
  heading: string;
  content: string;
  create?: boolean;
}

export async function appendNoteSection(
  vaultPath: string,
  { path, heading, content, create }: SectionEditParams
): Promise<{ path: string; heading: string } & LinkHealth> {
  const { content: written, path: resolved } = await editNote(
    vaultPath,
    path,
    (doc, resolved) => appendToSection(doc, heading, content ?? "", create ?? false, resolved),
    (resolved) => `append_to_section: ${resolved}`
  );
  const health = await linkHealthAfterWrite(vaultPath, resolved, written);
  return { path: resolved, heading, ...health };
}

export async function replaceNoteSection(
  vaultPath: string,
  { path, heading, content }: SectionEditParams
): Promise<{ path: string; heading: string } & LinkHealth> {
  const { content: written, path: resolved } = await editNote(
    vaultPath,
    path,
    (doc, resolved) => replaceSection(doc, heading, content ?? "", resolved),
    (resolved) => `replace_section: ${resolved}`
  );
  const health = await linkHealthAfterWrite(vaultPath, resolved, written);
  return { path: resolved, heading, ...health };
}
