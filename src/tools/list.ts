import { assertVaultPath } from "./vault.js";
import { getIndex, entryToHeader } from "./vault-index.js";
import { ListNotesParams, NoteHeader } from "../types.js";

/**
 * List notes in the vault as lightweight headers (path, title, tags, first
 * heading, size, mtime) without returning full contents. Gives an agent a
 * "table of contents" so it can orient itself before searching or reading.
 */
export async function listNotes(
  vaultPath: string,
  params: ListNotesParams = {}
): Promise<NoteHeader[]> {
  assertVaultPath(vaultPath);

  const { folder, limit } = params;

  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
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

  if (limit !== undefined) {
    entries = entries.slice(0, limit);
  }

  return entries.map(entryToHeader);
}
