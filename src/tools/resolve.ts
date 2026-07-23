import { assertVaultPath } from "./vault.js";
import { getIndex } from "./vault-index.js";
import { ResolveNoteResult } from "../types.js";

/**
 * Resolve a human-facing name (frontmatter title, an alias, or the file
 * basename) to a canonical note path — an exact, case-insensitive, index-backed
 * lookup that removes the search-then-guess round trip for "what's the path of
 * the note called X?".
 *
 * Matching is exact (never fuzzy — that is `search_notes_ranked`'s job). A note
 * matching on more than one field appears once, labeled with its strongest
 * field (title > alias > basename). `resolved` is set only when exactly one note
 * matches; an ambiguous or empty result leaves `resolved` null and never guesses.
 */
export async function resolveNote(
  vaultPath: string,
  query: string
): Promise<ResolveNoteResult> {
  assertVaultPath(vaultPath);
  if (typeof query !== "string" || !query.trim()) {
    throw new Error("A non-empty query is required");
  }

  const index = await getIndex(vaultPath);
  const matches = index.resolveName(query);
  return {
    query,
    matches,
    resolved: matches.length === 1 ? matches[0].path : null,
  };
}
