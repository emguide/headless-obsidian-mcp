import { assertVaultPath } from "./vault.js";
import { getIndex, entryToHeader, IndexEntry } from "./vault-index.js";
import { RecentNotesParams, NoteHeader } from "../types.js";

/** Parse a value into epoch ms, or null if it isn't a usable date. */
function toEpoch(value: unknown): number | null {
  if (value == null) return null;
  const d = new Date(value as string);
  const t = d.getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * Does a note's frontmatter satisfy every key/value in `where`? String
 * comparison is case-insensitive; if the frontmatter value is an array, the
 * filter matches when the requested value is a member (e.g. status in a list).
 */
function matchesWhere(
  frontmatter: Record<string, unknown>,
  where: Record<string, unknown>
): boolean {
  for (const [key, want] of Object.entries(where)) {
    const have = frontmatter[key];
    const wantStr = String(want).toLowerCase();
    if (Array.isArray(have)) {
      if (!have.some((v) => String(v).toLowerCase() === wantStr)) return false;
    } else if (have == null || String(have).toLowerCase() !== wantStr) {
      return false;
    }
  }
  return true;
}

/**
 * List notes ordered by recency, newest first. By default recency is the
 * filesystem mtime; set `date_field` to sort by a frontmatter date instead
 * (e.g. "updated"). Supports a `since` cutoff and frontmatter `where` filters,
 * so an agent can pull, say, only active notes touched this week.
 */
export async function listRecentNotes(
  vaultPath: string,
  params: RecentNotesParams = {}
): Promise<NoteHeader[]> {
  assertVaultPath(vaultPath);

  const { limit = 20, since, date_field, where } = params;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("limit must be a positive integer");
  }

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

  let selected = index.getEntries();
  if (where) {
    selected = selected.filter((e) => matchesWhere(e.frontmatter, where));
  }
  if (sinceEpoch !== null) {
    selected = selected.filter((e) => sortDateOf(e) >= sinceEpoch!);
  }

  selected = selected
    .slice()
    .sort((a, b) => sortDateOf(b) - sortDateOf(a))
    .slice(0, limit);

  return selected.map(entryToHeader);
}
