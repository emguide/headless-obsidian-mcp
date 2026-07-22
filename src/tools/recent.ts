import { readFile } from "node:fs/promises";
import matter from "gray-matter";
import { walkVault, buildHeader, assertVaultPath, VaultFile } from "./vault.js";
import { RecentNotesParams, NoteHeader } from "../types.js";

/** A vault file paired with its parsed frontmatter and effective sort date. */
interface Dated {
  file: VaultFile;
  frontmatter: Record<string, unknown>;
  sortDate: number; // epoch ms used for ordering / since-filtering
}

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

  const files = await walkVault(vaultPath);

  // Only parse frontmatter when we actually need it (a date field or filter).
  const needFrontmatter = Boolean(date_field) || Boolean(where);

  const dated: Dated[] = await Promise.all(
    files.map(async (f) => {
      let frontmatter: Record<string, unknown> = {};
      if (needFrontmatter) {
        try {
          const raw = await readFile(f.fullPath, "utf-8");
          frontmatter = matter(raw).data as Record<string, unknown>;
        } catch {
          frontmatter = {};
        }
      }
      const fieldEpoch = date_field ? toEpoch(frontmatter[date_field]) : null;
      return {
        file: f,
        frontmatter,
        sortDate: fieldEpoch ?? f.mtime.getTime(),
      };
    })
  );

  let selected = dated;
  if (where) {
    selected = selected.filter((d) => matchesWhere(d.frontmatter, where));
  }
  if (sinceEpoch !== null) {
    selected = selected.filter((d) => d.sortDate >= sinceEpoch!);
  }

  selected.sort((a, b) => b.sortDate - a.sortDate);
  const limited = selected.slice(0, limit);

  return Promise.all(limited.map((d) => buildHeader(d.file)));
}
