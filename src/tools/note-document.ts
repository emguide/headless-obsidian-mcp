import matter from "gray-matter";
import { parseHeadings, headingPaths, isHeadingPath } from "./vault.js";

/**
 * An in-memory, editable view of a single note: its parsed frontmatter plus its
 * raw markdown body. Structure-aware edits mutate `data` (frontmatter) and/or
 * `body` (markdown) and are re-serialized on {@link serialize}.
 *
 * Body edits are byte-preserving for the frontmatter: as long as the
 * frontmatter object is not marked dirty, the original frontmatter block is
 * reattached verbatim, so a section edit never reflows the YAML. Frontmatter
 * edits re-serialize the YAML block in canonical form (block-style lists) while
 * leaving the body untouched.
 */
export class NoteDocument {
  data: Record<string, unknown>;
  body: string;
  private readonly originalBlock: string;
  private frontmatterDirty = false;

  private constructor(
    data: Record<string, unknown>,
    body: string,
    originalBlock: string
  ) {
    this.data = data;
    this.body = body;
    this.originalBlock = originalBlock;
  }

  // Matches a leading frontmatter fence and captures nothing; we only need its
  // length so `block + body === raw`.
  private static readonly FENCE = /^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/;

  /** True when `raw` begins with a frontmatter fence — reuses the canonical
   * FENCE regex so callers never re-declare it and risk drift. */
  static hasFrontmatterFence(raw: string): boolean {
    return NoteDocument.FENCE.test(raw);
  }

  static parse(raw: string): NoteDocument {
    const match = NoteDocument.FENCE.exec(raw);
    if (!match) {
      return new NoteDocument({}, raw, "");
    }
    const block = raw.slice(0, match[0].length);
    const body = raw.slice(match[0].length);
    // gray-matter caches parsed results by content string and returns the SAME
    // `data` object on repeat parses of identical text. Our write path mutates
    // doc.data in place, so without a clone those mutations would leak between
    // separate parses of same-content notes. structuredClone isolates each parse.
    // (Edge: a YAML !!binary value becomes a Uint8Array rather than a Buffer —
    // irrelevant for Obsidian frontmatter, which holds scalars and flat arrays.)
    const data = structuredClone((matter(raw).data ?? {})) as Record<string, unknown>;
    return new NoteDocument(data, body, block);
  }

  /** Mark the frontmatter as changed so it is re-serialized on output. */
  markFrontmatterDirty(): void {
    this.frontmatterDirty = true;
  }

  serialize(): string {
    if (!this.frontmatterDirty) {
      return this.originalBlock + this.body;
    }
    if (Object.keys(this.data).length === 0) {
      // Frontmatter emptied out — drop the block entirely.
      return this.body;
    }
    return matter.stringify(this.body, this.data);
  }
}

/* ------------------------------------------------------------------ tags -- */

/** Read the frontmatter tag list, normalizing the `tags`/`tag`, array/string forms. */
export function frontmatterTagList(data: Record<string, unknown>): string[] {
  const raw = data.tags ?? data.tag;
  if (raw == null) return [];
  const list = Array.isArray(raw) ? raw : String(raw).split(/[,\s]+/);
  return list
    .map((t) => String(t).trim().replace(/^#/, ""))
    .filter((t) => t.length > 0);
}

function normalizeTag(tag: string): string {
  const clean = tag.trim().replace(/^#/, "");
  if (!clean) throw new Error("Tag must be a non-empty string");
  return clean;
}

/**
 * Add tags to the frontmatter `tags` list (created if absent). Existing tags
 * are not duplicated. Returns the resulting tag list, or null if nothing
 * changed. Normalizes storage to a `tags:` array, folding a legacy `tag:` key in.
 */
export function addTags(doc: NoteDocument, tags: string[]): string[] | null {
  const current = frontmatterTagList(doc.data);
  const set = new Set(current);
  let changed = false;
  for (const tag of tags) {
    const norm = normalizeTag(tag);
    validateFrontmatterValue("tags", norm);
    if (!set.has(norm)) {
      set.add(norm);
      changed = true;
    }
  }
  // Fold a singular `tag:` key into `tags:` if we are rewriting anyway.
  const hadLegacyKey = doc.data.tag != null && doc.data.tags == null;
  if (!changed && !hadLegacyKey) return null;

  const next = [...set];
  doc.data.tags = next;
  delete doc.data.tag;
  doc.markFrontmatterDirty();
  return next;
}

/**
 * Remove tags from the frontmatter `tags` list. Returns the resulting list, or
 * null if none of the tags were present. An emptied list drops the key.
 */
export function removeTags(doc: NoteDocument, tags: string[]): string[] | null {
  const current = frontmatterTagList(doc.data);
  if (current.length === 0) return null;
  const remove = new Set(tags.map(normalizeTag));
  const next = current.filter((t) => !remove.has(t));
  if (next.length === current.length) return null;

  if (next.length === 0) {
    delete doc.data.tags;
    delete doc.data.tag;
  } else {
    doc.data.tags = next;
    delete doc.data.tag;
  }
  doc.markFrontmatterDirty();
  return next;
}

/* ----------------------------------------------------------- validation -- */

/** Scalar frontmatter values: what a property (or array element) may hold. */
export function isScalar(v: unknown): boolean {
  return (
    v == null ||
    typeof v === "string" ||
    typeof v === "number" ||
    typeof v === "boolean"
  );
}

// Markdown markup we forbid in property strings. Bare URLs / plain punctuation
// are intentionally allowed — only genuine markup is rejected.
const MARKDOWN_PATTERNS: RegExp[] = [
  /!?\[\[[^\]]*\]\]/, // [[wikilink]] or ![[embed]]
  /\[[^\]]*\]\([^)]*\)/, // [text](url)
  /\*\*[^*]+\*\*/, // **bold**
  /__[^_]+__/, // __bold__
  /`[^`]*`/, // `code`
  /^\s*#{1,6}\s+\S/m, // # heading (multiline: detect headings on any line)
  /^\s*[-*+]\s+\S/m, // - / * / + list bullet (multiline: detect bullets on any line)
];

function assertNoMarkdown(key: string, value: string): void {
  if (MARKDOWN_PATTERNS.some((re) => re.test(value))) {
    throw new Error(
      `Property "${key}" contains markdown syntax; frontmatter values must be plain text`
    );
  }
}

/**
 * Enforce the frontmatter property rules on a single value the caller is about
 * to write: no nested objects (maps), no arrays of non-scalars, and no markdown
 * markup inside string values or string array elements. Scalars, null, and flat
 * arrays of scalars pass. Throws a descriptive Error on any violation.
 */
export function validateFrontmatterValue(key: string, value: unknown): void {
  if (Array.isArray(value)) {
    for (const el of value) {
      if (!isScalar(el)) {
        throw new Error(
          `Property "${key}" is an array containing a non-scalar element; ` +
            `only flat arrays of scalars are allowed`
        );
      }
      if (typeof el === "string") assertNoMarkdown(key, el);
    }
    return;
  }
  if (!isScalar(value)) {
    throw new Error(
      `Property "${key}" is a nested object; frontmatter values must be scalars or flat arrays of scalars`
    );
  }
  if (typeof value === "string") assertNoMarkdown(key, value);
}

/* ----------------------------------------------------------- frontmatter -- */

/**
 * Set and/or unset frontmatter fields. `set` keys are merged in (overwriting);
 * `unset` keys are deleted. Returns true if anything changed.
 */
export function setFrontmatter(
  doc: NoteDocument,
  set?: Record<string, unknown>,
  unset?: string[]
): boolean {
  let changed = false;
  if (set) {
    for (const [key, value] of Object.entries(set)) {
      validateFrontmatterValue(key, value);
      doc.data[key] = value;
      changed = true;
    }
  }
  if (unset) {
    for (const key of unset) {
      if (key in doc.data) {
        delete doc.data[key];
        changed = true;
      }
    }
  }
  if (changed) doc.markFrontmatterDirty();
  return changed;
}

/**
 * Add values to the array-valued property `key` (idempotent). Creates the array
 * if the key is absent; promotes an existing scalar to `[old, ...new]`. Each
 * added value is validated. Returns the resulting array, or null if unchanged.
 */
export function addPropertyValues(
  doc: NoteDocument,
  key: string,
  values: unknown[]
): unknown[] | null {
  const current = doc.data[key];
  const base: unknown[] =
    current == null ? [] : Array.isArray(current) ? [...current] : [current];
  let changed = false;
  for (const value of values) {
    validateFrontmatterValue(key, value);
    if (!base.some((v) => v === value)) {
      base.push(value);
      changed = true;
    }
  }
  if (!changed) return null;
  doc.data[key] = base;
  doc.markFrontmatterDirty();
  return base;
}

/**
 * Remove values from the array-valued property `key`. An emptied array drops the
 * key. Returns the resulting array (possibly empty), or null if nothing matched.
 */
export function removePropertyValues(
  doc: NoteDocument,
  key: string,
  values: unknown[]
): unknown[] | null {
  const current = doc.data[key];
  const base: unknown[] =
    current == null ? [] : Array.isArray(current) ? [...current] : [current];
  const remove = new Set(values);
  const next = base.filter((v) => !remove.has(v));
  if (next.length === base.length) return null;

  if (next.length === 0) {
    delete doc.data[key];
  } else {
    doc.data[key] = next;
  }
  doc.markFrontmatterDirty();
  return next;
}

/**
 * Rename frontmatter key `from` to `to`, preserving the value. Throws if `from`
 * is absent or `to` already exists (no silent clobber). Returns true on success.
 */
export function renameProperty(
  doc: NoteDocument,
  from: string,
  to: string
): boolean {
  if (!(from in doc.data)) {
    throw new Error(`Property "${from}" not found`);
  }
  if (to in doc.data) {
    throw new Error(`Property "${to}" already exists`);
  }
  // Rebuild in insertion order with the key swapped in place, so the renamed
  // key keeps its position in the serialized YAML.
  const rebuilt: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc.data)) {
    rebuilt[k === from ? to : k] = v;
  }
  doc.data = rebuilt;
  doc.markFrontmatterDirty();
  return true;
}

/* -------------------------------------------------------------- sections -- */

interface Heading {
  /** Index of the heading line within the body's line array. */
  line: number;
  level: number;
  text: string;
}

/** Find all ATX headings in the body, skipping fenced code blocks. */
function findHeadings(lines: string[]): Heading[] {
  return parseHeadings(lines.join("\n")).map((h) => ({
    line: h.line,
    level: h.level,
    text: h.text,
  }));
}

interface LocatedSection {
  heading: Heading;
  bodyStart: number;
  bodyEnd: number;
}

/** Section boundaries for the heading at index `idx`: its body runs to the next
 * heading of the same or higher level. */
function sectionBounds(
  headings: Heading[],
  idx: number,
  lineCount: number
): LocatedSection {
  const h = headings[idx];
  const bodyStart = h.line + 1;
  let bodyEnd = lineCount;
  for (let j = idx + 1; j < headings.length; j++) {
    if (headings[j].level <= h.level) {
      bodyEnd = headings[j].line;
      break;
    }
  }
  return { heading: h, bodyStart, bodyEnd };
}

/**
 * Existence check for a heading at a given level — the level-scoped locator used
 * by {@link addSection}'s duplicate guard. Returns the first same-level match (or
 * null); multiplicity is not an error here, since finding one is enough to reject
 * a duplicate. This is deliberately NOT the addressing resolver — use
 * {@link resolveSection} to target a section for an edit.
 */
function locateSectionAtLevel(
  lines: string[],
  heading: string,
  level: number
): LocatedSection | null {
  const headings = findHeadings(lines);
  const wanted = heading.trim();
  const idx = headings.findIndex((h) => h.text === wanted && h.level === level);
  if (idx === -1) return null;
  return sectionBounds(headings, idx, lines.length);
}

/**
 * Resolve a section to edit, mirroring `read_section` exactly: `section` is a
 * bare heading (`Log`) or a `" > "`-joined heading-path (`Projects > Log`),
 * detected by the presence of `>`. A bare heading that matches more than one
 * heading throws an ambiguity error listing the candidate full paths, so a
 * wrong-section write fails loudly rather than silently editing the first match.
 * A heading-path matches the fully-qualified path exactly. Throws if not found.
 */
function resolveSection(lines: string[], section: string): LocatedSection {
  const headings = findHeadings(lines);
  const paths = headingPaths(headings);
  const wanted = section.trim();
  const isPath = isHeadingPath(wanted);
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
    throw new Error(`Section "${section}" not found`);
  }
  if (matches.length > 1) {
    const candidates = matches.map((m) => m.path).join(", ");
    throw new Error(`Ambiguous section "${section}"; candidates: ${candidates}`);
  }
  return sectionBounds(headings, matches[0].i, lines.length);
}

function splitBody(body: string): { lines: string[]; trailingNewline: boolean } {
  const trailingNewline = body.endsWith("\n");
  const trimmed = trailingNewline ? body.slice(0, -1) : body;
  return { lines: trimmed.length === 0 ? [] : trimmed.split("\n"), trailingNewline };
}

function joinBody(lines: string[], trailingNewline: boolean): string {
  const joined = lines.join("\n");
  return trailingNewline && joined.length > 0 ? joined + "\n" : joined;
}

/** Drop trailing blank lines from a slice range end (returns new end index). */
function trimTrailingBlanks(lines: string[], end: number, start: number): number {
  let e = end;
  while (e > start && lines[e - 1].trim() === "") e--;
  return e;
}

/**
 * Append a new section (`#`-heading + content) to the note. Inserts at the end
 * of the body by default, or immediately after the section named by `after`.
 * Throws if a section with the same heading and level already exists.
 */
export function addSection(
  doc: NoteDocument,
  heading: string,
  content: string,
  level = 2,
  after?: string
): void {
  if (level < 1 || level > 6) throw new Error("Heading level must be 1-6");
  const { lines, trailingNewline } = splitBody(doc.body);
  if (locateSectionAtLevel(lines, heading, level)) {
    throw new Error(
      `A level-${level} section "${heading}" already exists; ` +
        `use append_to_section or replace_section instead`
    );
  }

  const block = [`${"#".repeat(level)} ${heading.trim()}`, ...content.split("\n")];

  let head: string[];
  let tail: string[];
  if (after) {
    const target = resolveSection(lines, after);
    head = lines.slice(0, trimTrailingBlanks(lines, target.bodyEnd, target.bodyStart));
    tail = lines.slice(target.bodyEnd);
  } else {
    head = lines.slice(0, trimTrailingBlanks(lines, lines.length, 0));
    tail = [];
  }

  const parts: string[] = [...head];
  if (head.length > 0) parts.push(""); // blank line before the new heading
  parts.push(...block);
  if (tail.length > 0) parts.push("", ...tail);

  doc.body = joinBody(parts, trailingNewline || doc.body.length === 0);
}

/**
 * Append text to the body of an existing section (before the next heading).
 * If the section is missing and `create` is true, a new section is added at the
 * end; otherwise it throws.
 */
export function appendToSection(
  doc: NoteDocument,
  heading: string,
  content: string,
  create = false
): void {
  const { lines, trailingNewline } = splitBody(doc.body);
  let target: LocatedSection;
  try {
    target = resolveSection(lines, heading);
  } catch (err) {
    // A missing section is recoverable when `create` is set; an ambiguous one is
    // never silently created — re-throw so the caller disambiguates.
    if (create && err instanceof Error && /not found/.test(err.message)) {
      // A heading-path (`Projects > Log`) addresses a section inside existing
      // structure; with that structure absent there is no well-defined heading
      // to create (which parent? what level?). Refuse rather than fabricate a
      // literal-text `## Projects > Log` heading — matching the fail-loud
      // philosophy the rest of section addressing already follows.
      if (isHeadingPath(heading)) {
        throw new Error(
          `Cannot create section "${heading.trim()}": a heading-path addresses a ` +
            `section inside existing structure and cannot be created. Create the ` +
            `section with a bare heading, or create the parent first.`
        );
      }
      addSection(doc, heading, content);
      return;
    }
    throw err;
  }

  const head = lines.slice(0, trimTrailingBlanks(lines, target.bodyEnd, target.bodyStart));
  const tail = lines.slice(target.bodyEnd);
  const parts = [...head, "", ...content.split("\n")];
  if (tail.length > 0) parts.push("", ...tail);

  doc.body = joinBody(parts, trailingNewline);
}

/**
 * Replace the body of an existing section (heading line kept, everything up to
 * the next same-or-higher heading replaced). Throws if the section is missing.
 */
export function replaceSection(
  doc: NoteDocument,
  heading: string,
  content: string
): void {
  const { lines, trailingNewline } = splitBody(doc.body);
  const target = resolveSection(lines, heading);

  const before = lines.slice(0, target.bodyStart);
  const rest = lines.slice(target.bodyEnd);
  const replacement = content.split("\n");
  const parts = [...before, ...replacement];
  if (rest.length > 0) parts.push("", ...rest);

  doc.body = joinBody(parts, trailingNewline);
}

/**
 * Rename an existing heading, keeping its `#`-level and body intact. `from` is a
 * bare heading or a `" > "`-joined heading-path, resolved with the same fail-loud
 * ambiguity behavior as {@link replaceSection}. Returns the old bare heading text
 * (the leaf of the resolved path) so callers can rewrite inbound `#anchor` links.
 */
export function renameSection(doc: NoteDocument, from: string, to: string): string {
  const { lines, trailingNewline } = splitBody(doc.body);
  const target = resolveSection(lines, from);
  const headingLine = target.heading.line;
  const oldText = target.heading.text;
  const hashes = "#".repeat(target.heading.level);
  lines[headingLine] = `${hashes} ${to.trim()}`;
  doc.body = joinBody(lines, trailingNewline);
  return oldText;
}
