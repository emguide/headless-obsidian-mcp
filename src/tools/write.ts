import { readFile, writeFile, mkdir, unlink, rename, stat } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { getIndex } from "./vault-index.js";
import { resolveNotePath, resolveVaultFile, rewriteWikilinks } from "./vault.js";
import { snapshotBeforeWrite } from "./git-guard.js";
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
} from "./note-document.js";

/**
 * Names of every tool that mutates the vault. Used by the server to gate the
 * write surface behind OBSIDIAN_ALLOW_WRITES.
 */
export const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "write_note",
  "append_note",
  "prepend_note",
  "delete_note",
  "move_note",
  "move_file",
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
]);

/** Whether a tool name mutates the vault. */
export function isWriteTool(name: string): boolean {
  return WRITE_TOOL_NAMES.has(name);
}

/** Canonical vault name for a note path (forward slashes, no .md suffix). */
function canonicalName(notePath: string): string {
  return notePath.replace(/\\/g, "/").replace(/\.md$/, "");
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
async function writeResolved(
  vaultPath: string,
  notePath: string,
  content: string
): Promise<void> {
  const fullPath = resolveNotePath(vaultPath, notePath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf-8");
}

/**
 * The single funnel every mutation passes through: take the pre-write git
 * snapshot (fail-closed when enabled), then resolve + path-guard the target and
 * write the file. Centralizing this keeps the safety guarantees in one place.
 * Operations that touch several files (e.g. move_note updating backlinks) take
 * the snapshot once and then call {@link writeResolved} directly.
 */
async function commitWrite(
  vaultPath: string,
  notePath: string,
  content: string
): Promise<void> {
  await snapshotBeforeWrite(vaultPath);
  await writeResolved(vaultPath, notePath, content);
}

/** Read an existing note's raw text, or throw a friendly not-found error. */
async function readRaw(vaultPath: string, notePath: string): Promise<string> {
  const fullPath = resolveNotePath(vaultPath, notePath);
  try {
    return await readFile(fullPath, "utf-8");
  } catch {
    throw new Error(`Note not found: ${canonicalName(notePath)}`);
  }
}

/**
 * Load an existing note, mutate it, and write it back through the guarded
 * funnel. The mutate callback may return `false` to signal "no change", in
 * which case the write (and its git snapshot) is skipped. Returning `void` or
 * `true` performs the write.
 */
async function editNote(
  vaultPath: string,
  notePath: string,
  mutate: (doc: NoteDocument) => boolean | void
): Promise<boolean> {
  const raw = await readRaw(vaultPath, notePath);
  const doc = NoteDocument.parse(raw);
  const changed = mutate(doc);
  if (changed === false) return false;
  await commitWrite(vaultPath, notePath, doc.serialize());
  return true;
}

/* ---------------------------------------------------------------- content -- */

export interface WriteNoteParams {
  path: string;
  content: string;
  /** Allow replacing an existing note. Default false (refuse to clobber). */
  overwrite?: boolean;
}

export async function writeNote(
  vaultPath: string,
  { path, content, overwrite = false }: WriteNoteParams
): Promise<{ path: string; created: boolean }> {
  if (typeof content !== "string") throw new Error("content must be a string");
  const fullPath = resolveNotePath(vaultPath, path);
  const existed = await fileExists(fullPath);
  if (existed && !overwrite) {
    throw new Error(
      `Note already exists: ${canonicalName(path)}. Pass overwrite:true to replace it.`
    );
  }
  await commitWrite(vaultPath, path, content);
  return { path: canonicalName(path), created: !existed };
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
): Promise<{ path: string; created: boolean }> {
  if (typeof content !== "string") throw new Error("content must be a string");
  const fullPath = resolveNotePath(vaultPath, path);
  const existed = await fileExists(fullPath);
  if (!existed) {
    if (!create) throw new Error(`Note not found: ${canonicalName(path)}`);
    await commitWrite(vaultPath, path, content.endsWith("\n") ? content : content + "\n");
    return { path: canonicalName(path), created: true };
  }
  const raw = await readRaw(vaultPath, path);
  const separator = raw.length === 0 || raw.endsWith("\n") ? "" : "\n";
  const next = raw + separator + content + (content.endsWith("\n") ? "" : "\n");
  await commitWrite(vaultPath, path, next);
  return { path: canonicalName(path), created: false };
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
): Promise<{ path: string; created: boolean }> {
  if (typeof content !== "string") throw new Error("content must be a string");
  const fullPath = resolveNotePath(vaultPath, path);
  const existed = await fileExists(fullPath);
  if (!existed) {
    if (!create) throw new Error(`Note not found: ${canonicalName(path)}`);
    await commitWrite(vaultPath, path, content.endsWith("\n") ? content : content + "\n");
    return { path: canonicalName(path), created: true };
  }
  const raw = await readRaw(vaultPath, path);
  const doc = NoteDocument.parse(raw);
  const insert = content.endsWith("\n") ? content : content + "\n";
  doc.body = insert + doc.body;
  await commitWrite(vaultPath, path, doc.serialize());
  return { path: canonicalName(path), created: false };
}

export interface DeleteNoteOptions {
  /** Permanently unlink the file instead of moving it to the vault's .trash. */
  permanent?: boolean;
}

/**
 * Delete a note. By default this is trash-safe: the note is moved to a `.trash`
 * folder inside the vault (Obsidian's convention, ignored by the index) so the
 * deletion is recoverable. Pass `permanent: true` to unlink it outright. Errors
 * if the note does not exist.
 */
export async function deleteNote(
  vaultPath: string,
  notePath: string,
  { permanent = false }: DeleteNoteOptions = {}
): Promise<{
  path: string;
  deleted: boolean;
  trashed: boolean;
  trash_path?: string;
  dangled_backlinks: string[];
}> {
  const fullPath = resolveNotePath(vaultPath, notePath);
  if (!(await fileExists(fullPath))) {
    throw new Error(`Note not found: ${canonicalName(notePath)}`);
  }

  // Capture backlinks from the pre-delete index before touching the filesystem,
  // so the caller learns which notes now contain a broken [[wikilink]].
  const index = await getIndex(vaultPath);
  const dangled_backlinks = index.backlinks(canonicalName(notePath));

  await snapshotBeforeWrite(vaultPath);

  if (permanent) {
    await unlink(fullPath);
    return { path: canonicalName(notePath), deleted: true, trashed: false, dangled_backlinks };
  }

  // Move into `.trash`, preserving the note's relative path. If a note of the
  // same name was trashed before, disambiguate with a numeric suffix rather
  // than clobbering the earlier copy.
  const canon = canonicalName(notePath);
  let trashRel = join(".trash", `${canon}.md`);
  let trashFull = resolveVaultFile(vaultPath, trashRel);
  for (let n = 1; await fileExists(trashFull); n++) {
    trashRel = join(".trash", `${canon}-${n}.md`);
    trashFull = resolveVaultFile(vaultPath, trashRel);
  }
  await mkdir(dirname(trashFull), { recursive: true });
  await rename(fullPath, trashFull);
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
export async function moveNote(
  vaultPath: string,
  { from, to, overwrite = false, update_links = true }: MoveNoteParams
): Promise<{
  from: string;
  to: string;
  overwritten: boolean;
  updated_notes: number;
  updated_links: number;
}> {
  const fromFull = resolveNotePath(vaultPath, from);
  const toFull = resolveNotePath(vaultPath, to);
  const fromCanon = canonicalName(from);
  const toCanon = canonicalName(to);
  if (fromCanon === toCanon) {
    throw new Error("Source and destination are the same note");
  }
  if (!(await fileExists(fromFull))) {
    throw new Error(`Note not found: ${fromCanon}`);
  }
  const destExisted = await fileExists(toFull);
  if (destExisted && !overwrite) {
    throw new Error(
      `Note already exists: ${toCanon}. Pass overwrite:true to replace it.`
    );
  }

  // Capture backlinks from the pre-move index before touching the filesystem.
  let backlinks: string[] = [];
  if (update_links) {
    const index = await getIndex(vaultPath);
    backlinks = index.backlinks(fromCanon);
  }

  await snapshotBeforeWrite(vaultPath);
  await mkdir(dirname(toFull), { recursive: true });
  await rename(fromFull, toFull);

  let updatedNotes = 0;
  let updatedLinks = 0;
  if (update_links && backlinks.length > 0) {
    const fromLower = fromCanon.toLowerCase();
    const oldBase = fromCanon.split("/").pop()!.toLowerCase();
    const newBase = toCanon.split("/").pop()!;
    for (const backlink of backlinks) {
      let raw: string;
      try {
        raw = await readFile(resolveNotePath(vaultPath, backlink), "utf-8");
      } catch {
        continue; // Backlink note vanished between index and now - skip.
      }
      const { content, changed } = rewriteWikilinks(raw, (target) => {
        const norm = target.replace(/\.md$/i, "").replace(/\\/g, "/").toLowerCase();
        if (norm === fromLower) return toCanon; // full-path reference
        if (!norm.includes("/") && norm === oldBase) return newBase; // basename reference
        return null;
      });
      if (changed > 0) {
        await writeResolved(vaultPath, backlink, content);
        updatedNotes++;
        updatedLinks += changed;
      }
    }
  }

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
export async function moveFile(
  vaultPath: string,
  { from, to, overwrite = false }: MoveFileParams
): Promise<{ from: string; to: string; overwritten: boolean }> {
  const fromFull = resolveVaultFile(vaultPath, from);
  const toFull = resolveVaultFile(vaultPath, to);
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
  await snapshotBeforeWrite(vaultPath);
  await mkdir(dirname(toFull), { recursive: true });
  await rename(fromFull, toFull);
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
): Promise<{ path: string; replacements: number }> {
  if (typeof find !== "string" || find.length === 0) {
    throw new Error("find must be a non-empty string");
  }
  if (typeof replace !== "string") {
    throw new Error("replace must be a string");
  }
  const raw = await readRaw(vaultPath, path);
  if (!raw.includes(find)) {
    throw new Error(`Text to patch was not found in ${canonicalName(path)}`);
  }

  let next: string;
  let replacements: number;
  if (all) {
    const parts = raw.split(find);
    replacements = parts.length - 1;
    next = parts.join(replace);
  } else {
    replacements = 1;
    const idx = raw.indexOf(find);
    next = raw.slice(0, idx) + replace + raw.slice(idx + find.length);
  }
  await commitWrite(vaultPath, path, next);
  return { path: canonicalName(path), replacements };
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
  await editNote(vaultPath, path, (doc) => {
    const next = addTags(doc, tags);
    resultTags = next ?? frontmatterTagList(doc.data);
    return next != null;
  });
  return { path: canonicalName(path), tags: resultTags };
}

export async function removeTag(
  vaultPath: string,
  { path, tags }: TagParams
): Promise<{ path: string; tags: string[] }> {
  if (!Array.isArray(tags) || tags.length === 0) {
    throw new Error("tags must be a non-empty array");
  }
  let resultTags: string[] = [];
  await editNote(vaultPath, path, (doc) => {
    const next = removeTags(doc, tags);
    resultTags = next ?? frontmatterTagList(doc.data);
    return next != null;
  });
  return { path: canonicalName(path), tags: resultTags };
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
  const changed = await editNote(vaultPath, path, (doc) =>
    setFrontmatter(doc, set, unset)
  );
  return { path: canonicalName(path), changed };
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
  await editNote(vaultPath, path, (doc) => {
    const next = addPropertyValues(doc, key, values);
    const current = doc.data[key];
    result = next ?? (Array.isArray(current) ? current : current == null ? [] : [current]);
    return next != null;
  });
  return { path: canonicalName(path), key, values: result };
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
  await editNote(vaultPath, path, (doc) => {
    const next = removePropertyValues(doc, key, values);
    const current = doc.data[key];
    result = next ?? (Array.isArray(current) ? current : current == null ? [] : [current]);
    return next != null;
  });
  return { path: canonicalName(path), key, values: result };
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
  await editNote(vaultPath, path, (doc) => renameProperty(doc, from, to));
  return { path: canonicalName(path), from, to };
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
): Promise<{ path: string; heading: string }> {
  await editNote(vaultPath, path, (doc) =>
    addSection(doc, heading, content ?? "", level ?? 2, after)
  );
  return { path: canonicalName(path), heading };
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
): Promise<{ path: string; heading: string }> {
  await editNote(vaultPath, path, (doc) =>
    appendToSection(doc, heading, content ?? "", create ?? false)
  );
  return { path: canonicalName(path), heading };
}

export async function replaceNoteSection(
  vaultPath: string,
  { path, heading, content }: SectionEditParams
): Promise<{ path: string; heading: string }> {
  await editNote(vaultPath, path, (doc) =>
    replaceSection(doc, heading, content ?? "")
  );
  return { path: canonicalName(path), heading };
}
