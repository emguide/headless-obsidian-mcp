import type { VaultIndex, IndexEntry } from "./vault-index.js";
import { matchesWhere } from "./property-match.js";
import type { Condition } from "./property-match.js";

export interface CandidateFilter {
  folder?: string;
  tags?: string[];
  where?: Record<string, Condition>;
  /** How to combine multiple tags. Default "any". */
  tagMatch?: "any" | "all";
  /** How to combine multiple where conditions. Default "all". */
  whereMatch?: "any" | "all";
}

/**
 * Validate the raw filter inputs shared by search_notes / search_notes_ranked.
 * Messages match search_notes verbatim so the two tools reject identically.
 */
export function validateCandidateFilter(f: { tags?: unknown; where?: unknown; match?: unknown }): void {
  if (f.tags !== undefined && (!Array.isArray(f.tags) || f.tags.length === 0)) {
    throw new Error("tags must be a non-empty array when provided");
  }
  if (f.match !== undefined && f.match !== "any" && f.match !== "all") {
    throw new Error('match must be "any" or "all"');
  }
  if (f.where !== undefined && (typeof f.where !== "object" || f.where === null || Array.isArray(f.where))) {
    throw new Error("where must be an object of property conditions");
  }
}

/**
 * Scope the vault to a candidate set: apply folder-prefix, then tags, then
 * where filters over the index entries. Each field is optional; an absent
 * field imposes no constraint. Returns the surviving entries in index order.
 */
export function resolveCandidates(index: VaultIndex, f: CandidateFilter): IndexEntry[] {
  const tagMatch = f.tagMatch ?? "any";
  const whereMatch = f.whereMatch ?? "all";
  const folderPrefix = f.folder && f.folder.trim()
    ? f.folder.replace(/[\\/]+$/, "").replace(/\\/g, "/") + "/"
    : undefined;
  const wantedTags = f.tags?.map((t) => String(t).replace(/^#/, "").toLowerCase());

  return index.getEntries().filter((entry) => {
    // A note is *under* the folder iff its path begins with `folder/` — the
    // same plain-prefix test list_files uses. Note the trailing slash: it keeps
    // `folder: "projects"` from matching a root note `projects.md`, whose path
    // is the bare `projects`.
    if (folderPrefix && !entry.path.startsWith(folderPrefix)) {
      return false;
    }
    if (wantedTags) {
      const noteSet = new Set(entry.tags.map((t) => t.toLowerCase()));
      const ok = tagMatch === "all"
        ? wantedTags.every((w) => noteSet.has(w))
        : wantedTags.some((w) => noteSet.has(w));
      if (!ok) return false;
    }
    if (f.where) {
      if (!matchesWhere(entry.frontmatter, f.where, whereMatch)) return false;
    }
    return true;
  });
}
