import { readFile } from "node:fs/promises";
import { resolve, basename } from "node:path";
import matter from "gray-matter";
import {
  walkVault,
  collectTags,
  extractLinkTargets,
  firstHeading,
  assertVaultPath,
  VaultFile,
} from "./vault.js";
import { NoteHeader } from "../types.js";

/**
 * A fully-parsed note in the index. Contents themselves are not retained
 * (only the derived facts), keeping the index memory-light for large vaults.
 */
export interface IndexEntry {
  path: string;
  fullPath: string;
  size: number;
  mtimeMs: number;
  frontmatter: Record<string, unknown>;
  tags: string[];
  /** Raw wikilink targets (alias/anchor stripped), in document order. */
  linkTargets: string[];
  headline?: string;
  title: string;
}

/**
 * An in-memory index of the vault, shared across tool calls. The expensive
 * work (reading files, parsing frontmatter, extracting tags/links/headings)
 * is done once per file and cached; `refresh()` re-reads only files whose
 * size or mtime changed, so repeated tool calls become map lookups instead of
 * full-vault scans. A single walk (stat only) per refresh detects changes.
 */
export class VaultIndex {
  private readonly vaultPath: string;
  private entries = new Map<string, IndexEntry>();
  private byPath = new Map<string, string>();
  private byBasename = new Map<string, string[]>();
  private backlinkMap = new Map<string, string[]>();

  constructor(vaultPath: string) {
    assertVaultPath(vaultPath);
    this.vaultPath = resolve(vaultPath);
  }

  /** Bring the index up to date with the filesystem, re-reading only changes. */
  async refresh(): Promise<void> {
    const files = await walkVault(this.vaultPath);
    const seen = new Set<string>();

    for (const f of files) {
      seen.add(f.path);
      const existing = this.entries.get(f.path);
      if (
        existing &&
        existing.mtimeMs === f.mtime.getTime() &&
        existing.size === f.size
      ) {
        continue; // Unchanged since last refresh - keep cached entry.
      }
      this.entries.set(f.path, await buildEntry(f));
    }

    // Drop entries for files that no longer exist.
    for (const path of [...this.entries.keys()]) {
      if (!seen.has(path)) this.entries.delete(path);
    }

    this.rebuildDerived();
  }

  /** Rebuild the resolver maps and backlink graph from current entries. */
  private rebuildDerived(): void {
    this.byPath.clear();
    this.byBasename.clear();
    this.backlinkMap.clear();

    for (const e of this.entries.values()) {
      this.byPath.set(e.path.toLowerCase(), e.path);
      const base = e.path.split("/").pop()!.toLowerCase();
      const list = this.byBasename.get(base) ?? [];
      list.push(e.path);
      this.byBasename.set(base, list);
    }
    // Deterministic basename resolution: prefer the alphabetically-first path.
    for (const list of this.byBasename.values()) {
      list.sort((a, b) => a.localeCompare(b));
    }

    for (const e of this.entries.values()) {
      const resolvedTargets = new Set<string>();
      for (const target of e.linkTargets) {
        const r = this.resolve(target);
        if (r && r !== e.path) resolvedTargets.add(r);
      }
      for (const target of resolvedTargets) {
        const list = this.backlinkMap.get(target) ?? [];
        list.push(e.path);
        this.backlinkMap.set(target, list);
      }
    }
    for (const list of this.backlinkMap.values()) {
      list.sort((a, b) => a.localeCompare(b));
    }
  }

  /**
   * Resolve a wikilink target to a real note path. A link may be a full
   * relative path ("folder/note") or just a basename ("note"); both are
   * indexed, matching Obsidian's default shortest-path resolution.
   */
  resolve(target: string): string | null {
    const key = target.replace(/\.md$/i, "").replace(/\\/g, "/").toLowerCase();
    const exact = this.byPath.get(key);
    if (exact) return exact;
    const base = key.split("/").pop()!;
    const candidates = this.byBasename.get(base);
    return candidates && candidates.length > 0 ? candidates[0] : null;
  }

  /** All entries, sorted by path. */
  getEntries(): IndexEntry[] {
    return [...this.entries.values()].sort((a, b) =>
      a.path.localeCompare(b.path)
    );
  }

  getEntry(path: string): IndexEntry | undefined {
    return this.entries.get(path);
  }

  /** Notes that link to the given note path (sorted). */
  backlinks(path: string): string[] {
    return this.backlinkMap.get(path) ?? [];
  }
}

/** Read and parse a single file into an index entry (failures degrade gracefully). */
async function buildEntry(f: VaultFile): Promise<IndexEntry> {
  let frontmatter: Record<string, unknown> = {};
  let tags: string[] = [];
  let linkTargets: string[] = [];
  let headline: string | undefined;
  let title = basename(f.path);

  try {
    const raw = await readFile(f.fullPath, "utf-8");
    const parsed = matter(raw);
    frontmatter = parsed.data as Record<string, unknown>;
    tags = collectTags(frontmatter, parsed.content);
    linkTargets = extractLinkTargets(parsed.content);
    headline = firstHeading(parsed.content);
    if (typeof frontmatter.title === "string" && frontmatter.title.trim()) {
      title = frontmatter.title.trim();
    }
  } catch {
    // Unreadable/unparseable note: still indexed by path with fs metadata.
  }

  return {
    path: f.path,
    fullPath: f.fullPath,
    size: f.size,
    mtimeMs: f.mtime.getTime(),
    frontmatter,
    tags,
    linkTargets,
    headline,
    title,
  };
}

/** Project an index entry to the public lightweight note header shape. */
export function entryToHeader(entry: IndexEntry): NoteHeader {
  return {
    path: entry.path,
    title: entry.title,
    tags: entry.tags,
    headline: entry.headline,
    size: entry.size,
    modified: new Date(entry.mtimeMs).toISOString(),
  };
}

// One index per resolved vault path, reused across tool calls in the process.
const cache = new Map<string, VaultIndex>();

/** Get the (refreshed) shared index for a vault, creating it on first use. */
export async function getIndex(vaultPath: string): Promise<VaultIndex> {
  assertVaultPath(vaultPath);
  const key = resolve(vaultPath);
  let index = cache.get(key);
  if (!index) {
    index = new VaultIndex(vaultPath);
    cache.set(key, index);
  }
  await index.refresh();
  return index;
}

/** Clear the shared index cache (used by tests for isolation). */
export function clearIndexCache(): void {
  cache.clear();
}
