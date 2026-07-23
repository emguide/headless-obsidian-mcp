import { getIndex } from "./vault-index.js";
import { assertVaultPath } from "./vault.js";
import { RankedSearchParams, RankedSearchResult, ListResponse } from "../types.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 100;

/**
 * Rank vault notes by BM25 relevance to a free-text query. Complements the
 * regex/substring `searchNotes` (ripgrep) tool with relevance ordering.
 */
export async function searchNotesRanked(
  vaultPath: string,
  params: RankedSearchParams
): Promise<ListResponse<RankedSearchResult>> {
  assertVaultPath(vaultPath);
  const { query, limit } = params;

  if (!query || typeof query !== "string" || !query.trim()) {
    throw new Error("query must be a non-empty string");
  }
  if (query.length > 1000) {
    throw new Error("query too long (max 1000 characters)");
  }

  if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
    throw new Error("limit must be a positive integer");
  }

  let effectiveLimit: number | undefined;
  if (limit === undefined) {
    effectiveLimit = DEFAULT_LIMIT;
  } else if (limit === 0) {
    effectiveLimit = undefined; // unbounded
  } else {
    effectiveLimit = Math.min(limit, MAX_LIMIT);
  }

  const index = await getIndex(vaultPath);
  return index.searchRanked(query, effectiveLimit);
}
