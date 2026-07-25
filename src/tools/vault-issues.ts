import { assertVaultPath, headingMatchesAnchor } from "./vault.js";
import { getIndex, entryToHeader, VaultIndex } from "./vault-index.js";
import {
  ListVaultIssuesParams,
  UnresolvedLinkGroup,
  NoteHeader,
  ListResponse,
  BrokenAnchorGroup,
  UnresolvedLinkGroupWithContext,
  BrokenAnchorGroupWithContext,
} from "../types.js";
import { toListResponse, assertNonNegativeInt } from "./list-response.js";
import { scanLinkLines, linkContext, ScannedLinkLine } from "./link-context.js";

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
 *
 * `include_context: true` (unresolved_links/broken_anchors only — orphans have
 * no links to contextualize, so it errors there) decorates each target with the
 * source line(s) containing it. Context is computed by call-time file reads
 * over the returned window only, so a bounded call reads a bounded number of
 * files.
 */
export async function listVaultIssues(
  vaultPath: string,
  params: ListVaultIssuesParams
): Promise<
  | ListResponse<NoteHeader>
  | ListResponse<UnresolvedLinkGroup>
  | ListResponse<BrokenAnchorGroup>
  | ListResponse<UnresolvedLinkGroupWithContext>
  | ListResponse<BrokenAnchorGroupWithContext>
> {
  assertVaultPath(vaultPath);
  const { kind, limit, offset, include_context } = params;
  if (kind !== "orphans" && kind !== "unresolved_links" && kind !== "broken_anchors") {
    throw new Error('kind must be "orphans", "unresolved_links", or "broken_anchors"');
  }
  assertNonNegativeInt(limit, "limit");
  assertNonNegativeInt(offset, "offset");
  if (include_context && kind === "orphans") {
    throw new Error(
      'include_context is only valid for kinds "unresolved_links" and "broken_anchors" — orphans have no links to contextualize'
    );
  }

  const effectiveLimit = limit === undefined ? DEFAULT_LIMIT : limit;

  const index = await getIndex(vaultPath);

  if (kind === "orphans") {
    const orphans = index.getEntries().filter(
      (e) => index.outbound(e.path).length === 0 && index.backlinks(e.path).length === 0
    );
    return toListResponse(orphans.map(entryToHeader), effectiveLimit === 0 ? undefined : effectiveLimit, offset);
  }

  if (kind === "broken_anchors") {
    const groups: BrokenAnchorGroup[] = [];
    for (const entry of index.getEntries()) {
      const targets: { target: string; anchor: string }[] = [];
      for (const ref of entry.linkRefs) {
        if (ref.anchor == null || ref.isBlockRef) continue;
        // A self-anchor ([[#heading]]) resolves to the source note itself.
        const resolved = ref.target === "" ? entry.path : index.resolve(ref.target);
        if (!resolved) continue; // unresolved NOTE is unresolved_links' concern
        const target = index.getEntry(resolved);
        if (!target) continue;
        const ok = target.headings.some((h) => headingMatchesAnchor(h.text, ref.anchor!));
        if (!ok) targets.push({ target: ref.target, anchor: ref.anchor });
      }
      if (targets.length > 0) groups.push({ source: entry.path, targets });
    }
    const response = toListResponse(groups, effectiveLimit === 0 ? undefined : effectiveLimit, offset);
    if (!include_context) return response;
    return {
      ...response,
      results: await Promise.all(
        response.results.map(async (group) => ({
          source: group.source,
          targets: await withScan(index, group.source, (scanned) =>
            group.targets.map((t) => ({
              ...t,
              context: linkContext(
                scanned,
                (ref) => !ref.isBlockRef && ref.target === t.target && ref.anchor === t.anchor
              ),
            }))
          ),
        }))
      ),
    };
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
  const response = toListResponse(groups, effectiveLimit === 0 ? undefined : effectiveLimit, offset);
  if (!include_context) return response;
  return {
    ...response,
    results: await Promise.all(
      response.results.map(async (group) => ({
        source: group.source,
        targets: await withScan(index, group.source, (scanned) =>
          group.targets.map((target) => ({
            target,
            context: linkContext(scanned, (ref) => ref.target === target),
          }))
        ),
      }))
    ),
  };
}

/** Scan one source note and derive its decorated targets from the scan. */
async function withScan<T>(
  index: VaultIndex,
  source: string,
  derive: (scanned: ScannedLinkLine[]) => T
): Promise<T> {
  const entry = index.getEntry(source);
  const scanned = entry ? await scanLinkLines(entry.fullPath) : [];
  return derive(scanned);
}
