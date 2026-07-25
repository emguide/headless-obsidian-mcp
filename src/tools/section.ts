import { readFile, stat } from "node:fs/promises";
import matter from "gray-matter";
import { resolveNotePath, parseHeadings, headingPaths } from "./vault.js";
import { getIndex } from "./vault-index.js";
import { noteNotFoundError, resolveNoteName } from "./not-found.js";
import { ReadSectionParams, SectionResult } from "../types.js";

const MAX_BYTES = 10 * 1024 * 1024;

/**
 * Read a single section from a note without loading the whole note into the
 * caller's context. Addresses the note the same way the index-backed readers do
 * (a bare basename or wrong-case name resolves via {@link resolveNoteName}),
 * then reads the resolved file at call time (the index does not retain body
 * text). The section is addressed by bare heading or by a " > "-joined path,
 * failing loudly when a bare heading is ambiguous. The returned slice is the
 * heading line plus its own body; nested subsections are excluded unless
 * `include_subsections` is set.
 */
export async function readSection(
  vaultPath: string,
  params: ReadSectionParams
): Promise<SectionResult> {
  const { path: notePath, section, include_subsections = false } = params;
  if (!notePath || typeof notePath !== "string") {
    throw new Error("A note path is required for read_section");
  }
  if (!section || typeof section !== "string") {
    throw new Error("A section is required for read_section");
  }

  const index = await getIndex(vaultPath);
  const canonical = resolveNoteName(index, notePath);
  const fullPath = resolveNotePath(vaultPath, canonical); // guards traversal
  let info;
  try {
    info = await stat(fullPath);
  } catch {
    throw await noteNotFoundError(
      vaultPath,
      notePath,
      "Note not found or not readable"
    );
  }
  if (info.size > MAX_BYTES) {
    throw new Error("Note file too large (max 10MB)");
  }

  const raw = await readFile(fullPath, "utf-8");
  const body = matter(raw).content;
  const lines = body.split("\n");
  const headings = parseHeadings(body);
  const paths = headingPaths(headings);

  const wanted = section.trim();
  const isPath = wanted.includes(">");
  const norm = (p: string): string =>
    p
      .split(">")
      .map((s) => s.trim())
      .join(" > ");
  const target = isPath ? norm(wanted) : wanted;

  const matches = headings
    .map((h, i) => ({ h, i, path: paths[i] }))
    .filter((m) => (isPath ? m.path === target : m.h.text === wanted));

  if (matches.length === 0) {
    throw new Error(`Section "${section}" not found in ${notePath}`);
  }
  if (matches.length > 1) {
    const candidates = matches.map((m) => m.path).join(", ");
    throw new Error(`Ambiguous section "${section}"; candidates: ${candidates}`);
  }

  const { h, i } = matches[0];
  const bodyStart = h.line + 1;
  let bodyEnd = lines.length;
  for (let j = i + 1; j < headings.length; j++) {
    if (include_subsections) {
      if (headings[j].level <= h.level) {
        bodyEnd = headings[j].line;
        break;
      }
    } else {
      // Exclude subsections: stop at the very next heading of any level.
      bodyEnd = headings[j].line;
      break;
    }
  }

  const content = [lines[h.line], ...lines.slice(bodyStart, bodyEnd)].join("\n");
  return { path: canonical, section: paths[i], level: h.level, content };
}
