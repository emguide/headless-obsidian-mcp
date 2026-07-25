import { readdir, stat, realpath } from "node:fs/promises";
import { join, resolve, relative, sep, dirname, isAbsolute } from "node:path";
import { ParsedHeading, ParsedTask, TaskStatus, WritableTaskStatus } from "../types.js";

/**
 * A markdown file discovered in the vault, with lightweight filesystem
 * metadata but without its contents read.
 */
export interface VaultFile {
  /** Relative path from the vault root, without the `.md` suffix, using "/" separators. */
  path: string;
  /** Absolute path on disk. */
  fullPath: string;
  /** File size in bytes. */
  size: number;
  /** Last modified time. */
  mtime: Date;
}

// Directories that are part of Obsidian's machinery or version control rather
// than user notes. These are skipped entirely when walking the vault.
const IGNORED_DIRS = new Set([
  ".obsidian",
  ".trash",
  ".git",
  "node_modules",
]);

/** Throw if the vault path is not a usable string. */
export function assertVaultPath(vaultPath: string): void {
  if (!vaultPath || typeof vaultPath !== "string") {
    throw new Error("Vault path must be a non-empty string");
  }
}

/**
 * Resolve a user-supplied note path to an absolute path inside the vault,
 * guarding against path-traversal escapes. Mirrors the checks used by
 * read_notes so every tool that resolves a path behaves identically.
 */
export async function resolveNotePath(
  vaultPath: string,
  notePath: string
): Promise<string> {
  if (!notePath || typeof notePath !== "string") {
    throw new Error("Note path must be a non-empty string");
  }
  const resolvedVault = resolve(vaultPath);
  const fileName = `${notePath}${notePath.endsWith(".md") ? "" : ".md"}`;
  const fullPath = resolve(join(vaultPath, fileName));
  const relativePath = relative(resolvedVault, fullPath);
  if (relativePath.startsWith("..") || relativePath.includes(".." + sep)) {
    throw new Error("Invalid note path: path traversal not allowed");
  }
  await assertNoSymlinkEscape(resolvedVault, fullPath, "note");
  return fullPath;
}

/** Cache of vault root -> its realpath; the root does not move mid-process. */
const realVaultCache = new Map<string, string>();

async function realVaultRoot(resolvedVault: string): Promise<string> {
  const cached = realVaultCache.get(resolvedVault);
  if (cached !== undefined) return cached;
  let real: string;
  try {
    real = await realpath(resolvedVault);
  } catch {
    // Vault root missing or unreadable: nothing to resolve against, so leave
    // the lexical guard as the only check rather than failing every call.
    real = resolvedVault;
  }
  realVaultCache.set(resolvedVault, real);
  return real;
}

/**
 * Reject a path that leaves the vault through a symlink.
 *
 * The lexical checks above normalize `..` away, but they only ever see the
 * requested name — a symlink `secret.md -> /etc/passwd` inside the vault has no
 * `..` in it, so `relative()` sees `secret.md` and the guard passed. Readers
 * then returned the target's contents and writers clobbered it, defeating the
 * path-traversal guarantee the tools advertise.
 *
 * Resolve the deepest existing ancestor of the target (the target itself when
 * it exists) and require it to stay under the vault's own realpath. The
 * not-yet-existing remainder cannot contain a symlink, and its `..` segments
 * were already rejected, so checking that ancestor is sufficient.
 */
async function assertNoSymlinkEscape(
  resolvedVault: string,
  fullPath: string,
  kind: "note" | "file"
): Promise<void> {
  const realRoot = await realVaultRoot(resolvedVault);

  let probe = fullPath;
  for (;;) {
    try {
      const real = await realpath(probe);
      const rel = relative(realRoot, real);
      if (rel !== "" && (rel.startsWith("..") || rel.includes(".." + sep) || isAbsolute(rel))) {
        throw new Error(
          `Invalid ${kind} path: path traversal not allowed (symlink escapes the vault)`
        );
      }
      return;
    } catch (err) {
      if (err instanceof Error && err.message.includes("path traversal not allowed")) {
        throw err;
      }
      // Does not exist yet — check its parent instead.
      const parent = dirname(probe);
      if (parent === probe) return; // reached the filesystem root
      probe = parent;
    }
  }
}

/**
 * Canonical vault name for a note path: forward slashes, no `.md` suffix — the
 * same identity field the header tools report. The single shared definition,
 * imported by the write tools and the property/bulk readers.
 */
export function canonicalName(notePath: string): string {
  return notePath.replace(/\\/g, "/").replace(/\.md$/, "");
}

/**
 * Resolve a user-supplied path (any file, not just a note) to an absolute path
 * inside the vault, guarding against path-traversal escapes. Unlike
 * {@link resolveNotePath} this does not append a `.md` suffix, so it is used for
 * attachments and for the `.trash` folder when trashing a note.
 */
export async function resolveVaultFile(
  vaultPath: string,
  filePath: string
): Promise<string> {
  if (!filePath || typeof filePath !== "string") {
    throw new Error("File path must be a non-empty string");
  }
  const resolvedVault = resolve(vaultPath);
  const fullPath = resolve(join(vaultPath, filePath));
  const relativePath = relative(resolvedVault, fullPath);
  if (relativePath.startsWith("..") || relativePath.includes(".." + sep)) {
    throw new Error("Invalid file path: path traversal not allowed");
  }
  await assertNoSymlinkEscape(resolvedVault, fullPath, "file");
  return fullPath;
}

/**
 * Recursively walk the vault and return every markdown file, skipping hidden
 * and machinery directories. Filesystem metadata is collected but file
 * contents are not read. Results are sorted by path for deterministic output.
 */
export async function walkVault(
  vaultPath: string,
  keep: (name: string) => boolean = (name) => name.endsWith(".md")
): Promise<VaultFile[]> {
  assertVaultPath(vaultPath);
  const resolvedVault = resolve(vaultPath);
  const results: VaultFile[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // Unreadable directory - skip rather than fail the whole walk.
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name)) {
          continue;
        }
        await walk(join(dir, entry.name));
      } else if (entry.isFile() && keep(entry.name)) {
        const full = join(dir, entry.name);
        let info;
        try {
          info = await stat(full);
        } catch {
          continue;
        }
        // Markdown callers want the .md stripped (existing behavior); other
        // callers want the literal path. Strip only for .md files.
        const rel = relative(resolvedVault, full).split(sep).join("/");
        const path = entry.name.endsWith(".md") ? rel.replace(/\.md$/, "") : rel;
        results.push({ path, fullPath: full, size: info.size, mtime: info.mtime });
      }
    }
  }

  await walk(resolvedVault);
  results.sort((a, b) => a.path.localeCompare(b.path));
  return results;
}

/**
 * Extract inline Obsidian tags (`#tag`, including nested `#parent/child`).
 * Requires no whitespace after `#` so markdown headings (`# Heading`) are not
 * matched as tags.
 */
export function extractInlineTags(content: string): string[] {
  const tags = new Set<string>();
  const regex = /(?:^|[^\w`])#([A-Za-z][\w-]*(?:\/[\w-]+)*)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    tags.add(match[1]);
  }
  return [...tags];
}

/**
 * Normalize a frontmatter `tags`/`tag` value (array or delimited string) to a
 * list. The single shared reader for the frontmatter tag list — imported by
 * note-document.ts (and, through it, the write tools) so the read and write
 * sides never disagree on what counts as a frontmatter tag.
 */
export function frontmatterTagList(data: Record<string, unknown>): string[] {
  const raw = data.tags ?? data.tag;
  if (raw == null) return [];
  const list = Array.isArray(raw) ? raw : String(raw).split(/[,\s]+/);
  return list
    .map((t) => String(t).trim().replace(/^#/, ""))
    .filter((t) => t.length > 0);
}

/**
 * Collect the complete tag set for a note, unifying frontmatter `tags:`
 * (which an inline-only extractor misses) with inline `#tags`.
 */
export function collectTags(
  frontmatter: Record<string, unknown>,
  content: string
): string[] {
  const tags = new Set<string>([
    ...frontmatterTagList(frontmatter),
    ...extractInlineTags(content),
  ]);
  return [...tags].sort((a, b) => a.localeCompare(b));
}

// Matches Obsidian wikilinks and embeds: [[target]], [[target|alias]],
// [[target#heading]], ![[target]]. Captures the inner reference.
const WIKILINK_RE = /!?\[\[([^\]]+)\]\]/g;

/**
 * Character ranges covered by fenced code blocks, so wikilink handling can skip
 * them the way {@link parseHeadings} and {@link parseTasks} already do. Obsidian
 * ignores links inside code blocks; counting them produced phantom backlinks and
 * permanent false `unresolved_links` findings for notes that merely *document*
 * link syntax — findings no edit outside the fence could clear.
 *
 * Ranges rather than line flags, so a wikilink's match offset can be tested
 * without changing the regex's existing (newline-tolerant) matching.
 */
function fencedRanges(content: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let offset = 0;
  let inFence = false;
  let fenceChar = "";
  let start = 0;
  for (const line of content.split("\n")) {
    const lineStart = offset;
    const lineEnd = offset + line.length + 1; // include the newline
    const marker = line.match(/^\s*(```+|~~~+)/);
    if (marker) {
      const char = marker[1][0];
      if (!inFence) {
        inFence = true;
        fenceChar = char;
        start = lineStart;
      } else if (char === fenceChar) {
        inFence = false;
        ranges.push([start, lineEnd]);
      }
    }
    offset = lineEnd;
  }
  if (inFence) ranges.push([start, offset]); // unterminated fence runs to EOF
  return ranges;
}

/** Is `index` inside one of `ranges`? */
function insideFence(ranges: Array<[number, number]>, index: number): boolean {
  return ranges.some(([from, to]) => index >= from && index < to);
}

/** Reduce a raw wikilink body to just its note target (drop alias + heading). */
function linkTarget(inner: string): string {
  // Strip display alias after "|", then any "#heading" / "#^block" anchor.
  const noAlias = inner.split("|")[0];
  const noAnchor = noAlias.split("#")[0];
  return noAnchor.trim();
}

/** Extract all wikilink targets (alias/anchor stripped) from note content. */
export function extractLinkTargets(content: string): string[] {
  const targets: string[] = [];
  const fences = fencedRanges(content);
  let match: RegExpExecArray | null;
  WIKILINK_RE.lastIndex = 0;
  while ((match = WIKILINK_RE.exec(content)) !== null) {
    if (insideFence(fences, match.index)) continue;
    const target = linkTarget(match[1]);
    if (target) targets.push(target);
  }
  return targets;
}

/**
 * Rewrite the note targets of every wikilink/embed in `content`. For each link,
 * `mapTarget` receives the bare target (alias + `#anchor` stripped, trimmed) and
 * returns a replacement target, or null to leave the link untouched. The embed
 * prefix (`!`), display alias (`|alias`), and anchor (`#heading`) are preserved.
 * Optionally, `mapAnchor` receives the link's target and its heading anchor text
 * (block refs `#^id` are never passed to it) and returns a replacement anchor,
 * or null to leave it untouched; `mapTarget` and `mapAnchor` are independent, so
 * a link's target and anchor can each be rewritten (or not) separately.
 * Returns the rewritten content and the number of links changed.
 */
export function rewriteWikilinks(
  content: string,
  mapTarget: (target: string) => string | null,
  mapAnchor?: (target: string, anchor: string) => string | null
): { content: string; changed: number } {
  let changed = 0;
  const fences = fencedRanges(content);
  const next = content.replace(
    /(!?)\[\[([^\]]+)\]\]/g,
    (whole, bang: string, inner: string, index: number) => {
    // A link inside a code fence is documentation, not a graph edge — leave it
    // exactly as written so move_note/rename_section never edit code samples.
    if (insideFence(fences, index)) return whole;
    const pipe = inner.indexOf("|");
    const left = pipe === -1 ? inner : inner.slice(0, pipe);
    const alias = pipe === -1 ? "" : inner.slice(pipe); // includes leading "|"
    const hash = left.indexOf("#");
    const target = hash === -1 ? left : left.slice(0, hash);
    const rawAnchor = hash === -1 ? "" : left.slice(hash); // includes leading "#", verbatim
    const trimmedTarget = target.trim();

    const newTarget = mapTarget(trimmedTarget);
    // Only consult mapAnchor for heading anchors (not block refs) when asked.
    let newAnchor: string | null = null;
    if (mapAnchor && hash !== -1) {
      const anchorText = rawAnchor.slice(1).trim(); // drop "#", trim
      if (!anchorText.startsWith("^")) {
        newAnchor = mapAnchor(trimmedTarget, anchorText);
      }
    }
    if (newTarget == null && newAnchor == null) return whole;
    changed++;
    const finalTarget = newTarget == null ? trimmedTarget : newTarget;
    // Preserve the anchor byte-for-byte unless mapAnchor supplied a replacement.
    const finalAnchor = newAnchor == null ? rawAnchor : `#${newAnchor}`;
    return `${bang}[[${finalTarget}${finalAnchor}${alias}]]`;
  });
  return { content: next, changed };
}

/** A wikilink's note target plus its heading/block anchor, if any. */
export interface LinkRef {
  /** Note target (alias + anchor stripped, trimmed). Empty for a `[[#anchor]]` self-link. */
  target: string;
  /** Raw anchor text after `#` (trimmed), or null when the link has no anchor. */
  anchor: string | null;
  /** True when the anchor was a block ref (`#^id`) rather than a heading. */
  isBlockRef: boolean;
}

/**
 * Extract every wikilink/embed as a {@link LinkRef}, preserving the heading or
 * block anchor that {@link extractLinkTargets} discards. Order matches document
 * order. A `[[#heading]]` self-link yields an empty `target`.
 */
export function extractLinkRefs(content: string): LinkRef[] {
  const refs: LinkRef[] = [];
  const fences = fencedRanges(content);
  let match: RegExpExecArray | null;
  WIKILINK_RE.lastIndex = 0;
  while ((match = WIKILINK_RE.exec(content)) !== null) {
    if (insideFence(fences, match.index)) continue;
    const inner = match[1];
    const left = inner.split("|")[0];
    const hash = left.indexOf("#");
    const target = (hash === -1 ? left : left.slice(0, hash)).trim();
    let anchor: string | null = null;
    let isBlockRef = false;
    if (hash !== -1) {
      let raw = left.slice(hash + 1).trim();
      if (raw.startsWith("^")) {
        isBlockRef = true;
        raw = raw.slice(1).trim();
      }
      anchor = raw;
    }
    refs.push({ target, anchor, isBlockRef });
  }
  return refs;
}

/**
 * Whether a heading's text matches a link anchor. Literal case-insensitive,
 * trimmed equality — deliberately NOT Obsidian's slug normalization.
 */
export function headingMatchesAnchor(headingText: string, anchor: string): boolean {
  return headingText.trim().toLowerCase() === anchor.trim().toLowerCase();
}

/**
 * All ATX headings (`#`..`######`) in document order, skipping fenced code
 * blocks. This is the single shared heading parser used by the index, the
 * write tools, and the read-side structure tools, so they never disagree.
 */
export function parseHeadings(content: string): ParsedHeading[] {
  const lines = content.split("\n");
  const headings: ParsedHeading[] = [];
  let inFence = false;
  let fence = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = line.match(/^\s*(```+|~~~+)/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!inFence) {
        inFence = true;
        fence = marker;
      } else if (marker === fence) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;
    const h = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (h) headings.push({ text: h[2].trim(), level: h[1].length, line: i });
  }
  return headings;
}

/**
 * Parallel array of `" > "`-joined ancestor paths for the given headings.
 * A heading at level L attaches to the nearest heading of level < L before it;
 * level skips attach to whatever shallower ancestor is present.
 */
export function headingPaths(headings: ParsedHeading[]): string[] {
  const stack: ParsedHeading[] = [];
  return headings.map((h) => {
    while (stack.length > 0 && stack[stack.length - 1].level >= h.level) {
      stack.pop();
    }
    const path = [...stack.map((a) => a.text), h.text].join(" > ");
    stack.push(h);
    return path;
  });
}

/**
 * Whether a section address is a `" > "`-joined heading-path (`Projects > Log`)
 * rather than a bare heading (`Log`). The single definition of "is this a path?"
 * shared by section resolution (`resolveSection`, `readSection`) and the
 * create-guard in `appendToSection` — a heading-path names a location inside
 * existing structure and so can be addressed but never created.
 */
export function isHeadingPath(section: string): boolean {
  return section.includes(">");
}

export function firstHeading(content: string): string | undefined {
  return parseHeadings(content)[0]?.text;
}

/**
 * Thrown by {@link resolveSectionIndex} when a bare heading matches more than
 * one heading in the note. Distinguished by type (not message text) from the
 * plain not-found case, so callers like `appendToSection`'s create-fallback
 * can tell "missing, safe to create" apart from "ambiguous, must not create"
 * without depending on error-message wording.
 */
export class SectionAmbiguousError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SectionAmbiguousError";
  }
}

/**
 * Resolve a section reference to a single heading index, fail-loud. `section`
 * is a bare heading (`Log`) or a `" > "`-joined heading-path (`Projects > Log`),
 * detected by the presence of `>`. A bare heading that matches more than one
 * heading throws a {@link SectionAmbiguousError} listing the candidate full
 * paths; a heading-path matches the fully-qualified path exactly. Throws a
 * plain `Error` when nothing matches (`notFoundSuffix` is appended to that
 * message, e.g. ` in <note>`).
 *
 * The single shared matcher for both read_section (section.ts) and the write
 * side's section edits (note-document.ts), so the two never disagree on which
 * heading a reference addresses; each caller computes its own body bounds from
 * the returned index.
 */
export function resolveSectionIndex(
  headings: readonly { text: string }[],
  paths: readonly string[],
  section: string,
  notFoundSuffix = ""
): number {
  const wanted = section.trim();
  const isPath = isHeadingPath(wanted);
  const norm = (p: string): string =>
    p
      .split(">")
      .map((s) => s.trim())
      .join(" > ");
  const target = isPath ? norm(wanted) : wanted;

  const matches = headings
    .map((h, i) => ({ h, i, path: paths[i] }))
    .filter((m) => (isPath ? m.path === target : m.h.text === wanted));

  if (matches.length === 0) {
    throw new Error(`Section "${section}" not found${notFoundSuffix}`);
  }
  if (matches.length > 1) {
    const candidates = matches.map((m) => m.path).join(", ");
    throw new SectionAmbiguousError(
      `Ambiguous section "${section}"; candidates: ${candidates}`
    );
  }
  return matches[0].i;
}

/** Ordered writable statuses (excludes "other"). */
export const WRITABLE_TASK_STATUSES: readonly WritableTaskStatus[] = [
  "open",
  "done",
  "in_progress",
  "cancelled",
  "forwarded",
];

/** All statuses, including read-only "other". */
export const TASK_STATUSES: readonly TaskStatus[] = [
  ...WRITABLE_TASK_STATUSES,
  "other",
];

// Canonical marker for each writable status (write direction).
const STATUS_TO_MARKER: Record<WritableTaskStatus, string> = {
  open: " ",
  done: "x",
  in_progress: "/",
  cancelled: "-",
  forwarded: ">",
};

// Raw marker -> named status (read direction). Empty brackets normalize to open.
const MARKER_TO_STATUS: Record<string, TaskStatus> = {
  " ": "open",
  "": "open",
  x: "done",
  X: "done",
  "/": "in_progress",
  "-": "cancelled",
  ">": "forwarded",
};

/** Map a raw checkbox marker to its named status ("other" when unrecognized). */
export function markerToStatus(marker: string): TaskStatus {
  return MARKER_TO_STATUS[marker] ?? "other";
}

/** Canonical marker char for a writable status. */
export function statusToMarker(status: WritableTaskStatus): string {
  return STATUS_TO_MARKER[status];
}

// A checkbox list item: indent, bullet, single-or-empty marker, then text.
const TASK_RE = /^(\s*)([-*+])\s+\[(.?)\]\s?(.*)$/;

/**
 * All checkbox tasks (`- [ ] ...`) in document order, skipping fenced code
 * blocks — the task analogue of {@link parseHeadings}, sharing its fence
 * tracking so the two never disagree about what is "inside code". A plain
 * bullet (`- text`) is not a task. The raw marker is preserved verbatim; an
 * empty `[]` normalizes to the open marker (" ").
 */
export function parseTasks(content: string): ParsedTask[] {
  const lines = content.split("\n");
  const tasks: ParsedTask[] = [];
  let inFence = false;
  let fence = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = line.match(/^\s*(```+|~~~+)/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!inFence) {
        inFence = true;
        fence = marker;
      } else if (marker === fence) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;
    const m = line.match(TASK_RE);
    if (!m) continue;
    const rawMarker = m[3] === "" ? " " : m[3];
    tasks.push({
      text: m[4].trim(),
      status: markerToStatus(rawMarker),
      marker: rawMarker,
      line: i,
      indent: m[1].length,
    });
  }
  return tasks;
}
