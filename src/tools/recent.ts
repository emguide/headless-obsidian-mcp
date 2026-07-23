import { assertVaultPath } from "./vault.js";
import { getIndex, entryToHeader, IndexEntry } from "./vault-index.js";
import { RecentNotesParams, NoteHeader, ListResponse } from "../types.js";
import { toListResponse, assertNonNegativeInt } from "./list-response.js";
import { resolveCandidates, validateCandidateFilter } from "./candidate-filter.js";

/** Default cap on `list_recent_notes` so an unbounded call can't be issued by accident. */
const DEFAULT_LIMIT = 100;

/** Parse a value into epoch ms, or null if it isn't a usable date. */
function toEpoch(value: unknown): number | null {
  if (value == null) return null;
  const d = new Date(value as string);
  const t = d.getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * List notes ordered by recency, newest first. By default recency is the
 * filesystem mtime; set `date_field` to sort by a frontmatter date instead
 * (e.g. "updated"). Supports a `since` cutoff plus the shared candidate-filter
 * vocabulary — `folder`, `tags`/`match` (default "any"), and frontmatter
 * `where` (all conditions apply) — so an agent can pull, say, only active
 * notes in projects/ touched this week without a client-side join.
 *
 * Bounded by default: with no `limit`, at most `DEFAULT_LIMIT` notes are
 * returned. Pass `limit: 0` for an unbounded list. The result is a
 * `ListResponse` envelope reporting `returned`/`omitted`/`truncated` so a
 * capped list is never mistaken for a complete one.
 */
export async function listRecentNotes(
  vaultPath: string,
  params: RecentNotesParams = {}
): Promise<ListResponse<NoteHeader>> {
  assertVaultPath(vaultPath);

  const { limit, since, date_field, folder, tags, match, where, offset } = params;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
    throw new Error("limit must be a positive integer");
  }
  assertNonNegativeInt(offset, "offset");
  validateCandidateFilter({ tags, where, match });

  let sinceEpoch: number | null = null;
  if (since !== undefined) {
    sinceEpoch = toEpoch(since);
    if (sinceEpoch === null) {
      throw new Error("since must be a valid date string");
    }
  }

  const index = await getIndex(vaultPath);

  const sortDateOf = (e: IndexEntry): number =>
    (date_field ? toEpoch(e.frontmatter[date_field]) : null) ?? e.mtimeMs;

  let selected = resolveCandidates(index, {
    folder,
    tags,
    where,
    tagMatch: match ?? "any",
    whereMatch: "all",
  });
  if (sinceEpoch !== null) {
    selected = selected.filter((e) => sortDateOf(e) >= sinceEpoch!);
  }

  const effectiveLimit = limit === undefined ? DEFAULT_LIMIT : limit;
  const sorted = selected.slice().sort((a, b) => sortDateOf(b) - sortDateOf(a));
  return toListResponse(sorted.map(entryToHeader), effectiveLimit === 0 ? undefined : effectiveLimit, offset);
}
