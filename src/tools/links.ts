import { resolveNotePath, assertVaultPath } from "./vault.js";
import { getIndex } from "./vault-index.js";
import { noteNotFoundMessage } from "./not-found.js";
import { LinksResult } from "../types.js";

/**
 * Compute the link graph for a single note: outbound wikilinks resolved to
 * real notes, links that resolve to nothing, and backlinks (every other note
 * that links to this one). Turns the flat vault into a navigable graph.
 * Backed by the shared index, so backlinks are a precomputed lookup rather
 * than a full-vault scan.
 */
export async function getLinks(
  vaultPath: string,
  notePath: string
): Promise<LinksResult> {
  assertVaultPath(vaultPath);
  if (!notePath || typeof notePath !== "string") {
    throw new Error("A note path is required for get_links");
  }

  // Validate the path (guards against traversal escapes) before touching the
  // index; the resolved path itself is not needed once validated.
  resolveNotePath(vaultPath, notePath);

  const index = await getIndex(vaultPath);
  const noteName = notePath.replace(/\.md$/, "");

  // Canonical path of the note under inspection, as it appears in the vault.
  const self = index.resolve(noteName) ?? noteName;
  const entry = index.getEntry(self);
  if (!entry) {
    throw new Error(
      noteNotFoundMessage(index, notePath, "Note not found or not readable")
    );
  }

  const outbound: Array<{ target: string; path: string }> = [];
  const unresolved: string[] = [];
  const seenOut = new Set<string>();
  for (const target of entry.linkTargets) {
    const resolved = index.resolve(target);
    if (resolved) {
      if (!seenOut.has(resolved)) {
        seenOut.add(resolved);
        outbound.push({ target, path: resolved });
      }
    } else if (!unresolved.includes(target)) {
      unresolved.push(target);
    }
  }

  return {
    note: self,
    outbound_links: outbound,
    unresolved_links: unresolved,
    backlinks: index.backlinks(self),
  };
}
