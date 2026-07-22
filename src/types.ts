import type { Condition } from "./tools/property-match.js";

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

/** Aggregate, index-derived statistics describing the whole vault. */
export interface VaultStats {
  /** Number of markdown notes in the vault. */
  notes: number;
  /** Total size of all notes in bytes. */
  total_size_bytes: number;
  /** Number of distinct tags across the vault. */
  distinct_tags: number;
  /** Total tag assignments (a tag used in N notes counts N times). */
  tag_assignments: number;
  /** Notes carrying at least one tag. */
  tagged_notes: number;
  /** Notes with no tags at all. */
  untagged_notes: number;
  /** Distinct resolved outbound links, summed across notes. */
  resolved_links: number;
  /** Wikilink references that resolve to no note in the vault. */
  unresolved_links: number;
  /** Notes with at least one resolved outbound link. */
  notes_with_links: number;
  /** Notes with no inbound and no outbound resolved links. */
  orphan_notes: number;
  /** Most recent note modification time (ISO 8601), or null for an empty vault. */
  last_modified: string | null;
  /** Oldest note modification time (ISO 8601), or null for an empty vault. */
  first_modified: string | null;
}

export interface RecentNotesParams {
  /** Maximum number of notes to return. Default: 20. */
  limit?: number;
  /** Only include notes modified/dated on or after this ISO date. */
  since?: string;
  /** Frontmatter field to sort by instead of filesystem mtime (e.g. "updated"). */
  date_field?: string;
  /** Frontmatter conditions, e.g. { status: "active" } or { priority: { gt: 3 } }. */
  where?: Record<string, Condition>;
}

export interface RankedSearchParams {
  /** Free-text query; ranked by BM25 relevance. */
  query: string;
  /** Maximum number of results to return. Default: 10. */
  limit?: number;
}

/** A ranked search hit: a note header plus its relevance score and a snippet. */
export interface RankedSearchResult extends NoteHeader {
  /** BM25 relevance score (higher = more relevant). */
  score: number;
  /** Short excerpt around a matched term (best-effort). */
  snippet: string;
}

export interface PropertySchemaEntry {
  key: string;
  count: number;
  /** Distinct value types observed: string|number|boolean|array|null|date. */
  types: string[];
}

export interface ListPropertiesParams {
  /** Include the `tags` key (already covered by list_tags). Default: true. */
  include_tags?: boolean;
}

export interface PropertyValuesParamsRead {
  key: string;
  limit?: number;
}

export interface PropertyValueCount {
  value: unknown;
  count: number;
}

export interface QueryNotesParams {
  where: Record<string, Condition>;
  match?: "all" | "any";
  limit?: number;
}

export interface GetPropertyParams {
  path: string;
  key: string;
}