import { assertVaultPath } from "./vault.js";
import { getIndex, entryToHeader } from "./vault-index.js";
import { TagCount, FindByTagParams, NoteHeader, ListResponse } from "../types.js";
import { toListResponse } from "./list-response.js";

/** Default cap on `find_by_tag` so an unbounded call is still bounded. */
const DEFAULT_LIMIT = 100;

/**
 * Aggregate every tag used across the vault with the number of notes that use
 * it, sorted by count (descending) then name. Unifies inline `#tags` with
 * frontmatter `tags:` so the vault's full topic index is visible to the agent.
 */
export async function listTags(vaultPath: string): Promise<ListResponse<TagCount>> {
  assertVaultPath(vaultPath);
  const index = await getIndex(vaultPath);
  const counts = new Map<string, number>();

  for (const entry of index.getEntries()) {
    for (const tag of new Set(entry.tags)) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }

  const tags = [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  return toListResponse(tags);
}

/**
 * Find notes matching one or more tags. With match="all" a note must carry
 * every requested tag; with "any" (default) at least one. Returns lightweight
 * headers, giving high-precision retrieval based on human curation.
 *
 * Bounded by default: with no `limit`, at most `DEFAULT_LIMIT` notes are
 * returned. Pass `limit: 0` for an unbounded list. The result is a
 * `ListResponse` envelope reporting `returned`/`omitted`/`truncated` so a
 * capped list is never mistaken for a complete one.
 */
export async function findByTag(
  vaultPath: string,
  params: FindByTagParams
): Promise<ListResponse<NoteHeader>> {
  assertVaultPath(vaultPath);

  const { tags, match = "any", limit } = params;
  if (!Array.isArray(tags) || tags.length === 0) {
    throw new Error("tags must be a non-empty array");
  }
  if (match !== "any" && match !== "all") {
    throw new Error('match must be "any" or "all"');
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
    throw new Error("limit must be a positive integer");
  }

  // Normalize requested tags: drop leading "#", lowercase for comparison.
  const wanted = tags.map((t) => String(t).replace(/^#/, "").toLowerCase());

  const index = await getIndex(vaultPath);
  const matched = index.getEntries().filter((entry) => {
    const noteSet = new Set(entry.tags.map((t) => t.toLowerCase()));
    return match === "all"
      ? wanted.every((w) => noteSet.has(w))
      : wanted.some((w) => noteSet.has(w));
  });

  const effectiveLimit = limit === undefined ? DEFAULT_LIMIT : limit;
  return toListResponse(
    matched.map(entryToHeader),
    effectiveLimit === 0 ? undefined : effectiveLimit
  );
}
