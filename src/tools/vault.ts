import { readdir, stat } from "node:fs/promises";
import { join, resolve, relative, sep } from "node:path";
import { ParsedHeading } from "../types.js";

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

/** Normalize a filesystem path to a vault-relative, forward-slash, no-.md name. */
function toVaultName(resolvedVault: string, fullPath: string): string {
  return relative(resolvedVault, fullPath)
    .split(sep)
    .join("/")
    .replace(/\.md$/, "");
}

/**
 * Resolve a user-supplied note path to an absolute path inside the vault,
 * guarding against path-traversal escapes. Mirrors the checks used by
 * read_notes so every tool that resolves a path behaves identically.
 */
export function resolveNotePath(vaultPath: string, notePath: string): string {
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
  return fullPath;
}

/**
 * Resolve a user-supplied path (any file, not just a note) to an absolute path
 * inside the vault, guarding against path-traversal escapes. Unlike
 * {@link resolveNotePath} this does not append a `.md` suffix, so it is used for
 * attachments and for the `.trash` folder when trashing a note.
 */
export function resolveVaultFile(vaultPath: string, filePath: string): string {
  if (!filePath || typeof filePath !== "string") {
    throw new Error("File path must be a non-empty string");
  }
  const resolvedVault = resolve(vaultPath);
  const fullPath = resolve(join(vaultPath, filePath));
  const relativePath = relative(resolvedVault, fullPath);
  if (relativePath.startsWith("..") || relativePath.includes(".." + sep)) {
    throw new Error("Invalid file path: path traversal not allowed");
  }
  return fullPath;
}

/**
 * Recursively walk the vault and return every markdown file, skipping hidden
 * and machinery directories. Filesystem metadata is collected but file
 * contents are not read. Results are sorted by path for deterministic output.
 */
export async function walkVault(vaultPath: string): Promise<VaultFile[]> {
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
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        const full = join(dir, entry.name);
        let info;
        try {
          info = await stat(full);
        } catch {
          continue;
        }
        results.push({
          path: toVaultName(resolvedVault, full),
          fullPath: full,
          size: info.size,
          mtime: info.mtime,
        });
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

/** Normalize a frontmatter `tags`/`tag` value (array or delimited string) to a list. */
function frontmatterTags(data: Record<string, unknown>): string[] {
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
    ...frontmatterTags(frontmatter),
    ...extractInlineTags(content),
  ]);
  return [...tags].sort((a, b) => a.localeCompare(b));
}

// Matches Obsidian wikilinks and embeds: [[target]], [[target|alias]],
// [[target#heading]], ![[target]]. Captures the inner reference.
const WIKILINK_RE = /!?\[\[([^\]]+)\]\]/g;

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
  let match: RegExpExecArray | null;
  WIKILINK_RE.lastIndex = 0;
  while ((match = WIKILINK_RE.exec(content)) !== null) {
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
 * Returns the rewritten content and the number of links changed.
 */
export function rewriteWikilinks(
  content: string,
  mapTarget: (target: string) => string | null
): { content: string; changed: number } {
  let changed = 0;
  const next = content.replace(/(!?)\[\[([^\]]+)\]\]/g, (whole, bang: string, inner: string) => {
    const pipe = inner.indexOf("|");
    const left = pipe === -1 ? inner : inner.slice(0, pipe);
    const alias = pipe === -1 ? "" : inner.slice(pipe); // includes leading "|"
    const hash = left.indexOf("#");
    const target = hash === -1 ? left : left.slice(0, hash);
    const anchor = hash === -1 ? "" : left.slice(hash); // includes leading "#"
    const replacement = mapTarget(target.trim());
    if (replacement == null) return whole;
    changed++;
    return `${bang}[[${replacement}${anchor}${alias}]]`;
  });
  return { content: next, changed };
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

export function firstHeading(content: string): string | undefined {
  return parseHeadings(content)[0]?.text;
}
