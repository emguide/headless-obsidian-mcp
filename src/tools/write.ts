import { readFile, writeFile, mkdir, unlink, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveNotePath } from "./vault.js";
import { snapshotBeforeWrite } from "./git-guard.js";
import {
  NoteDocument,
  frontmatterTagList,
  addTags,
  removeTags,
  setFrontmatter,
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
  "delete_note",
  "add_tag",
  "remove_tag",
  "set_frontmatter",
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

/**
 * The single funnel every mutation passes through: resolve + path-guard the
 * target, take the pre-write git snapshot (fail-closed when enabled), then
 * write the file. Centralizing this keeps the safety guarantees in one place.
 */
async function commitWrite(
  vaultPath: string,
  notePath: string,
  content: string
): Promise<void> {
  const fullPath = resolveNotePath(vaultPath, notePath);
  await snapshotBeforeWrite(vaultPath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf-8");
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

export async function deleteNote(
  vaultPath: string,
  notePath: string
): Promise<{ path: string; deleted: boolean }> {
  const fullPath = resolveNotePath(vaultPath, notePath);
  if (!(await fileExists(fullPath))) {
    throw new Error(`Note not found: ${canonicalName(notePath)}`);
  }
  await snapshotBeforeWrite(vaultPath);
  await unlink(fullPath);
  return { path: canonicalName(notePath), deleted: true };
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
