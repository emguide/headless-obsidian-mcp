import { resolveNotePath, assertVaultPath } from "./vault.js";
import { getIndex } from "./vault-index.js";
import { LinksResult, LinksResultWithContext } from "../types.js";
import { scanLinkLines, linkContext, resolvesTo, backlinkContext } from "./link-context.js";

export interface GetLinksOptions {
  /**
   * Decorate every link row with the source line(s) containing it (call-time
   * file reads; see link-context.ts). Opt-in so a heavily-backlinked hub note
   * stays cheap by default.
   */
  include_context?: boolean;
}

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
): Promise<LinksResult>;
export async function getLinks(
  vaultPath: string,
  notePath: string,
  options: GetLinksOptions
): Promise<LinksResult | LinksResultWithContext>;
export async function getLinks(
  vaultPath: string,
  notePath: string,
  options: GetLinksOptions = {}
): Promise<LinksResult | LinksResultWithContext> {
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
    throw new Error(`Note not found or not readable: ${notePath}`);
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

  const backlinks = index.backlinks(self);

  if (!options.include_context) {
    return {
      note: self,
      outbound_links: outbound,
      unresolved_links: unresolved,
      backlinks,
    };
  }

  // Outbound and unresolved context comes from one scan of the inspected note;
  // backlink context reads each source note once.
  const scannedSelf = await scanLinkLines(entry.fullPath);
  return {
    note: self,
    outbound_links: outbound.map(({ target, path }) => ({
      target,
      path,
      context: linkContext(scannedSelf, resolvesTo(index, self, path)),
    })),
    unresolved_links: unresolved.map((target) => ({
      target,
      context: linkContext(scannedSelf, (ref) => ref.target === target),
    })),
    backlinks: await backlinkContext(index, backlinks, self),
  };
}
