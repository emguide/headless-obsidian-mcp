import { parseMatter } from "./matter-safe.js";
import {
  extractLinkRefs,
  headingMatchesAnchor,
  parseHeadings,
} from "./vault.js";
import type { VaultIndex } from "./vault-index.js";

/**
 * The link-graph health of a single note's resulting content, reported by the
 * content-write tools so a write can never damage the graph silently. Mirrors
 * the two graph-integrity `kind`s of `list_vault_issues`, scoped to one note:
 *
 * - `unresolved_links`: wikilink targets in the note that resolve to no vault
 *   note (the same predicate as `list_vault_issues` kind "unresolved_links").
 * - `broken_anchors`: `[[note#heading]]` links whose target note resolves but
 *   whose heading anchor matches no heading in that note (the same predicate as
 *   kind "broken_anchors"). Block-ref anchors (`#^id`) are excluded.
 *
 * Report-only, same philosophy as `delete_note`'s `dangled_backlinks`: the
 * write is not blocked, the note is not modified — the agent is simply told
 * what it just introduced. An empty array on both means the write left the
 * graph intact.
 */
export interface LinkHealth {
  /** Raw wikilink targets in the note that resolve to no vault note. */
  unresolved_links: string[];
  /** Resolved-note, dead-heading anchors: { target, anchor } pairs. */
  broken_anchors: { target: string; anchor: string }[];
}

/**
 * Compute {@link LinkHealth} for a note from the exact content just written,
 * resolving targets against the shared `index` (which supplies the rest of the
 * vault). Working from the written content — rather than re-reading the note
 * through the index — sidesteps mtime/size-collision staleness (e.g. an
 * equal-length `patch_note`) and reflects precisely what the write produced.
 *
 * `notePath` is the canonical path of the written note (forward slashes, no
 * `.md`); it lets a `[[#heading]]` self-link and a `[[thisnote#heading]]`
 * self-reference resolve to this note's own headings.
 */
export function linkHealthOf(
  index: VaultIndex,
  notePath: string,
  content: string
): LinkHealth {
  const body = parseMatter(content).content;
  const refs = extractLinkRefs(body);
  const selfHeadings = parseHeadings(body);

  const unresolved_links: string[] = [];
  const broken_anchors: { target: string; anchor: string }[] = [];

  for (const ref of refs) {
    // A self-anchor ([[#heading]], empty target) points at this note itself.
    const resolved =
      ref.target === "" ? notePath : index.resolve(ref.target);

    if (!resolved) {
      // Target resolves to nothing — this is an unresolved link. A bare
      // [[#anchor]] self-link always has a target (this note), so it never
      // lands here; only non-empty, unresolvable targets do.
      unresolved_links.push(ref.target);
      continue;
    }

    // Target resolves. If the link carries a heading anchor, check it against
    // the target note's headings (self-references use the freshly-parsed
    // headings of the written content, not the possibly-stale index copy).
    if (ref.anchor == null || ref.isBlockRef) continue;
    const targetHeadings =
      resolved === notePath ? selfHeadings : index.getEntry(resolved)?.headings;
    if (!targetHeadings) continue; // resolved to a path with no index entry
    const ok = targetHeadings.some((h) => headingMatchesAnchor(h.text, ref.anchor!));
    if (!ok) broken_anchors.push({ target: ref.target, anchor: ref.anchor });
  }

  return { unresolved_links, broken_anchors };
}
