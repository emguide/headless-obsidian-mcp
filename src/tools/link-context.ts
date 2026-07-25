import { readFile } from "node:fs/promises";
import { parseMatter } from "./matter-safe.js";
import { extractLinkRefs, LinkRef } from "./vault.js";
import type { VaultIndex } from "./vault-index.js";
import type { LinkContextLine } from "../types.js";

/**
 * Shared implementation of the opt-in `include_context` decoration: the source
 * line(s) containing a reported link, so "who references this note, and why"
 * is answered in one call instead of a search_notes approximation that cannot
 * tell resolved links from text mentions.
 *
 * Context is computed by call-time file reads (the index does not retain body
 * text — same precedent as read_section). Frontmatter is stripped with
 * gray-matter, the index's own stripper, so `line` is 1-based and
 * body-relative — the same convention as get_outline/list_tasks. `text` is the
 * line verbatim, so it can be fed straight into patch_note's `find`.
 *
 * Link identification reuses extractLinkRefs and index resolution — the same
 * parsing the index itself performs — never a hand-rolled regex. Scanning is
 * per-line, so a wikilink spanning a newline (which Obsidian does not render
 * anyway) is counted by the index but yields no context line.
 */

/** A body line that contains at least one wikilink, with its parsed refs. */
export interface ScannedLinkLine {
  /** 1-based, body-relative line number (frontmatter stripped). */
  line: number;
  /** The line verbatim. */
  text: string;
  /** Every wikilink/embed ref on the line, in order. */
  refs: LinkRef[];
}

/**
 * Read a note and return the body lines that contain wikilinks. An unreadable
 * or unparseable file degrades to no lines rather than an error — context is a
 * report-only decoration, and a source that vanished between the index refresh
 * and this read must not sink the whole call.
 */
export async function scanLinkLines(fullPath: string): Promise<ScannedLinkLine[]> {
  let raw: string;
  try {
    raw = await readFile(fullPath, "utf-8");
  } catch {
    return [];
  }
  let body: string;
  try {
    body = parseMatter(raw).content;
  } catch {
    return [];
  }

  const scanned: ScannedLinkLine[] = [];
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const refs = extractLinkRefs(lines[i]);
    if (refs.length > 0) scanned.push({ line: i + 1, text: lines[i], refs });
  }
  return scanned;
}

/** The lines whose refs satisfy `match`, as report rows (one per line). */
export function linkContext(
  scanned: ScannedLinkLine[],
  match: (ref: LinkRef) => boolean
): LinkContextLine[] {
  return scanned
    .filter(({ refs }) => refs.some(match))
    .map(({ line, text }) => ({ line, text }));
}

/**
 * Predicate for "this ref links to `targetPath`", resolved against the index.
 * A `[[#anchor]]` self-link (empty target) resolves to the source note itself,
 * mirroring linkHealthOf/list_vault_issues.
 */
export function resolvesTo(
  index: VaultIndex,
  sourcePath: string,
  targetPath: string
): (ref: LinkRef) => boolean {
  return (ref) =>
    (ref.target === "" ? sourcePath : index.resolve(ref.target)) === targetPath;
}

/**
 * Decorate each backlink source path with the lines in it that link to
 * `targetPath`. Shared by get_links' backlinks and delete_note's
 * dangled_backlinks (where `index` is the pre-delete index, so the deleted
 * note still resolves).
 */
export async function backlinkContext(
  index: VaultIndex,
  sources: string[],
  targetPath: string
): Promise<Array<{ path: string; context: LinkContextLine[] }>> {
  return Promise.all(
    sources.map(async (source) => {
      const entry = index.getEntry(source);
      const scanned = entry ? await scanLinkLines(entry.fullPath) : [];
      return {
        path: source,
        context: linkContext(scanned, resolvesTo(index, source, targetPath)),
      };
    })
  );
}
