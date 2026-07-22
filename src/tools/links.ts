import { readFile } from "node:fs/promises";
import { walkVault, resolveNotePath, assertVaultPath, VaultFile } from "./vault.js";
import { LinksResult } from "../types.js";

// Matches Obsidian wikilinks and embeds: [[target]], [[target|alias]],
// [[target#heading]], ![[target]]. Captures the inner reference.
const WIKILINK_RE = /!?\[\[([^\]]+)\]\]/g;

/** Reduce a raw wikilink body to just its note target (drop alias + heading). */
function linkTarget(inner: string): string {
  // Strip display alias after "|", then any "#heading" / "#^block" anchor.
  const noAlias = inner.split("|")[0];
  const noAnchor = noAlias.split("#")[0];
  return noAnchor.trim();
}

/** Extract all wikilink targets from note content. */
function extractLinkTargets(content: string): string[] {
  const targets: string[] = [];
  let match: RegExpExecArray | null;
  WIKILINK_RE.lastIndex = 0;
  while ((match = WIKILINK_RE.exec(content)) !== null) {
    const target = linkTarget(match[1]);
    if (target) targets.push(target);
  }
  return targets;
}

/**
 * Build a resolver from wikilink target text to a real vault note path.
 * Obsidian resolves links by shortest unique path: a link may be a full
 * relative path ("folder/note") or just a basename ("note"). We index both.
 */
function buildResolver(files: VaultFile[]): (target: string) => string | null {
  const byPath = new Map<string, string>();
  const byBasename = new Map<string, string[]>();

  for (const f of files) {
    byPath.set(f.path.toLowerCase(), f.path);
    const base = f.path.split("/").pop()!.toLowerCase();
    const list = byBasename.get(base) ?? [];
    list.push(f.path);
    byBasename.set(base, list);
  }

  return (target: string): string | null => {
    const key = target.replace(/\.md$/i, "").replace(/\\/g, "/").toLowerCase();
    const exact = byPath.get(key);
    if (exact) return exact;
    // Fall back to basename match (Obsidian's default for un-pathed links).
    const base = key.split("/").pop()!;
    const candidates = byBasename.get(base);
    if (candidates && candidates.length > 0) return candidates[0];
    return null;
  };
}

/**
 * Compute the link graph for a single note: outbound wikilinks resolved to
 * real notes, links that resolve to nothing, and backlinks (every other note
 * that links to this one). Turns the flat vault into a navigable graph.
 */
export async function getLinks(
  vaultPath: string,
  notePath: string
): Promise<LinksResult> {
  assertVaultPath(vaultPath);
  if (!notePath || typeof notePath !== "string") {
    throw new Error("A note path is required for get_links");
  }

  // Validate/resolve the target note path (guards path traversal) and read it.
  const targetFullPath = resolveNotePath(vaultPath, notePath);
  const noteName = notePath.replace(/\.md$/, "");

  const files = await walkVault(vaultPath);
  const resolve = buildResolver(files);

  // Canonical path of the note we're inspecting, as it appears in the vault.
  const self = resolve(noteName);
  const selfPath = self ?? noteName;

  // --- Outbound links -------------------------------------------------------
  let targetContent: string;
  try {
    targetContent = await readFile(targetFullPath, "utf-8");
  } catch {
    throw new Error(`Note not found or not readable: ${notePath}`);
  }

  const outbound: Array<{ target: string; path: string }> = [];
  const unresolved: string[] = [];
  const seenOut = new Set<string>();
  for (const target of extractLinkTargets(targetContent)) {
    const resolved = resolve(target);
    if (resolved) {
      if (!seenOut.has(resolved)) {
        seenOut.add(resolved);
        outbound.push({ target, path: resolved });
      }
    } else if (!unresolved.includes(target)) {
      unresolved.push(target);
    }
  }

  // --- Backlinks ------------------------------------------------------------
  // Scan every other note; a note is a backlink if any of its wikilinks
  // resolves to the note under inspection.
  const backlinks: string[] = [];
  await Promise.all(
    files.map(async (f) => {
      if (f.path === selfPath) return;
      let content: string;
      try {
        content = await readFile(f.fullPath, "utf-8");
      } catch {
        return;
      }
      for (const target of extractLinkTargets(content)) {
        if (resolve(target) === selfPath) {
          backlinks.push(f.path);
          return;
        }
      }
    })
  );
  backlinks.sort((a, b) => a.localeCompare(b));

  return {
    note: selfPath,
    outbound_links: outbound,
    unresolved_links: unresolved,
    backlinks,
  };
}
