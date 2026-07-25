import { assertVaultPath } from "./vault.js";
import { getIndex, entryToHeader } from "./vault-index.js";
import { ListNotesParams, ListResponse, NoteHeader } from "../types.js";
import { toListResponse, assertNonNegativeInt } from "./list-response.js";
import { resolveCandidates, validateCandidateFilter } from "./candidate-filter.js";

/** Default cap on `list_notes` so the first orientation call is bounded. */
const DEFAULT_LIMIT = 100;

/**
 * List notes in the vault as lightweight headers (path, title, tags, first
 * heading, size, mtime) without returning full contents. Gives an agent a
 * "table of contents" so it can orient itself before searching or reading.
 *
 * Bounded by default: with no `limit`, at most `DEFAULT_LIMIT` notes are
 * returned. Pass `limit: 0` for an unbounded list (matching `search_notes`).
 * The result is a `ListResponse` envelope reporting `returned`/`omitted`/
 * `truncated` so a capped list is never mistaken for a complete one.
 *
 * Beyond `folder`, notes can be scoped by `tags`/`match`/`where` — the same
 * candidate-filter vocabulary as `search_notes`, so a client never has to
 * fetch-wide-then-filter. `match` governs the `tags` set ("any" default);
 * `where` conditions all apply.
 */
export async function listNotes(
  vaultPath: string,
  params: ListNotesParams = {}
): Promise<ListResponse<NoteHeader>> {
  assertVaultPath(vaultPath);

  const { folder, tags, match, where, limit, offset } = params;

  // `limit: 0` is the sentinel for "unbounded"; any other negative or
  // non-integer value is rejected. Omitting `limit` applies DEFAULT_LIMIT.
  assertNonNegativeInt(limit, "limit");
  assertNonNegativeInt(offset, "offset");
  validateCandidateFilter({ tags, where, match });

  const index = await getIndex(vaultPath);
  const entries = resolveCandidates(index, {
    folder,
    tags,
    where,
    tagMatch: match ?? "any",
    whereMatch: "all",
  });

  // Resolve the effective cap: explicit 0 => unbounded; omitted => default.
  const effectiveLimit = limit === undefined ? DEFAULT_LIMIT : limit;

  return toListResponse(
    entries.map(entryToHeader),
    effectiveLimit === 0 ? undefined : effectiveLimit,
    offset
  );
}
