import { assertVaultPath } from "./vault.js";
import { getIndex, entryToHeader } from "./vault-index.js";
import { ListNotesParams, ListNotesResponse } from "../types.js";

/** Default cap on `list_notes` so the first orientation call is bounded. */
const DEFAULT_LIMIT = 100;

/**
 * List notes in the vault as lightweight headers (path, title, tags, first
 * heading, size, mtime) without returning full contents. Gives an agent a
 * "table of contents" so it can orient itself before searching or reading.
 *
 * Bounded by default: with no `limit`, at most `DEFAULT_LIMIT` notes are
 * returned. Pass `limit: 0` for an unbounded list (matching `search_notes`).
 * The result is an envelope reporting `total`/`returned`/`truncated` so a
 * capped list is never mistaken for a complete one.
 */
export async function listNotes(
  vaultPath: string,
  params: ListNotesParams = {}
): Promise<ListNotesResponse> {
  assertVaultPath(vaultPath);

  const { folder, limit } = params;

  // `limit: 0` is the sentinel for "unbounded"; any other non-positive or
  // non-integer value is rejected. Omitting `limit` applies DEFAULT_LIMIT.
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
    throw new Error("limit must be a positive integer");
  }

  const index = await getIndex(vaultPath);
  let entries = index.getEntries();

  if (folder && typeof folder === "string" && folder.trim()) {
    // Normalize the folder prefix to forward slashes with a trailing slash so
    // "projects" matches "projects/foo" but not "projects-archive/foo".
    const prefix = folder.replace(/[\\/]+$/, "").replace(/\\/g, "/") + "/";
    entries = entries.filter((e) => (e.path + "/").startsWith(prefix));
  }

  const total = entries.length;

  // Resolve the effective cap: explicit 0 => unbounded; omitted => default.
  const effectiveLimit = limit === undefined ? DEFAULT_LIMIT : limit;
  if (effectiveLimit !== 0) {
    entries = entries.slice(0, effectiveLimit);
  }

  const notes = entries.map(entryToHeader);
  return {
    notes,
    total,
    returned: notes.length,
    truncated: total > notes.length,
  };
}
