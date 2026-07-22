import { resolveNotePath, assertVaultPath } from "./vault.js";
import { getIndex, entryToHeader, VaultIndex, IndexEntry } from "./vault-index.js";
import { RelatedNotesParams, RelatedNote } from "../types.js";

/**
 * Relatedness weights. A direct link is the strongest single signal (two notes
 * the author explicitly connected); a shared tag is human curation; shared
 * out-links (co-reference) and shared back-links (co-citation) are structural
 * hints that two notes sit in the same neighbourhood of the graph.
 */
const WEIGHTS = {
  directLink: 4,
  sharedTag: 3,
  sharedLink: 2,
  sharedBacklink: 2,
} as const;

/** Case-insensitive intersection of two string lists, preserving `a`'s values/order. */
function intersect(a: string[], b: string[]): string[] {
  const bSet = new Set(b.map((v) => v.toLowerCase()));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of a) {
    const key = v.toLowerCase();
    if (bSet.has(key) && !seen.has(key)) {
      seen.add(key);
      out.push(v);
    }
  }
  return out;
}

/**
 * Find the notes most related to a given note, without embeddings or any model:
 * a transparent weighted blend of signals already held in the shared index -
 * shared tags (curation), direct links, shared out-links (co-reference), and
 * shared back-links (co-citation). Turns the flat vault into associative
 * memory: "I'm looking at X - what else is relevant?" Every hit carries the
 * reasons it surfaced, so the ranking is explainable rather than opaque.
 */
export async function getRelatedNotes(
  vaultPath: string,
  params: RelatedNotesParams
): Promise<RelatedNote[]> {
  assertVaultPath(vaultPath);

  const { path, limit = 10 } = params;
  if (!path || typeof path !== "string") {
    throw new Error("A note path is required for get_related_notes");
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("limit must be a positive integer");
  }

  // Validate the path (guards against traversal escapes) before touching the index.
  resolveNotePath(vaultPath, path);

  const index = await getIndex(vaultPath);
  const self = index.resolve(path.replace(/\.md$/i, "")) ?? path.replace(/\.md$/i, "");
  const source = index.getEntry(self);
  if (!source) {
    throw new Error(`Note not found or not readable: ${path}`);
  }

  const sourceTags = source.tags;
  const sourceOut = index.outbound(self);
  const sourceBack = index.backlinks(self);
  // Direct links in either direction: notes the source links to, plus notes
  // that link to the source.
  const directlyLinked = new Set<string>([...sourceOut, ...sourceBack]);

  const related: RelatedNote[] = [];
  for (const entry of index.getEntries()) {
    if (entry.path === self) continue;

    const scored = score(entry, {
      index,
      sourceTags,
      sourceOut,
      sourceBack,
      directlyLinked,
    });
    if (scored) related.push(scored);
  }

  related.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return related.slice(0, limit);
}

interface ScoreContext {
  index: VaultIndex;
  sourceTags: string[];
  sourceOut: string[];
  sourceBack: string[];
  directlyLinked: Set<string>;
}

/** Score one candidate against the source, or null if nothing connects them. */
function score(entry: IndexEntry, ctx: ScoreContext): RelatedNote | null {
  const sharedTags = intersect(entry.tags, ctx.sourceTags);
  const sharedLinks = intersect(ctx.index.outbound(entry.path), ctx.sourceOut);
  const sharedBacklinks = intersect(ctx.index.backlinks(entry.path), ctx.sourceBack);
  const linked = ctx.directlyLinked.has(entry.path);

  let total = 0;
  const reasons: string[] = [];

  if (linked) {
    total += WEIGHTS.directLink;
    reasons.push("directly linked");
  }
  if (sharedTags.length > 0) {
    total += WEIGHTS.sharedTag * sharedTags.length;
    reasons.push(`shares tags: ${sharedTags.join(", ")}`);
  }
  if (sharedLinks.length > 0) {
    total += WEIGHTS.sharedLink * sharedLinks.length;
    reasons.push(
      `links to ${sharedLinks.length} of the same note${sharedLinks.length === 1 ? "" : "s"}`
    );
  }
  if (sharedBacklinks.length > 0) {
    total += WEIGHTS.sharedBacklink * sharedBacklinks.length;
    reasons.push(
      `cited alongside by ${sharedBacklinks.length} note${sharedBacklinks.length === 1 ? "" : "s"}`
    );
  }

  if (total === 0) return null;

  return {
    ...entryToHeader(entry),
    score: total,
    reasons,
    shared_tags: sharedTags,
    shared_links: sharedLinks,
    shared_backlinks: sharedBacklinks,
    linked,
  };
}
