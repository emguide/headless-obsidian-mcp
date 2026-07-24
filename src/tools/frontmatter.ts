import { readFile } from "node:fs/promises";
import matter from "gray-matter";
import { assertVaultPath, resolveNotePath } from "./vault.js";
import { noteNotFoundError } from "./not-found.js";

/** Canonical vault name for a note path (forward slashes, no .md suffix). */
function canonicalName(notePath: string): string {
  return notePath.replace(/\\/g, "/").replace(/\.md$/, "");
}

/**
 * Read just a note's parsed frontmatter, without its body. A cheap way for an
 * agent to inspect a note's metadata (status, aliases, dates, custom fields)
 * before deciding whether to read or edit the whole note.
 */
export async function getFrontmatter(
  vaultPath: string,
  notePath: string
): Promise<{ path: string; frontmatter: Record<string, unknown> }> {
  assertVaultPath(vaultPath);
  if (!notePath || typeof notePath !== "string") {
    throw new Error("A note path is required");
  }
  const fullPath = resolveNotePath(vaultPath, notePath);
  let raw: string;
  try {
    raw = await readFile(fullPath, "utf-8");
  } catch {
    throw await noteNotFoundError(vaultPath, notePath);
  }
  const frontmatter = (matter(raw).data ?? {}) as Record<string, unknown>;
  return { path: canonicalName(notePath), frontmatter };
}
