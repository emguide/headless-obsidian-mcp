import { readFile, writeFile, mkdir, unlink, rename, stat } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import matter from "gray-matter";
import { getIndex } from "./vault-index.js";
import {
  resolveNotePath,
  resolveVaultFile,
  rewriteWikilinks,
  headingMatchesAnchor,
  parseTasks,
  statusToMarker,
  WRITABLE_TASK_STATUSES,
} from "./vault.js";
import { snapshotBeforeWrite } from "./git-guard.js";
import { linkHealthOf, LinkHealth } from "./link-health.js";
import { SetTaskStateParams, WritableTaskStatus } from "../types.js";
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
  "rename_section",
  "bulk_edit",
  "set_task_state",
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
export async function writeResolved(
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
 * `true` performs the write. Returns whether a write happened plus the note's
 * final serialized content (the written text, or the unchanged original on a
 * no-op) so callers can report the resulting note's link health.
 */
async function editNote(
  vaultPath: string,
  notePath: string,
  mutate: (doc: NoteDocument) => boolean | void
): Promise<{ changed: boolean; content: string }> {
  const raw = await readRaw(vaultPath, notePath);
  const doc = NoteDocument.parse(raw);
  const changed = mutate(doc);
  if (changed === false) return { changed: false, content: raw };
  const content = doc.serialize();
  await commitWrite(vaultPath, notePath, content);
  return { changed: true, content };
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
    finalContent = matter.stringify(content, frontmatter!);
  } else {
    validateContentFrontmatter(content);
    finalContent = content;
  }

  const fullPath = resolveNotePath(vaultPath, path);
  const existed = await fileExists(fullPath);
  if (existed && !overwrite) {
    throw new Error(
      `Note already exists: ${canonicalName(path)}. Pass overwrite:true to replace it.`
    );
  }
  await commitWrite(vaultPath, path, finalContent);
  const health = await linkHealthAfterWrite(vaultPath, path, finalContent);
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
  const fullPath = resolveNotePath(vaultPath, path);
  const existed = await fileExists(fullPath);
  if (!existed) {
    if (!create) throw new Error(`Note not found: ${canonicalName(path)}`);
    validateContentFrontmatter(content);
    const created = content.endsWith("\n") ? content : content + "\n";
    await commitWrite(vaultPath, path, created);
    const health = await linkHealthAfterWrite(vaultPath, path, created);
    return { path: canonicalName(path), created: true, ...health };
  }
  const raw = await readRaw(vaultPath, path);
  const separator = raw.length === 0 || raw.endsWith("\n") ? "" : "\n";
  const next = raw + separator + content + (content.endsWith("\n") ? "" : "\n");
  await commitWrite(vaultPath, path, next);
  const health = await linkHealthAfterWrite(vaultPath, path, next);
  return { path: canonicalName(path), created: false, ...health };
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
  const fullPath = resolveNotePath(vaultPath, path);
  const existed = await fileExists(fullPath);
  if (!existed) {
    if (!create) throw new Error(`Note not found: ${canonicalName(path)}`);
    validateContentFrontmatter(content);
    const created = content.endsWith("\n") ? content : content + "\n";
    await commitWrite(vaultPath, path, created);
    const health = await linkHealthAfterWrite(vaultPath, path, created);
    return { path: canonicalName(path), created: true, ...health };
  }
  const raw = await readRaw(vaultPath, path);
  const doc = NoteDocument.parse(raw);
  const insert = content.endsWith("\n") ? content : content + "\n";
  doc.body = insert + doc.body;
  const next = doc.serialize();
  await commitWrite(vaultPath, path, next);
  const health = await linkHealthAfterWrite(vaultPath, path, next);
  return { path: canonicalName(path), created: false, ...health };
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
): Promise<{ path: string; replacements: number } & LinkHealth> {
  if (typeof find !== "string" || find.length === 0) {
    throw new Error("find must be a non-empty string");
  }
  if (typeof replace !== "string") {
    throw new Error("replace must be a string");
  }
  const raw = await readRaw(vaultPath, path);
  const parts = raw.split(find);
  const occurrences = parts.length - 1;
  if (occurrences === 0) {
    throw new Error(`Text to patch was not found in ${canonicalName(path)}`);
  }
  // Fail loud on a non-unique match rather than silently patching the first: an
  // ambiguous find is the write most likely to hit the wrong text.
  if (!all && occurrences > 1) {
    throw new Error(
      `Text to patch occurs ${occurrences} times in ${canonicalName(path)}; ` +
        `set all:true to replace all, or make find unique`
    );
  }

  const replacements = all ? occurrences : 1;
  const next = parts.join(replace);
  await commitWrite(vaultPath, path, next);
  const health = await linkHealthAfterWrite(vaultPath, path, next);
  return { path: canonicalName(path), replacements, ...health };
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
export async function renameSectionInVault(
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

  const canon = canonicalName(path);

  // Capture backlinks + resolve the canonical note path from the pre-write index.
  // Also gates the self-anchor rewrite below: when update_anchors is false,
  // notePath is never index-resolved, so noteLower/noteBase built from it
  // would be unreliable for matching — gating avoids relying on them at all.
  let backlinks: string[] = [];
  let notePath = canon;
  if (update_anchors) {
    const index = await getIndex(vaultPath);
    notePath = index.resolve(canon) ?? canon;
    backlinks = index.backlinks(notePath);
  }
  const noteLower = notePath.toLowerCase();
  const noteBase = notePath.split("/").pop()!.toLowerCase();

  // Shared predicate: does a wikilink target (already trimmed) point at THIS
  // note? Used both for inbound backlinks (target never empty there) and for
  // the renamed note's own self-references, where an empty target denotes a
  // bare `[[#anchor]]` self-link.
  const pointsToThisNote = (target: string): boolean => {
    const norm = target.replace(/\.md$/i, "").replace(/\\/g, "/").toLowerCase();
    return norm === "" || norm === noteLower || (!norm.includes("/") && norm === noteBase);
  };

  // Rename the local heading (fails loud before any snapshot on missing/ambiguous).
  const raw = await readRaw(vaultPath, path);
  const doc = NoteDocument.parse(raw);
  const oldHeading = renameSection(doc, from, to);

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
        if (!pointsToThisNote(target)) return null;
        return headingMatchesAnchor(oldHeading, anchor) ? to.trim() : null;
      }
    );
    selfRewritten = rewritten.content;
    selfChanged = rewritten.changed;
  }

  await snapshotBeforeWrite(vaultPath);
  await writeResolved(vaultPath, path, selfRewritten);

  let updatedNotes = 0;
  // Self-anchor rewrites count toward updated_links (inbound-anchor-equivalent
  // edits), but NOT toward updated_notes — that counter means "other notes
  // touched", and the renamed note itself is always touched by definition.
  let updatedLinks = selfChanged;
  if (update_anchors && backlinks.length > 0) {
    for (const backlink of backlinks) {
      let btext: string;
      try {
        btext = await readFile(resolveNotePath(vaultPath, backlink), "utf-8");
      } catch {
        continue;
      }
      const { content, changed } = rewriteWikilinks(
        btext,
        () => null, // never change the note target
        (target, anchor) => {
          if (!pointsToThisNote(target)) return null;
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

  return { path: canon, from: oldHeading, to: to.trim(), updated_notes: updatedNotes, updated_links: updatedLinks };
}

/* -------------------------------------------------------------------- tasks -- */

/**
 * Change one checkbox task's state, rewriting only its marker character.
 * Addressing (`text` and/or `line`) and `parseTasks` both use 1-based
 * body-relative line numbers — the same convention as `list_tasks` and
 * `get_outline`. Frontmatter is stripped via gray-matter (`matter(raw).content`)
 * — the SAME stripper `list_tasks`/`get_outline` use via the shared index —
 * rather than `NoteDocument`, because `NoteDocument`'s fence regex swallows
 * trailing whitespace on the closing `---` fence into the frontmatter block
 * while gray-matter does not; on such a note the two would otherwise disagree
 * by one body line. The original frontmatter block is reattached byte-for-byte
 * by slicing it off `raw` (gray-matter's stripped body is always a suffix of
 * `raw`), matching the body-only-edit convention used by the section tools.
 */
export async function setTaskState(
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

  const canon = canonicalName(path);
  const raw = await readRaw(vaultPath, path);
  // parseTasks/`.line` operate on the frontmatter-stripped body, so both the
  // parse and the line-array edit below must use gray-matter's `body` — never
  // `raw`, and never NoteDocument's body — to match list_tasks/get_outline
  // exactly (see the fence-regex divergence note in the doc comment above).
  const body = matter(raw).content;
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
    const health = await linkHealthAfterWrite(vaultPath, path, raw);
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

  await commitWrite(vaultPath, path, next);
  const health = await linkHealthAfterWrite(vaultPath, path, next);
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
  const { changed } = await editNote(vaultPath, path, (doc) =>
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
): Promise<{ path: string; heading: string } & LinkHealth> {
  const { content: written } = await editNote(vaultPath, path, (doc) =>
    addSection(doc, heading, content ?? "", level ?? 2, after)
  );
  const health = await linkHealthAfterWrite(vaultPath, path, written);
  return { path: canonicalName(path), heading, ...health };
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
  const { content: written } = await editNote(vaultPath, path, (doc) =>
    appendToSection(doc, heading, content ?? "", create ?? false)
  );
  const health = await linkHealthAfterWrite(vaultPath, path, written);
  return { path: canonicalName(path), heading, ...health };
}

export async function replaceNoteSection(
  vaultPath: string,
  { path, heading, content }: SectionEditParams
): Promise<{ path: string; heading: string } & LinkHealth> {
  const { content: written } = await editNote(vaultPath, path, (doc) =>
    replaceSection(doc, heading, content ?? "")
  );
  const health = await linkHealthAfterWrite(vaultPath, path, written);
  return { path: canonicalName(path), heading, ...health };
}
