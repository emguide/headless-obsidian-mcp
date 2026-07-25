import { readFile } from "node:fs/promises";
import matter from "gray-matter";
import { assertVaultPath, resolveNotePath } from "./vault.js";
import { getIndex } from "./vault-index.js";
import { noteNotFoundError, resolveNoteName } from "./not-found.js";

/**
 * Read just a note's parsed frontmatter, without its body. A cheap way for an
 * agent to inspect a note's metadata (status, aliases, dates, custom fields)
 * before deciding whether to read or edit the whole note. Addresses the note
 * the same way the index-backed readers do — a bare basename or wrong-case name
 * resolves via {@link resolveNoteName}, then the resolved note is read from disk
 * (gray-matter parses the exact bytes, so frontmatter parity is preserved).
 */
export async function getFrontmatter(
  vaultPath: string,
  notePath: string
): Promise<{ path: string; frontmatter: Record<string, unknown> }> {
  assertVaultPath(vaultPath);
  if (!notePath || typeof notePath !== "string") {
    throw new Error("A note path is required");
  }
  const index = await getIndex(vaultPath);
  const canonical = resolveNoteName(index, notePath);
  const fullPath = resolveNotePath(vaultPath, canonical);
  let raw: string;
  try {
    raw = await readFile(fullPath, "utf-8");
  } catch {
    throw await noteNotFoundError(vaultPath, notePath);
  }
  const frontmatter = (matter(raw).data ?? {}) as Record<string, unknown>;
  return { path: canonical, frontmatter };
}
