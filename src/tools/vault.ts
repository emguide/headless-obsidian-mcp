import { readdir, stat, readFile } from "node:fs/promises";
import { join, resolve, relative, sep, basename } from "node:path";
import matter from "gray-matter";
import { NoteHeader } from "../types.js";

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
 * Recursively walk the vault and return every markdown file, skipping hidden
 * and machinery directories. Filesystem metadata is collected but file
 * contents are not read.
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
 * Ignores `#` inside fenced code blocks is not attempted here; Obsidian's own
 * parser is lenient, so this stays permissive but avoids matching markdown
 * headings (`# Heading`) by requiring no whitespace after `#`.
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
 * (which the original inline-only extractor missed) with inline `#tags`.
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

/** Extract the first markdown heading (`# ...`) from note content, if any. */
function firstHeading(content: string): string | undefined {
  const match = content.match(/^#{1,6}\s+(.+?)\s*$/m);
  return match ? match[1].trim() : undefined;
}

/**
 * Build a lightweight header for a note: title, tags, first heading, and
 * filesystem metadata, without returning the full body. Used by discovery
 * tools (list_notes, find_by_tag, list_recent_notes) that need to describe
 * many notes cheaply.
 */
export async function buildHeader(file: VaultFile): Promise<NoteHeader> {
  let title: string | undefined;
  let tags: string[] = [];
  let headline: string | undefined;

  try {
    const raw = await readFile(file.fullPath, "utf-8");
    const { data, content } = matter(raw);
    const fm = data as Record<string, unknown>;
    if (typeof fm.title === "string" && fm.title.trim()) {
      title = fm.title.trim();
    }
    tags = collectTags(fm, content);
    headline = firstHeading(content);
  } catch {
    // If a note can't be read/parsed, still surface its path and fs metadata.
  }

  return {
    path: file.path,
    title: title ?? basename(file.path),
    tags,
    headline,
    size: file.size,
    modified: file.mtime.toISOString(),
  };
}
