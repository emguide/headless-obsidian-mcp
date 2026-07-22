import { sep } from "node:path";
import { walkVault, buildHeader, assertVaultPath } from "./vault.js";
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

  let files = await walkVault(vaultPath);

  if (folder && typeof folder === "string" && folder.trim()) {
    // Normalize the folder prefix to forward slashes with a trailing slash so
    // "projects" matches "projects/foo" but not "projects-archive/foo".
    const prefix = folder.replace(/[\\/]+$/, "").split(sep).join("/") + "/";
    files = files.filter((f) => (f.path + "/").startsWith(prefix));
  }

  if (limit !== undefined) {
    files = files.slice(0, limit);
  }

  return Promise.all(files.map((f) => buildHeader(f)));
}
