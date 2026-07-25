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
  /** Distinct matching files to skip before the window, for pagination. Default 0. */
  offset?: number;
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
    /**
     * 1-based body-relative line (frontmatter stripped) — the same convention
     * as get_outline/list_tasks/set_task_state, so a grep hit can be handed
     * straight to the task/section surface. Null when the hit falls inside
     * the frontmatter block (or the file is unknown to the index).
     */
    body_line: number | null;
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
  /** Distinct matching files skipped before the window by `offset`. */
  files_skipped: number;
  /** Distinct matching files seen beyond the window (`limit`) and not returned. */
  files_omitted: number;
  /** Paths of files whose matches were capped by max_matches_per_file. */
  matches_capped_in: string[];
}

/**
 * The self-describing shape every list-style tool returns: a window of rows
 * plus enough metadata to tell a complete result from a paged one. A window
 * `[offset, offset + limit)` is sliced from the full set: `skipped` rows fall
 * before it, `omitted` rows fall after it. `total = skipped + returned +
 * omitted`; `truncated = omitted > 0` (so `truncated` answers "is there a next
 * page?"). Skipping forward via `offset` never sets `truncated`.
 */
export interface ListResponse<T> {
  /** The returned rows (at most `limit` when a limit was applied). */
  results: T[];
  /** Number of rows in `results` (== results.length). */
  returned: number;
  /** Rows dropped BEFORE the window by `offset` (0 when offset is 0). */
  skipped: number;
  /** Rows dropped AFTER the window by `limit` (0 when nothing was dropped past the window). */
  omitted: number;
  /** True when at least one row was omitted past the window. */
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

/** A markdown heading with its level and 0-based source line index. */
export interface ParsedHeading {
  text: string;
  level: number;
  /** 0-based index of the heading line within the content's line array. */
  line: number;
}

/** A named checkbox-task state; agent-facing so no marker char is needed. */
export type TaskStatus =
  | "open"
  | "done"
  | "in_progress"
  | "cancelled"
  | "forwarded"
  | "other";

/** The subset of TaskStatus that set_task_state can write (excludes "other"). */
export type WritableTaskStatus = Exclude<TaskStatus, "other">;

/** A checkbox task line parsed from a note body. */
export interface ParsedTask {
  /** Task text after the checkbox, trimmed. */
  text: string;
  /** Named state mapped from the raw marker. */
  status: TaskStatus;
  /** Raw marker char inside the brackets (" " for empty/open), verbatim. */
  marker: string;
  /** 0-based index of the task line within the body (exposed 1-based downstream). */
  line: number;
  /** Leading-whitespace column count before the bullet (0 = top-level). */
  indent: number;
}

export interface ListNotesParams {
  /** Restrict to notes under this folder (relative to the vault root). */
  folder?: string;
  /** Restrict to notes carrying these tags (leading '#' optional). */
  tags?: string[];
  /** Semantics of `tags`: "any" (default) or "all". */
  match?: "any" | "all";
  /** Restrict to notes whose frontmatter satisfies these conditions (query_notes syntax). */
  where?: Record<string, Condition>;
  /** Maximum number of notes to return. */
  limit?: number;
  /** Rows to skip before the window, for pagination. Default 0. */
  offset?: number;
}

/** One folder in the vault, as reported by list_folders. */
export interface FolderEntry {
  /** Vault-relative folder path, e.g. "projects/alpha". */
  path: string;
  /** Notes directly in this folder (immediate parent). */
  notes: number;
  /** Notes recursively under this folder (including subfolders). */
  total_notes: number;
  /** Number of direct child folders. */
  subfolders: number;
}

export interface ListFoldersParams {
  /** Restrict to folders under this folder (relative to the vault root). */
  folder?: string;
  /** Relative depth cap: 1 = immediate children of the scope only. */
  depth?: number;
  /** Maximum number of folders to return. */
  limit?: number;
  /** Rows to skip before the window, for pagination. Default 0. */
  offset?: number;
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

/**
 * One source line containing a reported link (the `include_context`
 * decoration). `line` is 1-based and body-relative (frontmatter stripped) —
 * the same convention as get_outline/list_tasks; `text` is the line verbatim.
 */
export interface LinkContextLine {
  line: number;
  text: string;
}

/** `get_links` result when `include_context: true`: every row gains `context`. */
export interface LinksResultWithContext {
  note: string;
  outbound_links: Array<{ target: string; path: string; context: LinkContextLine[] }>;
  unresolved_links: Array<{ target: string; context: LinkContextLine[] }>;
  backlinks: Array<{ path: string; context: LinkContextLine[] }>;
}

export interface TagCount {
  tag: string;
  count: number;
}

export interface FindByTagParams {
  /** Tags to match (with or without leading #). */
  tags: string[];
  /** "all" requires every tag; "any" requires at least one. Default: "any". Governs the tag set only. */
  match?: "all" | "any";
  /** Restrict to notes under this folder (relative to the vault root). */
  folder?: string;
  /** Additional frontmatter conditions (query_notes syntax); all must hold. */
  where?: Record<string, Condition>;
  /** Maximum number of notes to return. */
  limit?: number;
  /** Rows to skip before the window, for pagination. Default 0. */
  offset?: number;
}

export interface RelatedNotesParams {
  /** The note to find neighbours for (relative path, with or without .md). */
  path: string;
  /** Restrict candidates to notes under this folder (relative to the vault root). */
  folder?: string;
  /** Restrict candidates to notes carrying these tags (leading '#' optional). */
  tags?: string[];
  /** Semantics of `tags`: "any" (default) or "all". */
  match?: "any" | "all";
  /** Restrict candidates to notes whose frontmatter satisfies these conditions (query_notes syntax). */
  where?: Record<string, Condition>;
  /** Maximum number of related notes to return. Default 100; 0 = unbounded. */
  limit?: number;
  /** Rows to skip before the window, for pagination. Default 0. */
  offset?: number;
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
  kind: "orphans" | "unresolved_links" | "broken_anchors" | "conflicts";
  /** Cap on the number of returned rows/headers. */
  limit?: number;
  /** Rows/groups to skip before the window, for pagination. Default 0. */
  offset?: number;
  /**
   * Decorate each target with the source line(s) containing it (call-time
   * file reads over the returned window only). Errors on kind "orphans".
   */
  include_context?: boolean;
}

/** A conflict-copy note paired with its original. */
export interface ConflictNoteRow {
  /** The conflict copy's note path (no .md). */
  path: string;
  /** The canonical note it diverged from. */
  original: string;
  /** ISO timestamp of the copy (from its file mtime). */
  created: string;
}

/** Unresolved outbound links from one source note. */
export interface UnresolvedLinkGroup {
  /** Path of the note containing the broken links. */
  source: string;
  /** Raw link targets that do not resolve to any note. */
  targets: string[];
}

/** A source note and its `[[note#heading]]` anchors that match no heading. */
export interface BrokenAnchorGroup {
  source: string;
  targets: { target: string; anchor: string }[];
}

/** `unresolved_links` group when `include_context: true`. */
export interface UnresolvedLinkGroupWithContext {
  source: string;
  targets: Array<{ target: string; context: LinkContextLine[] }>;
}

/** `broken_anchors` group when `include_context: true`. */
export interface BrokenAnchorGroupWithContext {
  source: string;
  targets: Array<{ target: string; anchor: string; context: LinkContextLine[] }>;
}

export interface RecentNotesParams {
  /** Maximum number of notes to return. Default 100; 0 = unbounded. */
  limit?: number;
  /** Only include notes modified/dated on or after this ISO date. */
  since?: string;
  /** Frontmatter field to sort by instead of filesystem mtime (e.g. "updated"). */
  date_field?: string;
  /** Restrict to notes under this folder (relative to the vault root). */
  folder?: string;
  /** Restrict to notes carrying these tags (leading '#' optional). */
  tags?: string[];
  /** Semantics of `tags`: "any" (default) or "all". */
  match?: "any" | "all";
  /** Frontmatter conditions, e.g. { status: "active" } or { priority: { gt: 3 } }. */
  where?: Record<string, Condition>;
  /** Rows to skip before the window, for pagination. Default 0. */
  offset?: number;
}

export interface RankedSearchParams {
  /** Free-text query; ranked by BM25 relevance. */
  query: string;
  /** Maximum number of results to return. Default 100; 0 = unbounded (a positive limit is capped at 100). */
  limit?: number;
  /** Restrict to notes under this folder (relative to the vault root). */
  folder?: string;
  /** Restrict to notes carrying these tags (leading '#' optional). */
  tags?: string[];
  /** Semantics of `tags`: "any" (default) or "all". */
  match?: "any" | "all";
  /** Restrict to notes whose frontmatter satisfies these conditions (query_notes syntax). */
  where?: Record<string, Condition>;
  /** Ranked hits to skip before the window, for pagination (reaches hits past the cap). Default 0. */
  offset?: number;
}

/** A ranked search hit: a note header plus its relevance score and a snippet. */
export interface RankedSearchResult extends NoteHeader {
  /** BM25 relevance score (higher = more relevant). */
  score: number;
  /** Short excerpt around a matched term (best-effort). */
  snippet: string;
}

/** Which identity field a resolve_note query matched a note on. */
export type ResolveMatchField = "title" | "alias" | "basename";

/** One note that matched a resolve_note query. */
export interface ResolveMatch {
  /** Canonical note path (no .md suffix). */
  path: string;
  /** The note's display title. */
  title: string;
  /** The strongest field the query matched on (title > alias > basename). */
  matched_on: ResolveMatchField;
}

/** Result of resolving a human name (title/alias/basename) to note paths. */
export interface ResolveNoteResult {
  /** Echo of the query. */
  query: string;
  /** All matching notes, sorted by path. */
  matches: ResolveMatch[];
  /** The single path iff exactly one note matched, else null. */
  resolved: string | null;
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
  /** Rows to skip before the window, for pagination. Default 0. */
  offset?: number;
}

export interface PropertyValuesParamsRead {
  key: string;
  limit?: number;
  /** Rows to skip before the window, for pagination. Default 0. */
  offset?: number;
}

export interface PropertyValueCount {
  value: unknown;
  count: number;
}

export interface QueryNotesParams {
  where: Record<string, Condition>;
  /** How the `where` conditions combine: "all" (default) or "any". Governs the where conditions only. */
  match?: "all" | "any";
  /** Restrict to notes under this folder (relative to the vault root). */
  folder?: string;
  /** Additionally restrict to notes carrying these tags (leading '#' optional); any of them. */
  tags?: string[];
  limit?: number;
  /** Rows to skip before the window, for pagination. Default 0. */
  offset?: number;
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
  /** Rows to skip before the window, for pagination. Default 0. */
  offset?: number;
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

/** One checkbox task, as returned by list_tasks. */
export interface TaskRow {
  /** Note path (no .md). */
  path: string;
  /** Task text after the checkbox. */
  text: string;
  /** Named state. */
  status: TaskStatus;
  /** Raw marker char. */
  marker: string;
  /** 1-based body line of the task. */
  line: number;
  /** " > "-joined heading-path the task falls under, or null if above all headings. */
  section: string | null;
}

export interface ListTasksParams {
  /** Restrict to notes under this folder (relative to the vault root). */
  folder?: string;
  /** Restrict to notes carrying these tags (leading '#' optional). */
  tags?: string[];
  /** Semantics of `tags`: "any" (default) or "all". */
  match?: "any" | "all";
  /** Restrict to notes whose frontmatter satisfies these conditions (query_notes syntax). */
  where?: Record<string, Condition>;
  /** Restrict to tasks in any of these statuses; omitted = all statuses. */
  status?: TaskStatus[];
  /** Maximum number of tasks to return (default 100; 0 = unbounded). */
  limit?: number;
  /** Rows to skip before the window, for pagination. Default 0. */
  offset?: number;
}

export interface SetTaskStateParams {
  path: string;
  /** Exact task text to match (the part after the checkbox). */
  text?: string;
  /** 1-based line tiebreak / positional address. */
  line?: number;
  /** Target state; "other" is read-only and rejected. */
  status: WritableTaskStatus;
}