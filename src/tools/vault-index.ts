import { readFile } from "node:fs/promises";
import { resolve, basename } from "node:path";
import matter from "gray-matter";
import {
  walkVault,
  collectTags,
  extractLinkTargets,
  parseHeadings,
  assertVaultPath,
  VaultFile,
} from "./vault.js";
import { tokenize } from "./text/tokenize.js";
import { BM25 } from "./text/bm25.js";
import { NoteHeader, RankedSearchResult, ParsedHeading, ListResponse } from "../types.js";

/**
 * A fully-parsed note in the index. Raw file contents are not retained —
 * only derived facts, plus `tokens`, a normalized (tokenized/stemmed) copy
 * of the content kept for BM25 ranking.
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
  /** Fence-aware headings in document order (shared parser). */
  headings: ParsedHeading[];
  /** BM25 token stream: body plus title/headings/tags injected at ×2 weight. */
  tokens: string[];
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
  private outboundMap = new Map<string, string[]>();
  private bm25 = new BM25();

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
    this.outboundMap.clear();

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
      // Resolved outbound edges of this note, and their inverse (backlinks).
      this.outboundMap.set(e.path, [...resolvedTargets].sort((a, b) => a.localeCompare(b)));
      for (const target of resolvedTargets) {
        const list = this.backlinkMap.get(target) ?? [];
        list.push(e.path);
        this.backlinkMap.set(target, list);
      }
    }
    for (const list of this.backlinkMap.values()) {
      list.sort((a, b) => a.localeCompare(b));
    }

    // Rebuild the BM25 index from cached per-note tokens. Unchanged notes were
    // not re-tokenized (their tokens come straight from the cached entry), so
    // this only re-aggregates corpus statistics — cheap relative to file I/O.
    this.bm25 = new BM25();
    for (const e of this.entries.values()) {
      this.bm25.add(e.path, e.tokens);
    }
    this.bm25.finalize();
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

  /** Canonical paths this note links to, resolved and de-duplicated (sorted). */
  outbound(path: string): string[] {
    return this.outboundMap.get(path) ?? [];
  }

  /**
   * Rank notes by BM25 relevance to a free-text query. Snippets are read from
   * the ≤ limit winning files at query time (never stored in the index).
   */
  async searchRanked(
    query: string,
    limit: number | undefined,
    allowedIds?: Set<string>
  ): Promise<ListResponse<RankedSearchResult>> {
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return { results: [], returned: 0, omitted: 0, truncated: false };
    if (allowedIds && allowedIds.size === 0) return { results: [], returned: 0, omitted: 0, truncated: false };
    const { hits, total } = this.bm25.search(queryTokens, limit ?? Number.MAX_SAFE_INTEGER, allowedIds);

    // Raw (unstemmed) query words used only to locate a snippet line.
    const rawWords = query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 0);

    const results: RankedSearchResult[] = [];
    for (const hit of hits) {
      const entry = this.entries.get(hit.docId);
      if (!entry) continue;
      const snippet = await this.buildSnippet(entry.fullPath, rawWords);
      results.push({ ...entryToHeader(entry), score: hit.score, snippet });
    }
    return {
      results,
      returned: results.length,
      omitted: total - results.length,
      truncated: total > results.length,
    };
  }

  /** Best-effort snippet: first body line containing a query word, else first body line. */
  private async buildSnippet(fullPath: string, rawWords: string[]): Promise<string> {
    let body: string;
    try {
      const raw = await readFile(fullPath, "utf-8");
      body = matter(raw).content;
    } catch {
      return "";
    }
    const lines = body
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const clip = (s: string): string => (s.length > 200 ? s.slice(0, 200) + "…" : s);
    for (const line of lines) {
      const lower = line.toLowerCase();
      if (rawWords.some((w) => lower.includes(w))) return clip(line);
    }
    return lines.length > 0 ? clip(lines[0]) : "";
  }
}

/** Read and parse a single file into an index entry (failures degrade gracefully). */
async function buildEntry(f: VaultFile): Promise<IndexEntry> {
  let frontmatter: Record<string, unknown> = {};
  let tags: string[] = [];
  let linkTargets: string[] = [];
  let headline: string | undefined;
  let title = basename(f.path);
  let headings: ParsedHeading[] = [];
  let tokens: string[] = [];

  try {
    const raw = await readFile(f.fullPath, "utf-8");
    const parsed = matter(raw);
    frontmatter = parsed.data as Record<string, unknown>;
    tags = collectTags(frontmatter, parsed.content);
    linkTargets = extractLinkTargets(parsed.content);
    headings = parseHeadings(parsed.content);
    headline = headings[0]?.text;
    if (typeof frontmatter.title === "string" && frontmatter.title.trim()) {
      title = frontmatter.title.trim();
    }
    // BM25 tokens: body once, then boosted fields (title, headings, tags) an
    // extra time (×2 weight) so a title/heading/tag hit outranks a passing
    // body mention even when the term never appears in the body at all.
    const boosted = [title, ...headings.map((h) => h.text), ...tags].join(" ");
    const boostedTokens = tokenize(boosted);
    tokens = [...tokenize(parsed.content), ...boostedTokens, ...boostedTokens];
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
    headings,
    tokens,
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
