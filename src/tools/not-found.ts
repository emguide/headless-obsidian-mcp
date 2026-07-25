import { VaultIndex, getIndex } from "./vault-index.js";

/**
 * Shared "did you mean" builder for missing-note errors. The most common agent
 * failure is a near-miss path — wrong case, missing folder prefix, title
 * instead of basename — so every path-addressed tool appends up to
 * {@link MAX_SUGGESTIONS} candidates to its not-found error:
 *
 *     Note not found: projects/alfa. Did you mean: projects/alpha?
 *
 * Candidates come from `resolve_note`'s exact matching (case-insensitive
 * title/alias/basename equality via {@link VaultIndex.resolveName}) — never
 * fuzzy. Report-only: errors stay errors, and a candidate is never silently
 * substituted for the requested path.
 */

const MAX_SUGGESTIONS = 3;

/** Canonical vault name for a note path (forward slashes, no .md suffix). */
function canonical(notePath: string): string {
  return notePath.replace(/\\/g, "/").replace(/\.md$/i, "");
}

/**
 * Resolve a human-facing note path to the note's canonical vault path, the way
 * the index-backed readers (`get_links`, `get_property`, `get_outline`,
 * `get_related_notes`) do: case-insensitively, with Obsidian's bare-basename
 * shortest-path fallback (see {@link VaultIndex.resolve}). Returns the canonical
 * path when the name resolves, else the input's own canonical form unchanged —
 * so a caller reading from disk still attempts the literal path and produces the
 * usual did-you-mean error if it, too, is missing. This is the single point that
 * keeps the disk-reading readers (`get_frontmatter`, `read_section`,
 * `read_notes`) in the same addressing camp as their index-backed siblings.
 */
export function resolveNoteName(index: VaultIndex, notePath: string): string {
  const canon = canonical(notePath);
  return index.resolve(canon) ?? canon;
}

/**
 * Up to {@link MAX_SUGGESTIONS} candidate paths for a note path that failed to
 * resolve. The whole input is tried as a name first (catches a title or alias
 * passed as the "path"); when the input carries a folder prefix, its last
 * segment is tried too (catches a wrong or missing folder, and wrong-case
 * paths). The failed path itself is never suggested back.
 */
export function didYouMean(index: VaultIndex, notePath: string): string[] {
  const canon = canonical(notePath);
  const seen = new Set<string>();
  const candidates: string[] = [];
  const add = (path: string): void => {
    if (path === canon || seen.has(path)) return;
    seen.add(path);
    candidates.push(path);
  };

  for (const m of index.resolveName(canon)) add(m.path);
  const base = canon.split("/").pop()!;
  if (base !== canon) {
    for (const m of index.resolveName(base)) add(m.path);
  }
  return candidates.slice(0, MAX_SUGGESTIONS);
}

/**
 * Full not-found message: the base prefix (a site's existing wording, e.g.
 * "Note not found or not readable"), the canonical name, and — when the index
 * has exact-match candidates — a "Did you mean" suffix.
 */
export function noteNotFoundMessage(
  index: VaultIndex,
  notePath: string,
  base = "Note not found"
): string {
  const candidates = didYouMean(index, notePath);
  const hint =
    candidates.length > 0 ? `. Did you mean: ${candidates.join(", ")}?` : "";
  return `${base}: ${canonical(notePath)}${hint}`;
}

/**
 * Async convenience for sites that do not already hold an index (the write
 * funnel, direct file readers). Never throws: when the index cannot be
 * built, the error degrades to the bare message — a not-found error must not
 * be masked by a suggestion-lookup failure.
 */
export async function noteNotFoundError(
  vaultPath: string,
  notePath: string,
  base = "Note not found"
): Promise<Error> {
  try {
    const index = await getIndex(vaultPath);
    return new Error(noteNotFoundMessage(index, notePath, base));
  } catch {
    return new Error(`${base}: ${canonical(notePath)}`);
  }
}
