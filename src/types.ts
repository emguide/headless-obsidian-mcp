import type { Condition } from "./tools/property-match.js";

export interface SearchNotesParams {
  pattern: string;
  case_sensitive?: boolean;
  whole_word?: boolean;
  multiline?: boolean;
  context_lines?: number;
  /** Max number of files (result entries). Default 20; 0 = unlimited. */
  limit?: number;
  /** Max matches returned per file. Default 20; 0 = unlimited. */
  max_matches_per_file?: number;
  /** Restrict to notes under this folder (relative to the vault root). */
  folder?: string;
  /** Restrict to notes carrying these tags (leading '#' optional). */
  tags?: string[];
  /** Semantics of `tags`: "any" (default) or "all". */
  match?: "any" | "all";
  /** Restrict to notes whose frontmatter satisfies these conditions (query_notes syntax). */
  where?: Record<string, unknown>;
}

export interface NoteMetadata {
  [key: string]: any;
}

export interface Note {
  path: string;
  contents: string;
  frontmatter: NoteMetadata;
  tags: string[];
}

/** Result of a batch read: successful notes plus per-path failures. */
export interface ReadNotesResult {
  notes: Note[];
  /** One entry per path that could not be read (missing, too large, wrong type). */
  errors: Array<{ path: string; error: string }>;
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

/** The bounded result of `searchNotes`, with truncation metadata. */
export interface SearchNotesResponse {
  /** Matching notes, at most `limit` entries (unless limit is 0). */
  results: SearchResult[];
  /** True if any cap (file or per-file) dropped results. */
  truncated: boolean;
  /** Number of files in `results` (== results.length). */
  files_returned: number;
  /** Distinct matching files seen beyond `limit` and not returned. */
  files_omitted: number;
  /** Paths of files whose matches were capped by max_matches_per_file. */
  matches_capped_in: string[];
}

/**
 * The self-describing shape every list-style tool returns: the (possibly
 * limited) rows plus enough metadata to tell a complete result from a
 * truncated one. `omitted = total - returned`; `truncated = omitted > 0`.
 */
export interface ListResponse<T> {
  /** The returned rows (at most `limit` when a limit was applied). */
  results: T[];
  /** Number of rows in `results` (== results.length). */
  returned: number;
  /** Rows dropped by the limit (0 when nothing was dropped). */
  omitted: number;
  /** True when at least one row was omitted. */
  truncated: boolean;
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

/** The bounded result of `listNotes`, with truncation metadata. */
export interface ListNotesResponse {
  /** Matching note headers, at most `limit` entries (unless limit is 0). */
  notes: NoteHeader[];
  /** Notes matching the folder filter, before the limit was applied. */
  total: number;
  /** Number of notes in `notes` (== notes.length). */
  returned: number;
  /** True if the limit dropped notes (total > returned). */
  truncated: boolean;
}

/** A markdown heading with its level and 0-based source line index. */
export interface ParsedHeading {
  text: string;
  level: number;
  /** 0-based index of the heading line within the content's line array. */
  line: number;
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

/** Parameters for list_vault_issues. */
export interface ListVaultIssuesParams {
  kind: "orphans" | "unresolved_links";
  /** Cap on the number of returned rows/headers. */
  limit?: number;
}

/** Unresolved outbound links from one source note. */
export interface UnresolvedLinkGroup {
  /** Path of the note containing the broken links. */
  source: string;
  /** Raw link targets that do not resolve to any note. */
  targets: string[];
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

export interface OutlineEntry {
  heading: string;
  level: number;
  /** Full " > "-joined heading-path (disambiguating address). */
  path: string;
  /** 1-based line number of the heading in the note body. */
  line: number;
  /** True when the bare heading text is non-unique in this note. */
  ambiguous: boolean;
}

export interface OutlineResult {
  path: string;
  outline: OutlineEntry[];
}

export interface ReadSectionParams {
  path: string;
  section: string;
  include_subsections?: boolean;
}

export interface SectionResult {
  path: string;
  /** The resolved full heading-path. */
  section: string;
  level: number;
  /** Heading line + body slice, verbatim. Frontmatter excluded. */
  content: string;
}

/** Parameters for list_files (non-markdown file discovery). */
export interface ListFilesParams {
  /** Restrict to files under this folder (relative to the vault root). */
  folder?: string;
  /** Filter by extension; leading dot optional, case-insensitive (e.g. "png"). */
  extension?: string;
  /** Maximum number of files to return. */
  limit?: number;
}

/** A non-markdown vault file with lightweight filesystem metadata. */
export interface VaultFileEntry {
  /** Vault-relative path, forward-slash, extension preserved. */
  path: string;
  /** File size in bytes. */
  size: number;
  /** Last modified time (ISO 8601). */
  modified: string;
  /** Lowercased extension without the dot (e.g. "png"). */
  extension: string;
}