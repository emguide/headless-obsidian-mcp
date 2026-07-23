import { assertVaultPath } from "./vault.js";
import { getIndex, entryToHeader } from "./vault-index.js";
import { ListVaultIssuesParams, UnresolvedLinkGroup, NoteHeader, ListResponse } from "../types.js";
import { toListResponse } from "./list-response.js";

/** Default cap on `list_vault_issues` so an unbounded call is still bounded. */
const DEFAULT_LIMIT = 100;

/**
 * List the vault-hygiene issues the index already knows about but that
 * get_vault_stats only counts. `orphans` returns note headers for notes with no
 * inbound or outbound resolved links (the exact predicate get_vault_stats uses).
 * `unresolved_links` returns, grouped by source note, the raw wikilink targets
 * that resolve to nothing — the sum of `targets` lengths equals the stats
 * unresolved_links count (for the full/unbounded result; truncation for this
 * kind counts groups, i.e. source notes, not individual targets).
 *
 * Bounded by default: with no `limit`, at most `DEFAULT_LIMIT` rows (headers or
 * groups) are returned. Pass `limit: 0` for an unbounded list. The result is a
 * `ListResponse` envelope reporting `returned`/`omitted`/`truncated` so a capped
 * list is never mistaken for a complete one.
 */
export async function listVaultIssues(
  vaultPath: string,
  params: ListVaultIssuesParams
): Promise<ListResponse<NoteHeader> | ListResponse<UnresolvedLinkGroup>> {
  assertVaultPath(vaultPath);
  const { kind, limit } = params;
  if (kind !== "orphans" && kind !== "unresolved_links") {
    throw new Error('kind must be "orphans" or "unresolved_links"');
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
    throw new Error("limit must be a positive integer");
  }

  const effectiveLimit = limit === undefined ? DEFAULT_LIMIT : limit;

  const index = await getIndex(vaultPath);

  if (kind === "orphans") {
    const orphans = index.getEntries().filter(
      (e) => index.outbound(e.path).length === 0 && index.backlinks(e.path).length === 0
    );
    return toListResponse(orphans.map(entryToHeader), effectiveLimit === 0 ? undefined : effectiveLimit);
  }

  // unresolved_links, grouped by source note (entries are already path-sorted).
  // Truncation counts groups (source notes), not individual targets.
  const groups: UnresolvedLinkGroup[] = [];
  for (const entry of index.getEntries()) {
    const targets = entry.linkTargets.filter((t) => !index.resolve(t));
    if (targets.length > 0) {
      groups.push({ source: entry.path, targets });
    }
  }
  return toListResponse(groups, effectiveLimit === 0 ? undefined : effectiveLimit);
}
