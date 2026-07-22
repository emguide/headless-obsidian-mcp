export interface SearchNotesParams {
  pattern: string;
  case_sensitive?: boolean;
  whole_word?: boolean;
  multiline?: boolean;
  context_lines?: number;
}

export interface NoteMetadata {
  [key: string]: any;
}

export interface Note {
  name: string;
  contents: string;
  metadata: NoteMetadata;
  tags: string[];
}

export interface SearchResult {
  path: string;
  matches: Array<{
    line_number: number;
    content: string;
    context_before: string[];
    context_after: string[];
  }>;
}

/** Lightweight description of a note, without its full body. */
export interface NoteHeader {
  /** Relative path without the .md suffix. */
  path: string;
  /** Frontmatter title, else basename. */
  title: string;
  /** Unified tags (frontmatter + inline). */
  tags: string[];
  /** First markdown heading in the body, if any. */
  headline?: string;
  /** File size in bytes. */
  size: number;
  /** Last modified time (ISO 8601). */
  modified: string;
}

export interface ListNotesParams {
  /** Restrict to notes under this folder (relative to the vault root). */
  folder?: string;
  /** Maximum number of notes to return. */
  limit?: number;
}

export interface LinksResult {
  /** The note these links were computed for (relative path, no .md). */
  note: string;
  /** Wikilinks in this note that resolve to a real vault note. */
  outbound_links: Array<{ target: string; path: string }>;
  /** Wikilink targets in this note that do not resolve to any note. */
  unresolved_links: string[];
  /** Notes elsewhere in the vault that link to this note. */
  backlinks: string[];
}

export interface TagCount {
  tag: string;
  count: number;
}

export interface FindByTagParams {
  /** Tags to match (with or without leading #). */
  tags: string[];
  /** "all" requires every tag; "any" requires at least one. Default: "any". */
  match?: "all" | "any";
  /** Maximum number of notes to return. */
  limit?: number;
}

export interface RelatedNotesParams {
  /** The note to find neighbours for (relative path, with or without .md). */
  path: string;
  /** Maximum number of related notes to return. Default: 10. */
  limit?: number;
}

/**
 * A related note: a lightweight header plus the relatedness signals that
 * surfaced it, so an agent knows not just what is related but why.
 */
export interface RelatedNote extends NoteHeader {
  /** Weighted relatedness score (higher = more related). */
  score: number;
  /** Human-readable explanation of each contributing signal. */
  reasons: string[];
  /** Tags shared with the source note. */
  shared_tags: string[];
  /** Notes that both this note and the source link out to (co-reference). */
  shared_links: string[];
  /** Notes that link to both this note and the source (co-citation). */
  shared_backlinks: string[];
  /** True when this note and the source link directly to each other (either way). */
  linked: boolean;
}

export interface RecentNotesParams {
  /** Maximum number of notes to return. Default: 20. */
  limit?: number;
  /** Only include notes modified/dated on or after this ISO date. */
  since?: string;
  /** Frontmatter field to sort by instead of filesystem mtime (e.g. "updated"). */
  date_field?: string;
  /** Frontmatter equality filters, e.g. { status: "active" }. */
  where?: Record<string, unknown>;
}