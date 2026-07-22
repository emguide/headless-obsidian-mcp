import { assertVaultPath } from "./vault.js";
import { getIndex } from "./vault-index.js";
import { VaultStats } from "../types.js";

/**
 * Compute aggregate statistics for the whole vault from the shared index: note
 * and tag counts, link-graph health (resolved vs unresolved links, orphans),
 * and modification-time bounds. All numbers come from the cached index, so no
 * files are re-read beyond the index's own incremental refresh.
 */
export async function getVaultStats(vaultPath: string): Promise<VaultStats> {
  assertVaultPath(vaultPath);
  const index = await getIndex(vaultPath);
  const entries = index.getEntries();

  let totalSize = 0;
  let taggedNotes = 0;
  let tagAssignments = 0;
  let resolvedLinks = 0;
  let unresolvedLinks = 0;
  let notesWithLinks = 0;
  let orphanNotes = 0;
  let newest = -Infinity;
  let oldest = Infinity;
  const distinctTags = new Set<string>();

  for (const entry of entries) {
    totalSize += entry.size;

    if (entry.tags.length > 0) {
      taggedNotes++;
      tagAssignments += entry.tags.length;
      for (const tag of entry.tags) distinctTags.add(tag);
    }

    // Unresolved links are counted per raw reference; resolved links use the
    // de-duplicated outbound edge set already computed by the index.
    for (const target of entry.linkTargets) {
      if (!index.resolve(target)) unresolvedLinks++;
    }
    const outbound = index.outbound(entry.path);
    resolvedLinks += outbound.length;
    if (outbound.length > 0) notesWithLinks++;
    if (outbound.length === 0 && index.backlinks(entry.path).length === 0) {
      orphanNotes++;
    }

    if (entry.mtimeMs > newest) newest = entry.mtimeMs;
    if (entry.mtimeMs < oldest) oldest = entry.mtimeMs;
  }

  return {
    notes: entries.length,
    total_size_bytes: totalSize,
    distinct_tags: distinctTags.size,
    tag_assignments: tagAssignments,
    tagged_notes: taggedNotes,
    untagged_notes: entries.length - taggedNotes,
    resolved_links: resolvedLinks,
    unresolved_links: unresolvedLinks,
    notes_with_links: notesWithLinks,
    orphan_notes: orphanNotes,
    last_modified: entries.length ? new Date(newest).toISOString() : null,
    first_modified: entries.length ? new Date(oldest).toISOString() : null,
  };
}
