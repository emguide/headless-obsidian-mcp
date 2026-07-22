import { getIndex } from "./vault-index.js";
import { RankedSearchParams, RankedSearchResult } from "../types.js";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

/**
 * Rank vault notes by BM25 relevance to a free-text query. Complements the
 * regex/substring `searchNotes` (ripgrep) tool with relevance ordering.
 */
export async function searchNotesRanked(
  vaultPath: string,
  params: RankedSearchParams
): Promise<RankedSearchResult[]> {
  const { query, limit } = params;

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
  return index.searchRanked(query, effectiveLimit);
}
