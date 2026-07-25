import { getIndex } from "./vault-index.js";
import { assertVaultPath } from "./vault.js";
import { RankedSearchParams, RankedSearchResult, ListResponse } from "../types.js";
import { resolveCandidates, validateCandidateFilter } from "./candidate-filter.js";
import { assertNonNegativeInt } from "./list-response.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 100;

/**
 * Rank vault notes by BM25 relevance to a free-text query, optionally scoped
 * to a candidate set by folder / tags / where (same filters as search_notes).
 * Complements the regex/substring `searchNotes` (ripgrep) tool.
 */
export async function searchNotesRanked(
  vaultPath: string,
  params: RankedSearchParams
): Promise<ListResponse<RankedSearchResult>> {
  assertVaultPath(vaultPath);
  const { query, limit, folder, tags, where, match, offset } = params;

  if (!query || typeof query !== "string" || !query.trim()) {
    throw new Error("query must be a non-empty string");
  }
  if (query.length > 1000) {
    throw new Error("query too long (max 1000 characters)");
  }

  assertNonNegativeInt(limit, "limit");
  assertNonNegativeInt(offset, "offset");

  let effectiveLimit: number | undefined;
  if (limit === undefined) {
    effectiveLimit = DEFAULT_LIMIT;
  } else if (limit === 0) {
    effectiveLimit = undefined; // unbounded
  } else {
    effectiveLimit = Math.min(limit, MAX_LIMIT);
  }

  const index = await getIndex(vaultPath);

  const hasFilter = folder !== undefined || tags !== undefined || where !== undefined;
  if (!hasFilter) {
    return index.searchRanked(query, effectiveLimit, undefined, offset);
  }

  validateCandidateFilter({ tags, where, match });
  const entries = resolveCandidates(index, {
    folder,
    tags,
    where,
    tagMatch: match ?? "any",
    whereMatch: "all", // mirror search_notes: match governs only tags
  });
  if (entries.length === 0) return { results: [], returned: 0, skipped: 0, omitted: 0, truncated: false };

  const allowedIds = new Set(entries.map((e) => e.path));
  return index.searchRanked(query, effectiveLimit, allowedIds, offset);
}
