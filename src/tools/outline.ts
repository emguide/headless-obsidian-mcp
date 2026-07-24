import { resolveNotePath, headingPaths } from "./vault.js";
import { getIndex } from "./vault-index.js";
import { noteNotFoundMessage } from "./not-found.js";
import { OutlineResult } from "../types.js";

/**
 * Return a note's heading structure from the shared index (no file read).
 * Each entry carries its level, a 1-based body line number, the full
 * " > "-joined heading-path (the disambiguating address for read_section and
 * the section write tools), and an `ambiguous` flag set when the bare heading
 * text repeats within the note.
 */
export async function getOutline(
  vaultPath: string,
  notePath: string
): Promise<OutlineResult> {
  if (!notePath || typeof notePath !== "string") {
    throw new Error("A note path is required for get_outline");
  }
  resolveNotePath(vaultPath, notePath); // guards against path traversal

  const index = await getIndex(vaultPath);
  const noteName = notePath.replace(/\.md$/, "");
  const self = index.resolve(noteName) ?? noteName;
  const entry = index.getEntry(self);
  if (!entry) {
    throw new Error(
      noteNotFoundMessage(index, notePath, "Note not found or not readable")
    );
  }

  const paths = headingPaths(entry.headings);
  const counts = new Map<string, number>();
  for (const h of entry.headings) {
    counts.set(h.text, (counts.get(h.text) ?? 0) + 1);
  }

  return {
    path: self,
    outline: entry.headings.map((h, i) => ({
      heading: h.text,
      level: h.level,
      path: paths[i],
      line: h.line + 1, // index headings are 0-based; expose 1-based
      ambiguous: (counts.get(h.text) ?? 0) > 1,
    })),
  };
}
