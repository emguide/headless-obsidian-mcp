import { assertVaultPath } from "./vault.js";
import { getIndex, entryToHeader } from "./vault-index.js";
import { ListVaultIssuesParams, UnresolvedLinkGroup, NoteHeader } from "../types.js";

/**
 * List the vault-hygiene issues the index already knows about but that
 * get_vault_stats only counts. `orphans` returns note headers for notes with no
 * inbound or outbound resolved links (the exact predicate get_vault_stats uses).
 * `unresolved_links` returns, grouped by source note, the raw wikilink targets
 * that resolve to nothing — the sum of `targets` lengths equals the stats
 * unresolved_links count.
 */
export async function listVaultIssues(
  vaultPath: string,
  params: ListVaultIssuesParams
): Promise<NoteHeader[] | UnresolvedLinkGroup[]> {
  assertVaultPath(vaultPath);
  const { kind, limit } = params;
  if (kind !== "orphans" && kind !== "unresolved_links") {
    throw new Error('kind must be "orphans" or "unresolved_links"');
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error("limit must be a positive integer");
  }

  const index = await getIndex(vaultPath);

  if (kind === "orphans") {
    const orphans = index.getEntries().filter(
      (e) => index.outbound(e.path).length === 0 && index.backlinks(e.path).length === 0
    );
    const limited = limit !== undefined ? orphans.slice(0, limit) : orphans;
    return limited.map(entryToHeader);
  }

  // unresolved_links, grouped by source note (entries are already path-sorted).
  const groups: UnresolvedLinkGroup[] = [];
  for (const entry of index.getEntries()) {
    const targets = entry.linkTargets.filter((t) => !index.resolve(t));
    if (targets.length > 0) {
      groups.push({ source: entry.path, targets });
    }
  }
  return limit !== undefined ? groups.slice(0, limit) : groups;
}
