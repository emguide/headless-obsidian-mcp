import { getIndex } from "./vault-index.js";
import { assertVaultPath } from "./vault.js";
import { RankedSearchParams, RankedSearchResult } from "../types.js";
import { resolveCandidates, validateCandidateFilter } from "./candidate-filter.js";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

/**
 * Rank vault notes by BM25 relevance to a free-text query, optionally scoped
 * to a candidate set by folder / tags / where (same filters as search_notes).
 * Complements the regex/substring `searchNotes` (ripgrep) tool.
 */
export async function searchNotesRanked(
  vaultPath: string,
  params: RankedSearchParams
): Promise<RankedSearchResult[]> {
  assertVaultPath(vaultPath);
  const { query, limit, folder, tags, where, match } = params;

  if (!query || typeof query !== "string" || !query.trim()) {
    throw new Error("query must be a non-empty string");
  }
  if (query.length > 1000) {
    throw new Error("query too long (max 1000 characters)");
  }

  let effectiveLimit = DEFAULT_LIMIT;
  if (limit !== undefined) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error("limit must be a positive integer");
    }
    effectiveLimit = Math.min(limit, MAX_LIMIT);
  }

  const index = await getIndex(vaultPath);

  const hasFilter = folder !== undefined || tags !== undefined || where !== undefined;
  if (!hasFilter) {
    return index.searchRanked(query, effectiveLimit);
  }

  validateCandidateFilter({ tags, where, match });
  const entries = resolveCandidates(index, {
    folder,
    tags,
    where,
    tagMatch: match ?? "any",
    whereMatch: "all", // mirror search_notes: match governs only tags
  });
  if (entries.length === 0) return [];

  const allowedIds = new Set(entries.map((e) => e.path));
  return index.searchRanked(query, effectiveLimit, allowedIds);
}
