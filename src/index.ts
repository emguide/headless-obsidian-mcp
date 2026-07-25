#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import process from "node:process";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { searchNotes } from "./tools/search.js";
import { searchNotesRanked } from "./tools/search-ranked.js";
import { readNotes } from "./tools/read.js";
import { listNotes } from "./tools/list.js";
import { getLinks } from "./tools/links.js";
import { getOutline } from "./tools/outline.js";
import { readSection } from "./tools/section.js";
import { listTasks } from "./tools/tasks.js";
import { listTags, findByTag } from "./tools/tags.js";
import { listRecentNotes } from "./tools/recent.js";
import { getRelatedNotes } from "./tools/related.js";
import { getFrontmatter } from "./tools/frontmatter.js";
import { resolveNote } from "./tools/resolve.js";
import { resolveDailyNote } from "./tools/daily-notes.js";
import { getVaultStats } from "./tools/stats.js";
import { listVaultIssues } from "./tools/vault-issues.js";
import { listFiles } from "./tools/files.js";
import { listFolders } from "./tools/folders.js";
import { listTemplates, applyTemplate, insertTemplate } from "./tools/templates.js";
import { resolveServerConfig, selectConfigSection } from "./tools/config.js";
import {
  listProperties,
  getPropertyValues,
  queryNotes,
  getProperty,
} from "./tools/properties.js";
import {
  writeNote,
  appendNote,
  prependNote,
  deleteNote,
  moveNote,
  moveFile,
  patchNote,
  addTag,
  removeTag,
  setNoteFrontmatter,
  addNoteSection,
  appendNoteSection,
  replaceNoteSection,
  addNotePropertyValues,
  removeNotePropertyValues,
  renameNoteProperty,
  renameSectionInVault,
  setTaskState,
  WriteNoteParams,
  AppendNoteParams,
  PrependNoteParams,
  MoveNoteParams,
  MoveFileParams,
  PatchNoteParams,
  TagParams,
  SetFrontmatterParams,
  AddSectionParams,
  SectionEditParams,
  PropertyValuesParams,
  RenamePropertyParams,
  RenameSectionParams,
} from "./tools/write.js";
import { bulkEdit, BulkEditParams } from "./tools/bulk.js";
import {
  SearchNotesParams,
  ListNotesParams,
  FindByTagParams,
  RecentNotesParams,
  RelatedNotesParams,
  RankedSearchParams,
  ListPropertiesParams,
  PropertyValuesParamsRead,
  QueryNotesParams,
  GetPropertyParams,
  ReadSectionParams,
  ListVaultIssuesParams,
  ListFilesParams,
  ListFoldersParams,
  ListTasksParams,
  SetTaskStateParams,
} from "./types.js";
import { TOOLS_ENV } from "./tools/env-flags.js";
import {
  DEFAULT_POLICY,
  GATED_TOOL_NAMES,
  resolveToolPolicy,
  ToolPolicy,
} from "./tools/tool-policy.js";
import { resolveGitSyncMode } from "./tools/env-flags.js";
import { startSyncTimer } from "./tools/sync-timer.js";

const VAULT_PATH = process.env.OBSIDIAN_VAULT_PATH;
if (!VAULT_PATH) {
  console.error("Error: OBSIDIAN_VAULT_PATH environment variable is required");
  process.exit(1);
}

// Resolve the OBSIDIAN_TOOLS policy once, fail-loud: a typo'd selector or the
// retired OBSIDIAN_ALLOW_WRITES switch kills startup rather than silently
// exposing the wrong tool surface.
let TOOL_POLICY: ToolPolicy;
try {
  TOOL_POLICY = resolveToolPolicy();
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
const EXPOSED_TOOLS = TOOL_POLICY.exposed;

// Resolve the git-sync mode once, fail-loud: a typo'd OBSIDIAN_GIT_SYNC value
// kills startup cleanly.
try {
  const { warning: syncWarning } = resolveGitSyncMode();
  if (syncWarning) console.error(`Warning: ${syncWarning}`);
  // Start the background sync loop (no-op unless mode is "timer").
  startSyncTimer(VAULT_PATH);
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const server = new Server(
  {
    name: "headless-obsidian-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
    // The shared conventions are stated once here instead of being restated in
    // every tool description; tool descriptions carry only their deviations.
    instructions:
      "Headless MCP server for an Obsidian vault. All paths (notes, files, folders) are relative to the vault root; on notes the .md extension is optional.\n\n" +
      "Pagination convention: every list-style tool (the list_* tools plus search_notes_ranked, find_by_tag, query_notes, and get_related_notes) returns { results, returned, skipped, omitted, truncated } — a window [offset, offset + limit) over the full result set. limit defaults to 100 (0 = unbounded); offset defaults to 0, and skipping past the end returns an empty result, not an error. skipped counts rows dropped before the window by offset, omitted counts rows dropped after it by limit, so total = skipped + returned + omitted; truncated (omitted > 0) means a next page exists. search_notes paginates over matching files with the parallel names files_skipped / files_omitted. Deviations are noted on the tool itself.\n\n" +
      "Filter convention: every note-selecting tool accepts the same optional candidate filters — folder (path prefix), tags (with match: 'any' default | 'all'), and where (frontmatter conditions, same syntax as query_notes). search_notes, search_notes_ranked, list_notes, list_recent_notes, find_by_tag, query_notes, list_tasks, and get_related_notes all share this vocabulary, so a scoped question ('active notes in projects/ tagged #work') needs no client-side join. On a tool whose primary filter is tags (find_by_tag) or where (query_notes), match governs that primary filter and the secondary filter applies with its default (tags: any, where: all).\n\n" +
      "Link-integrity convention: every content-writing tool (write_note, append_note, prepend_note, patch_note, add_section, append_to_section, replace_section, set_task_state) returns, alongside its normal fields, unresolved_links (wikilink targets in the resulting note that resolve to no vault note) and broken_anchors ([[note#heading]] links whose note resolves but whose heading anchor matches nothing, as { target, anchor }). Both are report-only — the write is never blocked or modified, exactly like delete_note's dangled_backlinks — so an agent learns immediately when a write introduces a broken [[wikilink]] instead of discovering it later via list_vault_issues. Empty arrays mean the write left the graph intact.\n\n" +
      "Link-context convention: get_links, delete_note, and list_vault_issues (kinds unresolved_links/broken_anchors) accept opt-in include_context: true, decorating each reported link row with context — the source line(s) containing that link, as { line, text } pairs. line is 1-based and body-relative (frontmatter stripped, the same convention as get_outline/list_tasks); text is the line verbatim, so it can be fed straight into patch_note's find. Context is computed by call-time file reads (bounded by the returned window on list_vault_issues), so leave the flag off when you only need the paths.\n\n" +
      "Not-found convention: a missing-note error may append up to 3 'Did you mean' candidate paths, matched by resolve_note's exact semantics (case-insensitive title/alias/basename — never fuzzy). Suggestions are advisory: the tool never substitutes a candidate for the requested path.\n\n" +
      "Git-sync convention: when OBSIDIAN_GIT_SYNC is enabled (commit | every-write | timer), every write is committed with a tool-derived message; every-write also pulls+pushes per write and timer syncs on a background interval. A pull conflict never blocks or discards — the local version is kept aside as a '<note> (conflicted YYYY-MM-DD HHMMSS)' copy and remote is taken as canonical. Discover unreconciled copies via list_vault_issues kind:'conflicts' (also counted by get_vault_stats.conflict_notes); the active mode and last sync state are in get_config's sync section.\n\n" +
      "Tool exposure is operator-configured (OBSIDIAN_TOOLS): this server may expose a subset of the full tool surface. get_config's tools section reports the active policy and the exposed/excluded tool names.",
  }
);

const TOOL_DEFINITIONS = [
      {
        name: "search_notes",
        description: "Search notes with ripgrep, optionally scoped by folder, tags, or a frontmatter where filter (index-resolved candidates, then rg over just those notes). Paginates over matching files: returns { results, truncated, files_returned, files_skipped, files_omitted, matches_capped_in }. Each match carries line_number (file-absolute, ripgrep's) and body_line (1-based body-relative with frontmatter stripped — the same line convention as get_outline/list_tasks/set_task_state, so a hit can be handed straight to those tools; null for hits inside the frontmatter block or in a file the index does not track).",
        inputSchema: {
          type: "object",
          properties: {
            pattern: {
              type: "string",
              description: "The search pattern to use with ripgrep"
            },
            case_sensitive: {
              type: "boolean",
              description: "Case sensitive search (default: false)"
            },
            whole_word: {
              type: "boolean",
              description: "Match whole words only"
            },
            multiline: {
              type: "boolean",
              description: "Enable multiline matching"
            },
            context_lines: {
              type: "number",
              description: "Number of context lines to show (default: 5)"
            },
            limit: {
              type: "number",
              description: "Max number of files (result entries) to return (default: 20, 0 = unlimited)"
            },
            max_matches_per_file: {
              type: "number",
              description: "Max matches to return per file (default: 20, 0 = unlimited)"
            },
            offset: {
              type: "number",
              description: "Matching files to skip, for pagination (default 0)."
            },
            folder: { type: "string", description: "Restrict to notes under this folder." },
            tags: { type: "array", items: { type: "string" }, description: "Restrict to notes carrying these tags (leading '#' optional)." },
            match: { type: "string", enum: ["any", "all"], description: "Semantics of tags: 'any' (default) or 'all'." },
            where: { type: "object", description: "Restrict to notes whose frontmatter satisfies these conditions (query_notes syntax)." }
          },
          required: ["pattern"]
        }
      },
      {
        name: "search_notes_ranked",
        description:
          "Full-text search ranked by BM25 relevance, optionally scoped by folder, tags, or a frontmatter where filter. Returns the most relevant notes first (title/heading/tag matches boosted) as note headers with score and snippet. Complements search_notes (which is literal/regex, unranked). A positive limit is capped at 100; offset pages past the cap.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Free-text query (max 1000 chars). Multi-word queries are ranked by relevance.",
            },
            limit: {
              type: "number",
              description: "Maximum number of results (default 100; 0 = unbounded; a positive limit is capped at 100).",
            },
            offset: {
              type: "number",
              description: "Ranked hits to skip, for pagination (default 0).",
            },
            folder: { type: "string", description: "Restrict to notes under this folder." },
            tags: { type: "array", items: { type: "string" }, description: "Restrict to notes carrying these tags (leading '#' optional)." },
            match: { type: "string", enum: ["any", "all"], description: "Semantics of tags: 'any' (default) or 'all'." },
            where: { type: "object", description: "Restrict to notes whose frontmatter satisfies these conditions (query_notes syntax)." },
          },
          required: ["query"],
        },
      },
      {
        name: "read_notes",
        description: "Read one or more Obsidian notes by their relative paths. Returns { notes, errors }: notes is the array of parsed notes (path, contents, frontmatter, tags); errors lists any paths that could not be read (missing/too large), so one bad path never fails the batch. Path traversal still errors the whole call.",
        inputSchema: {
          type: "object",
          properties: {
            paths: {
              type: "array",
              items: { type: "string" },
              description: "Note paths (.md optional)"
            }
          },
          required: ["paths"]
        }
      },
      {
        name: "list_notes",
        description: "List notes in the vault as lightweight headers (path, title, tags, first heading, size, modified time) without full contents. Use it to discover what exists and orient before searching or reading. Scope with folder/tags/where/match (match governs tags; where conditions all apply).",
        inputSchema: {
          type: "object",
          properties: {
            folder: {
              type: "string",
              description: "Restrict to notes under this folder."
            },
            tags: { type: "array", items: { type: "string" }, description: "Restrict to notes carrying these tags (leading '#' optional)." },
            match: { type: "string", enum: ["any", "all"], description: "Semantics of tags: 'any' (default) or 'all'." },
            where: { type: "object", description: "Restrict to notes whose frontmatter satisfies these conditions (query_notes syntax)." },
            limit: {
              type: "number",
              description: "Maximum number of notes to return (default 100; 0 = unbounded)"
            },
            offset: {
              type: "number",
              description: "Rows to skip, for pagination (default 0)."
            }
          }
        }
      },
      {
        name: "list_files",
        description: "List non-markdown files in the vault (attachments, images, PDFs) as { path, size, modified, extension } rows, e.g. to find a file to move. Never includes notes (use list_notes).",
        inputSchema: {
          type: "object",
          properties: {
            folder: { type: "string", description: "Restrict to files under this folder." },
            extension: { type: "string", description: "Filter by extension; leading dot optional, case-insensitive (e.g. 'png')." },
            limit: {
              type: "number",
              description: "Maximum number of files to return (default 100; 0 = unbounded)"
            },
            offset: {
              type: "number",
              description: "Rows to skip, for pagination (default 0)."
            }
          }
        }
      },
      {
        name: "list_folders",
        description: "Enumerate the vault's folders as { path, notes (direct), total_notes (recursive), subfolders } rows sorted by path — the folder-level counterpart to list_notes, for seeing the vault's shape before searching or reading. Notes-only: attachment-only folders do not appear (use list_files), and root-level notes contribute no folder.",
        inputSchema: {
          type: "object",
          properties: {
            folder: {
              type: "string",
              description: "Restrict to folders under this folder."
            },
            depth: {
              type: "number",
              description: "Relative depth cap: 1 = immediate children of the scope (or top-level folders when no folder is given)"
            },
            limit: {
              type: "number",
              description: "Maximum number of folders to return (default 100; 0 = unbounded)"
            },
            offset: {
              type: "number",
              description: "Rows to skip, for pagination (default 0)."
            }
          }
        }
      },
      {
        name: "list_templates",
        description: "Enumerate the vault's core Templates-plugin template folder as { path, name, size, modified } headers. Folder resolved from .obsidian/templates.json (or the OBSIDIAN_TEMPLATE_FOLDER override); errors if neither is configured. Read-only. Core Templates only — Templater scripting is not supported.",
        inputSchema: {
          type: "object",
          properties: {
            limit: { type: "number", description: "Maximum number of templates to return (default 100; 0 = unbounded)" },
            offset: { type: "number", description: "Rows to skip, for pagination (default 0)." }
          }
        }
      },
      {
        name: "get_config",
        description: "Report the server's own configuration (not vault contents). Returns { template: { folder, date_format, time_format }, daily: { folder, format, template }, writes: { writes_enabled, git_sync }, sync: { mode, interval, remote, last_sync, last_error }, vault: { path }, tools: { policy, exposed, excluded } }. Optional section narrows the result to one unwrapped section. template.folder and daily.folder are null when unconfigured (does not error). writes_enabled means at least one write tool is exposed. sync section reports the active git-sync mode and current state. Read-only; never excluded by OBSIDIAN_TOOLS — this is how you discover the active tool policy.",
        inputSchema: {
          type: "object",
          properties: {
            section: {
              type: "string",
              enum: ["template", "daily", "writes", "sync", "vault", "tools"],
              description: "Return just this section, unwrapped. Omit for the whole config object."
            }
          }
        }
      },
      {
        name: "get_links",
        description: "Resolve the Obsidian link graph for a note: outbound [[wikilinks]] resolved to real notes, links that resolve to nothing, and backlinks (other notes that link to this one). Use it to traverse related knowledge. With include_context: true, every row gains the linking line(s) — 'who references this note, and why' in one call (see the link-context convention).",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Note path (.md optional)"
            },
            include_context: {
              type: "boolean",
              description: "Decorate every link row with the source line(s) containing it, as { line, text }. Call-time file reads — leave off (default) when only the paths are needed."
            }
          },
          required: ["path"]
        }
      },
      {
        name: "get_outline",
        description: "Return a note's heading structure (outline) without reading its body: each heading with its level, 1-based line number, full \" > \"-joined heading-path, and an ambiguity flag. Use it to see what sections exist before reading or editing one.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Note path (.md optional)"
            }
          },
          required: ["path"]
        }
      },
      {
        name: "read_section",
        description: "Read a single section of a note without loading the whole note. Address the section by bare heading (when unique) or by a \" > \"-joined heading-path (e.g. \"Projects > Log\") when the heading repeats. Returns the heading plus its own body; set include_subsections to include nested subsections.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Note path (.md optional)"
            },
            section: {
              type: "string",
              description: "Heading text, or a \" > \"-joined heading-path when the heading is ambiguous"
            },
            include_subsections: {
              type: "boolean",
              description: "Include nested subsections in the returned content (default false)"
            }
          },
          required: ["path", "section"]
        }
      },
      {
        name: "list_tasks",
        description: "List checkbox tasks (- [ ] ...) across the vault as structured rows (path, text, status, raw marker, 1-based line, enclosing heading-path). status is a named state: open|done|in_progress|cancelled|forwarded|other. Index-backed. Scope with folder/tags/where/match and an optional status filter (any of the listed statuses).",
        inputSchema: {
          type: "object",
          properties: {
            folder: { type: "string", description: "Restrict to notes under this folder." },
            tags: { type: "array", items: { type: "string" }, description: "Restrict to notes carrying these tags (leading '#' optional)." },
            match: { type: "string", enum: ["any", "all"], description: "Semantics of tags: 'any' (default) or 'all'." },
            where: { type: "object", description: "Restrict to notes whose frontmatter satisfies these conditions (query_notes syntax)." },
            status: {
              type: "array",
              items: { type: "string", enum: ["open", "done", "in_progress", "cancelled", "forwarded", "other"] },
              description: "Restrict to tasks in any of these statuses; omitted = all.",
            },
            limit: { type: "number", description: "Maximum number of tasks to return (default 100; 0 = unbounded)." },
            offset: { type: "number", description: "Rows to skip, for pagination (default 0)." },
          },
        },
      },
      {
        name: "list_tags",
        description: "List every tag used across the vault with the number of notes using it, sorted by frequency. Unifies inline #tags and frontmatter tags:. Use it to see the vault's topic index. No limit: the full set is returned (offset still pages; truncated is always false).",
        inputSchema: {
          type: "object",
          properties: {
            offset: {
              type: "number",
              description: "Rows to skip, for pagination (default 0)."
            }
          }
        }
      },
      {
        name: "find_by_tag",
        description: "Find notes matching one or more tags, as note headers. High-precision retrieval based on human curation. Narrow further with folder and a frontmatter where filter (all conditions apply); match governs the tag set only.",
        inputSchema: {
          type: "object",
          properties: {
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Tags to match (with or without leading #)"
            },
            match: {
              type: "string",
              enum: ["any", "all"],
              description: 'Require "any" (default) or "all" of the tags (governs the tag set only)'
            },
            folder: { type: "string", description: "Restrict to notes under this folder." },
            where: { type: "object", description: "Additional frontmatter conditions (query_notes syntax); all must hold." },
            limit: {
              type: "number",
              description: "Maximum number of notes to return (default 100; 0 = unbounded)"
            },
            offset: {
              type: "number",
              description: "Rows to skip, for pagination (default 0)."
            }
          },
          required: ["tags"]
        }
      },
      {
        name: "list_recent_notes",
        description: "List notes ordered by recency (newest first), as lightweight headers. Sort by filesystem mtime or a frontmatter date field, with an optional since cutoff. Scope with folder/tags/where/match (match governs tags; where conditions all apply). Use it to find current material.",
        inputSchema: {
          type: "object",
          properties: {
            limit: {
              type: "number",
              description: "Maximum number of notes to return (default 100; 0 = unbounded)"
            },
            since: {
              type: "string",
              description: "Only include notes on or after this ISO date"
            },
            date_field: {
              type: "string",
              description: "Frontmatter field to sort by instead of filesystem mtime (e.g. 'updated')"
            },
            folder: { type: "string", description: "Restrict to notes under this folder." },
            tags: { type: "array", items: { type: "string" }, description: "Restrict to notes carrying these tags (leading '#' optional)." },
            match: { type: "string", enum: ["any", "all"], description: "Semantics of tags: 'any' (default) or 'all'." },
            where: {
              type: "object",
              description: "Frontmatter conditions (query_notes syntax), e.g. { \"status\": \"active\" } or { \"priority\": { \"gt\": 3 } }."
            },
            offset: {
              type: "number",
              description: "Rows to skip, for pagination (default 0)."
            }
          }
        }
      },
      {
        name: "get_related_notes",
        description: "Find the notes most related to a given note, ranked, without embeddings: a transparent blend of shared tags, direct links, shared out-links (co-reference), and shared backlinks (co-citation). Results are note headers with score and the reasons each surfaced. Use it for associative recall - 'I'm looking at X, what else is relevant?'. Narrow the scored candidate pool with folder/tags/where/match (match governs tags; where conditions all apply); the source note is never itself a candidate.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Note path (.md optional)"
            },
            folder: { type: "string", description: "Restrict candidates to notes under this folder." },
            tags: { type: "array", items: { type: "string" }, description: "Restrict candidates to notes carrying these tags (leading '#' optional)." },
            match: { type: "string", enum: ["any", "all"], description: "Semantics of tags: 'any' (default) or 'all'." },
            where: { type: "object", description: "Restrict candidates to notes whose frontmatter satisfies these conditions (query_notes syntax)." },
            limit: {
              type: "number",
              description: "Maximum number of related notes to return (default 100; 0 = unbounded)"
            },
            offset: {
              type: "number",
              description: "Rows to skip, for pagination (default 0)."
            }
          },
          required: ["path"]
        }
      },
      {
        name: "get_frontmatter",
        description: "Read just a note's parsed frontmatter (YAML metadata), without its body. A cheap way to inspect a note's status, aliases, dates, or custom fields before reading or editing the whole note.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Note path (.md optional)"
            }
          },
          required: ["path"]
        }
      },
      {
        name: "resolve_note",
        description: "Resolve a human-facing note name (frontmatter title, an alias, or the file basename) to its canonical note path — an exact, case-insensitive, index-backed lookup that removes the search-then-guess round trip for \"what's the path of the note called X?\". Matching is exact, never fuzzy (use search_notes_ranked for approximate matching). Returns { query, matches, resolved }: matches is the array of { path, title, matched_on } (matched_on is \"title\"|\"alias\"|\"basename\"; a note matching on several fields appears once, labeled with its strongest field, title > alias > basename), sorted by path; resolved is the single path when exactly one note matches, else null (ambiguous or no match — it never guesses).",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "The human-facing name to resolve (title, alias, or basename)"
            }
          },
          required: ["query"]
        }
      },
      {
        name: "resolve_daily_note",
        description: "Map a calendar date to its canonical daily-note path, using the Daily Notes core plugin's own configuration (.obsidian/daily-notes.json: folder, format, template; OBSIDIAN_DAILY_FOLDER overrides the folder). Returns { date, path, exists, template }: date is the resolved ISO day, path the canonical note path (no .md; slashes in the configured format nest folders, as in Obsidian), exists whether the note is on disk, template the configured daily template path or null. Read-only — existing tools do the rest: apply_template (which accepts the returned template path) or write_note to create it, append_note/append_to_section to log into it, read_notes/read_section to read it. Errors when daily notes are not configured. Note: {{date}}/{{time}} in an applied template expand with the current moment, not the resolved day — exact Obsidian parity for today, a known caveat when creating past/future notes.",
        inputSchema: {
          type: "object",
          properties: {
            date: {
              type: "string",
              description: "\"YYYY-MM-DD\", or \"today\" (default) | \"yesterday\" | \"tomorrow\""
            }
          }
        }
      },
      {
        name: "list_properties",
        description: "List every frontmatter property key used across the vault with the number of notes using it and the distinct value types observed (string/number/boolean/array/null/date), sorted by frequency. The vault's property schema; like list_tags but for arbitrary properties. No limit: the full set is returned (offset still pages; truncated is always false).",
        inputSchema: {
          type: "object",
          properties: {
            include_tags: { type: "boolean", description: "Include the tags key (default: true)" },
            offset: { type: "number", description: "Rows to skip, for pagination (default 0)." }
          }
        }
      },
      {
        name: "list_property_values",
        description: "List the distinct values of one frontmatter property as { value, count } rows, most frequent first. Array-valued properties count each element. A faceted index for a single key.",
        inputSchema: {
          type: "object",
          properties: {
            key: { type: "string", description: "The frontmatter property key to facet" },
            limit: { type: "number", description: "Maximum number of distinct values to return (default 100; 0 = unbounded)" },
            offset: { type: "number", description: "Rows to skip, for pagination (default 0)." }
          },
          required: ["key"]
        }
      },
      {
        name: "query_notes",
        description: "Find notes whose frontmatter satisfies a set of conditions, as note headers. Each condition is a bare scalar (equality / array-membership) or an operator object { eq, ne, gt, gte, lt, lte, exists, contains }. Comparisons are type-aware (numbers, ISO dates, strings). match: all (default) or any (governs the where conditions only). Narrow further with folder and tags (any of them).",
        inputSchema: {
          type: "object",
          properties: {
            where: { type: "object", description: "Map of property key to condition (scalar or { eq/ne/gt/gte/lt/lte/exists/contains })" },
            match: { type: "string", enum: ["all", "any"], description: "Require all (default) or any of the where conditions (governs the where conditions only)" },
            folder: { type: "string", description: "Restrict to notes under this folder." },
            tags: { type: "array", items: { type: "string" }, description: "Additionally restrict to notes carrying these tags (leading '#' optional); any of them." },
            limit: { type: "number", description: "Maximum number of notes to return (default 100; 0 = unbounded)" },
            offset: { type: "number", description: "Rows to skip, for pagination (default 0)." }
          },
          required: ["where"]
        }
      },
      {
        name: "get_property",
        description: "Read a single frontmatter property value from one note. Returns { path, key, value, present }; present distinguishes an absent key from a key explicitly set to null.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Note path (.md optional)" },
            key: { type: "string", description: "The frontmatter property key to read" }
          },
          required: ["path", "key"]
        }
      },
      {
        name: "get_vault_stats",
        description: "Summarize the whole vault: note and tag counts, link-graph health (resolved vs unresolved links, orphan notes), total size, and modification-time bounds. Use it to get a quick sense of the vault's scale and health.",
        inputSchema: {
          type: "object",
          properties: {}
        }
      },
      {
        name: "list_vault_issues",
        description: "List the vault-hygiene issues get_vault_stats only counts. kind:'orphans' returns note headers for notes with no inbound or outbound resolved links; kind:'unresolved_links' returns, grouped by source note, the wikilink targets that resolve to nothing (the notes with broken links); kind:'broken_anchors' returns, grouped by source note, the [[note#heading]] anchors that resolve to a note but not to any heading in it; kind:'conflicts' returns the unreconciled conflict copies (notes named \"… (conflicted YYYY-MM-DD HHMMSS)\") each paired with the original note they diverged from. Index-backed. For the grouped kinds, limit/offset count groups (source notes), not individual targets.",
        inputSchema: {
          type: "object",
          properties: {
            kind: {
              type: "string",
              enum: ["orphans", "unresolved_links", "broken_anchors", "conflicts"],
              description: "Which issue list to return."
            },
            limit: {
              type: "number",
              description: "Maximum number of rows/groups to return (default 100; 0 = unbounded). For unresolved_links, this counts groups (source notes), not individual targets."
            },
            offset: {
              type: "number",
              description: "Rows/groups to skip, for pagination (default 0)."
            },
            include_context: {
              type: "boolean",
              description: "For kinds unresolved_links/broken_anchors: decorate each target with the source line(s) containing it, as { line, text } (call-time reads over the returned window only). Errors on kind orphans."
            }
          },
          required: ["kind"]
        }
      },
      {
        name: "write_note",
        description: "Create a note, or overwrite an existing one. Refuses to overwrite unless overwrite:true is passed. Pass structured frontmatter via the frontmatter param (validated, serialized canonically) or inline in content (also validated) — not both. Use the structure-aware tools (add_section, set_frontmatter, add_tag) for surgical edits instead of rewriting a whole note. Returns { path, created } plus unresolved_links and broken_anchors for the resulting note (report-only; see the link-integrity convention).",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Note path (.md optional)" },
            content: { type: "string", description: "Note content. May include a leading frontmatter block (validated), or pass frontmatter via the frontmatter param and give body-only content here." },
            overwrite: { type: "boolean", description: "Allow replacing an existing note (default: false)" },
            frontmatter: { type: "object", description: "Optional frontmatter fields, validated and serialized canonically. When given, content is the body only. Do not also put a frontmatter block in content." }
          },
          required: ["path", "content"]
        }
      },
      {
        name: "append_note",
        description: "Append text to the end of an existing note. Set create:true to create the note if it is missing. Returns { path, created } plus unresolved_links and broken_anchors for the resulting note (report-only; see the link-integrity convention).",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Note path (.md optional)" },
            content: { type: "string", description: "Text to append. When this call creates the note (create:true, note missing), a leading frontmatter block is validated." },
            create: { type: "boolean", description: "Create the note if it does not exist (default: false)" }
          },
          required: ["path", "content"]
        }
      },
      {
        name: "prepend_note",
        description: "Prepend text to the start of a note's body. Any frontmatter block is preserved and the text is inserted after it. Set create:true to create the note if it is missing. Returns { path, created } plus unresolved_links and broken_anchors for the resulting note (report-only; see the link-integrity convention).",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Note path (.md optional)" },
            content: { type: "string", description: "Text to prepend. When this call creates the note (create:true, note missing), a leading frontmatter block is validated; otherwise it is inserted after any existing frontmatter." },
            create: { type: "boolean", description: "Create the note if it does not exist (default: false)" }
          },
          required: ["path", "content"]
        }
      },
      {
        name: "delete_note",
        description: "Delete a note. Trash-safe by default (moved to .trash, recoverable); pass permanent:true to unlink. Returns { path, deleted, trashed, trash_path?, dangled_backlinks } where dangled_backlinks lists the notes that linked to the deleted note and now have a broken [[wikilink]]. With include_context: true, each dangled backlink gains the linking line(s), so the broken references can be fixed without re-reading each source.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Note path (.md optional)" },
            permanent: { type: "boolean", description: "Permanently delete instead of moving to .trash (default: false)" },
            include_context: { type: "boolean", description: "Decorate each dangled backlink with the source line(s) linking to the deleted note, as { line, text } (default: false)" }
          },
          required: ["path"]
        }
      },
      {
        name: "move_note",
        description: "Move or rename a note. By default every wikilink elsewhere in the vault that pointed to the old location is rewritten to the new one, so the link graph is never broken. Refuses to overwrite an existing destination unless overwrite:true.",
        inputSchema: {
          type: "object",
          properties: {
            from: { type: "string", description: "Current note path (.md optional)" },
            to: { type: "string", description: "New note path (.md optional)" },
            overwrite: { type: "boolean", description: "Allow replacing an existing note at the destination (default: false)" },
            update_links: { type: "boolean", description: "Rewrite wikilinks in other notes that point to this note (default: true)" }
          },
          required: ["from", "to"]
        }
      },
      {
        name: "rename_section",
        description: "Rename a heading in a note and rewrite every inbound [[note#heading]] anchor across the vault to the new heading, so renaming a section never breaks the link graph. Fails loud on a missing or ambiguous heading. Anchors match case-insensitively; block refs (#^id) are never rewritten.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Note path (.md optional)" },
            from: { type: "string", description: "Existing heading — a bare heading or a \" > \"-joined heading-path" },
            to: { type: "string", description: "New heading text" },
            update_anchors: { type: "boolean", description: "Rewrite inbound [[note#heading]] anchors elsewhere in the vault (default: true)" }
          },
          required: ["path", "from", "to"]
        }
      },
      {
        name: "apply_template",
        description: "Create a new note from a core Templates-plugin template, expanding {{title}} (= the new note's basename), {{date}}, {{time}}, and {{date:FORMAT}}/{{time:FORMAT}} (Moment-format tokens). Unknown {{...}} tokens pass through literally. Refuses to clobber an existing note unless overwrite:true. Returns { path, created } plus unresolved_links and broken_anchors for the resulting note (report-only; see the link-integrity convention).",
        inputSchema: {
          type: "object",
          properties: {
            template: { type: "string", description: "Template name (basename, .md optional) or template-folder-relative path" },
            path: { type: "string", description: "Destination note path for the new note (.md optional)" },
            overwrite: { type: "boolean", description: "Overwrite an existing note at the destination (default: false)" }
          },
          required: ["template", "path"]
        }
      },
      {
        name: "insert_template",
        description: "Expand a core Templates-plugin template into an EXISTING note at position 'append', 'prepend', or 'section'. {{title}} resolves to the existing note's basename. Section addressing and fail-loud ambiguity match append_to_section. Returns { path, position } plus unresolved_links and broken_anchors for the resulting note (report-only; see the link-integrity convention).",
        inputSchema: {
          type: "object",
          properties: {
            template: { type: "string", description: "Template name (basename, .md optional) or template-folder-relative path" },
            path: { type: "string", description: "Existing note to insert into (.md optional)" },
            position: { type: "string", enum: ["append", "prepend", "section"], description: "Where to insert the expanded template" },
            section: { type: "string", description: "Heading — a bare heading or a \" > \"-joined heading-path — when position is 'section'" },
            create_section: { type: "boolean", description: "Create the section if missing (position 'section' only; default: false)" }
          },
          required: ["template", "path", "position"]
        }
      },
      {
        name: "move_file",
        description: "Move or rename an arbitrary file in the vault (attachments, images, or notes referenced by literal path). Treats the path literally: no .md is appended and no wikilinks are rewritten. Refuses to overwrite an existing destination unless overwrite:true.",
        inputSchema: {
          type: "object",
          properties: {
            from: { type: "string", description: "Current relative file path (with extension)" },
            to: { type: "string", description: "New relative file path (with extension)" },
            overwrite: { type: "boolean", description: "Allow replacing an existing file at the destination (default: false)" }
          },
          required: ["from", "to"]
        }
      },
      {
        name: "patch_note",
        description: "Apply a literal find/replace patch to a note's raw text. The match is an exact string (never a regex). Replaces the first occurrence by default, or every occurrence with all:true. Errors if the text to find is not present. Returns { path, replacements } plus unresolved_links and broken_anchors for the resulting note (report-only; see the link-integrity convention).",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Note path (.md optional)" },
            find: { type: "string", description: "Exact literal text to find" },
            replace: { type: "string", description: "Replacement text" },
            all: { type: "boolean", description: "Replace every occurrence instead of only the first (default: false)" }
          },
          required: ["path", "find", "replace"]
        }
      },
      {
        name: "set_task_state",
        description: "Set one checkbox task's state in a note, rewriting only its marker (- [ ] -> - [x]). Address by exact task text (unique-or-fail, like patch_note) with an optional 1-based `line` tiebreak, or by `line` alone. status: open|done|in_progress|cancelled|forwarded (not 'other'). Reports unresolved_links/broken_anchors for the resulting note (link-integrity convention).",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Note path (.md optional)." },
            text: { type: "string", description: "Exact task text (the part after the checkbox)." },
            line: { type: "number", description: "1-based line tiebreak / positional address." },
            status: {
              type: "string",
              enum: ["open", "done", "in_progress", "cancelled", "forwarded"],
              description: "Target state.",
            },
          },
          required: ["path", "status"],
        },
      },
      {
        name: "add_tag",
        description: "Add one or more tags to a note's frontmatter without rewriting the note. Existing tags are not duplicated. Returns the resulting tag list.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Note path (.md optional)" },
            tags: { type: "array", items: { type: "string" }, description: "Tags to add (with or without leading #)" }
          },
          required: ["path", "tags"]
        }
      },
      {
        name: "remove_tag",
        description: "Remove one or more tags from a note's frontmatter. Returns the resulting tag list.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Note path (.md optional)" },
            tags: { type: "array", items: { type: "string" }, description: "Tags to remove (with or without leading #)" }
          },
          required: ["path", "tags"]
        }
      },
      {
        name: "set_frontmatter",
        description: "Set and/or unset frontmatter fields on a note (e.g. status, updated, aliases) while leaving the body untouched. Provide `set` (object of fields to set) and/or `unset` (array of keys to remove).",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Note path (.md optional)" },
            set: { type: "object", description: "Frontmatter fields to set, e.g. { \"status\": \"done\" }" },
            unset: { type: "array", items: { type: "string" }, description: "Frontmatter keys to remove" }
          },
          required: ["path"]
        }
      },
      {
        name: "add_property_values",
        description: "Add one or more values to an array-valued frontmatter property (idempotent, no duplicates). Creates the array if the key is absent; promotes an existing scalar to an array. Rejects nested objects and markdown. Returns the resulting list.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Note path (.md optional)" },
            key: { type: "string", description: "The array-valued property key" },
            values: { type: "array", description: "Values to add" }
          },
          required: ["path", "key", "values"]
        }
      },
      {
        name: "remove_property_values",
        description: "Remove one or more values from an array-valued frontmatter property. An emptied array drops the key. Returns the resulting list.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Note path (.md optional)" },
            key: { type: "string", description: "The array-valued property key" },
            values: { type: "array", description: "Values to remove" }
          },
          required: ["path", "key", "values"]
        }
      },
      {
        name: "rename_property",
        description: "Rename a frontmatter property key in a note, preserving its value and position. Errors if the source key is absent or the destination key already exists.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Note path (.md optional)" },
            from: { type: "string", description: "Current property key" },
            to: { type: "string", description: "New property key" }
          },
          required: ["path", "from", "to"]
        }
      },
      {
        name: "add_section",
        description: "Insert a new heading + content into a note without touching the rest. Appends at the end by default, or immediately after the section named by `after`. Errors if a section with the same heading and level already exists. Returns { path, heading } plus unresolved_links and broken_anchors for the resulting note (report-only; see the link-integrity convention).",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Note path (.md optional)" },
            heading: { type: "string", description: "Heading text (without the leading #)" },
            content: { type: "string", description: "Body text for the new section" },
            level: { type: "number", description: "Heading level 1-6 (default: 2)" },
            after: { type: "string", description: "Insert after the section with this heading, instead of at the end" }
          },
          required: ["path", "heading", "content"]
        }
      },
      {
        name: "append_to_section",
        description: "Append text to the body of an existing section (before the next heading), leaving the rest of the note untouched. Set create:true to create the section if it is missing. Returns { path, heading } plus unresolved_links and broken_anchors for the resulting note (report-only; see the link-integrity convention).",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Note path (.md optional)" },
            heading: { type: "string", description: "Heading text of the section to append to" },
            content: { type: "string", description: "Text to append under the heading" },
            create: { type: "boolean", description: "Create the section if it does not exist (default: false)" }
          },
          required: ["path", "heading", "content"]
        }
      },
      {
        name: "replace_section",
        description: "Replace the body under an existing heading (the heading line is kept), leaving the rest of the note untouched. Errors if the section is missing. Returns { path, heading } plus unresolved_links and broken_anchors for the resulting note (report-only; see the link-integrity convention).",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Note path (.md optional)" },
            heading: { type: "string", description: "Heading text of the section to replace" },
            content: { type: "string", description: "New body text for the section" }
          },
          required: ["path", "heading", "content"]
        }
      },
      {
        name: "bulk_edit",
        description: "Apply one or more frontmatter mutations to many notes in a single call, under a single git snapshot. Select notes by an explicit `paths` array OR a filter (`where`/`tags`, optionally scoped by `folder`) — not both. Pass `dry_run:true` to preview the matched notes without writing. Pass `expected_count` to abort if the match count differs (guards a drifting filter). Operations are applied in order to each note; each note's result is reported independently (a per-note failure does not sink the batch). Only frontmatter ops are supported: add_tag, remove_tag, set_frontmatter, add_property_values, remove_property_values, rename_property.",
        inputSchema: {
          type: "object",
          properties: {
            select: {
              type: "object",
              description: "Note selection. Provide either `paths` OR a filter (`where`/`tags`), not both.",
              properties: {
                paths: { type: "array", items: { type: "string" }, description: "Explicit note paths (.md optional)" },
                where: { type: "object", description: "Frontmatter conditions (same syntax as query_notes)" },
                tags: { type: "array", items: { type: "string" }, description: "Tags to match (with or without leading #)" },
                match: { type: "string", enum: ["all", "any"], description: "How where/tags combine (default: all)" },
                folder: { type: "string", description: "Restrict a filter to notes under this folder" },
                limit: { type: "number", description: "Maximum notes to match" }
              }
            },
            operations: {
              type: "array",
              description: "Frontmatter mutations applied in order to each matched note.",
              items: {
                type: "object",
                properties: {
                  op: { type: "string", enum: ["add_tag", "remove_tag", "set_frontmatter", "add_property_values", "remove_property_values", "rename_property"] },
                  tags: { type: "array", items: { type: "string" } },
                  set: { type: "object" },
                  unset: { type: "array", items: { type: "string" } },
                  key: { type: "string" },
                  values: { type: "array" },
                  from: { type: "string" },
                  to: { type: "string" }
                },
                required: ["op"]
              }
            },
            dry_run: { type: "boolean", description: "Preview matched notes without writing (default: false)" },
            expected_count: { type: "number", description: "Abort before writing if the match count differs" }
          },
          required: ["select", "operations"]
        }
      }
    ];

// The taxonomy and the definitions must never drift: every defined tool is
// classified (or is the always-on get_config), every classified tool is defined.
{
  const defined = new Set(TOOL_DEFINITIONS.map((tool) => tool.name));
  for (const tool of TOOL_DEFINITIONS) {
    if (tool.name !== "get_config" && !GATED_TOOL_NAMES.has(tool.name)) {
      console.error(`Error: tool "${tool.name}" has no tool-policy group`);
      process.exit(1);
    }
  }
  for (const name of GATED_TOOL_NAMES) {
    if (!defined.has(name)) {
      console.error(`Error: tool-policy classifies "${name}" but the server does not define it`);
      process.exit(1);
    }
  }
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOL_DEFINITIONS.filter((tool) => EXPOSED_TOOLS.has(tool.name)),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    // Defense in depth: excluded tools are absent from list_tools, but a stale
    // client may still call one. Unknown names fall through to the default case.
    if (GATED_TOOL_NAMES.has(name) && !EXPOSED_TOOLS.has(name)) {
      throw new Error(
        `Tool "${name}" is excluded by ${TOOLS_ENV} (current policy: ${
          TOOL_POLICY.policy === null
            ? `unset — default "${DEFAULT_POLICY}"`
            : JSON.stringify(TOOL_POLICY.policy)
        }).`
      );
    }

    switch (name) {
      case "search_notes": {
        const params = args as unknown as SearchNotesParams;
        if (!params.pattern) {
          throw new Error("Pattern is required for search_notes");
        }
        const results = await searchNotes(VAULT_PATH, params);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(results)
            }
          ]
        };
      }

      case "search_notes_ranked": {
        const params = args as unknown as RankedSearchParams;
        if (!params.query) {
          throw new Error("query is required for search_notes_ranked");
        }
        const results = await searchNotesRanked(VAULT_PATH, params);
        return {
          content: [{ type: "text", text: JSON.stringify(results) }],
        };
      }

      case "read_notes": {
        const { paths } = args as unknown as { paths: string[] };
        if (!Array.isArray(paths) || paths.length === 0) {
          throw new Error("Paths array is required for read_notes");
        }
        const result = await readNotes(VAULT_PATH, paths);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result)
            }
          ]
        };
      }

      case "list_notes": {
        const results = await listNotes(VAULT_PATH, (args ?? {}) as ListNotesParams);
        return {
          content: [{ type: "text", text: JSON.stringify(results) }]
        };
      }

      case "list_files": {
        const result = await listFiles(VAULT_PATH, (args ?? {}) as ListFilesParams);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }

      case "list_folders": {
        const result = await listFolders(VAULT_PATH, (args ?? {}) as ListFoldersParams);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }
      case "list_templates": {
        const result = await listTemplates(VAULT_PATH, (args ?? {}) as { limit?: number; offset?: number });
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }

      case "get_config": {
        const { section } = (args ?? {}) as { section?: string };
        const config = await resolveServerConfig(VAULT_PATH);
        const result = selectConfigSection(config, section);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }

      case "get_links": {
        const { path, include_context } = args as unknown as { path: string; include_context?: boolean };
        if (!path || typeof path !== "string") {
          throw new Error("A note path is required for get_links");
        }
        const results = await getLinks(VAULT_PATH, path, { include_context });
        return {
          content: [{ type: "text", text: JSON.stringify(results) }]
        };
      }

      case "get_outline": {
        const { path } = args as unknown as { path: string };
        if (!path || typeof path !== "string") {
          throw new Error("A note path is required for get_outline");
        }
        const results = await getOutline(VAULT_PATH, path);
        return {
          content: [{ type: "text", text: JSON.stringify(results) }]
        };
      }

      case "read_section": {
        const params = args as unknown as ReadSectionParams;
        if (!params.path || typeof params.path !== "string") {
          throw new Error("A note path is required for read_section");
        }
        if (!params.section || typeof params.section !== "string") {
          throw new Error("A section is required for read_section");
        }
        const results = await readSection(VAULT_PATH, params);
        return {
          content: [{ type: "text", text: JSON.stringify(results) }]
        };
      }

      case "list_tasks": {
        const results = await listTasks(VAULT_PATH, (args ?? {}) as ListTasksParams);
        return { content: [{ type: "text", text: JSON.stringify(results) }] };
      }

      case "list_tags": {
        const results = await listTags(VAULT_PATH, (args?.offset as number | undefined));
        return {
          content: [{ type: "text", text: JSON.stringify(results) }]
        };
      }

      case "find_by_tag": {
        const results = await findByTag(VAULT_PATH, (args ?? {}) as unknown as FindByTagParams);
        return {
          content: [{ type: "text", text: JSON.stringify(results) }]
        };
      }

      case "list_recent_notes": {
        const results = await listRecentNotes(VAULT_PATH, (args ?? {}) as RecentNotesParams);
        return {
          content: [{ type: "text", text: JSON.stringify(results) }]
        };
      }

      case "get_related_notes": {
        const results = await getRelatedNotes(VAULT_PATH, (args ?? {}) as unknown as RelatedNotesParams);
        return {
          content: [{ type: "text", text: JSON.stringify(results) }]
        };
      }

      case "get_frontmatter": {
        const { path } = args as unknown as { path: string };
        if (!path || typeof path !== "string") {
          throw new Error("A note path is required for get_frontmatter");
        }
        const result = await getFrontmatter(VAULT_PATH, path);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }

      case "resolve_note": {
        const { query } = args as unknown as { query: string };
        if (!query || typeof query !== "string") {
          throw new Error("A query is required for resolve_note");
        }
        const result = await resolveNote(VAULT_PATH, query);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }

      case "resolve_daily_note": {
        const result = await resolveDailyNote(VAULT_PATH, (args ?? {}) as { date?: string });
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }

      case "list_properties": {
        const result = await listProperties(VAULT_PATH, (args ?? {}) as ListPropertiesParams);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }

      case "list_property_values": {
        const result = await getPropertyValues(VAULT_PATH, (args ?? {}) as unknown as PropertyValuesParamsRead);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }

      case "query_notes": {
        const result = await queryNotes(VAULT_PATH, (args ?? {}) as unknown as QueryNotesParams);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }

      case "get_property": {
        const result = await getProperty(VAULT_PATH, (args ?? {}) as unknown as GetPropertyParams);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }

      case "get_vault_stats": {
        const result = await getVaultStats(VAULT_PATH);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }

      case "list_vault_issues": {
        const result = await listVaultIssues(VAULT_PATH, (args ?? {}) as unknown as ListVaultIssuesParams);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }

      case "write_note": {
        const result = await writeNote(VAULT_PATH, (args ?? {}) as unknown as WriteNoteParams);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }

      case "append_note": {
        const result = await appendNote(VAULT_PATH, (args ?? {}) as unknown as AppendNoteParams);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }

      case "prepend_note": {
        const result = await prependNote(VAULT_PATH, (args ?? {}) as unknown as PrependNoteParams);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }

      case "delete_note": {
        const { path, permanent, include_context } = args as unknown as { path: string; permanent?: boolean; include_context?: boolean };
        if (!path || typeof path !== "string") {
          throw new Error("A note path is required for delete_note");
        }
        const result = await deleteNote(VAULT_PATH, path, { permanent, include_context });
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }

      case "move_note": {
        const result = await moveNote(VAULT_PATH, (args ?? {}) as unknown as MoveNoteParams);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }

      case "rename_section": {
        const result = await renameSectionInVault(VAULT_PATH, (args ?? {}) as unknown as RenameSectionParams);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }
      case "apply_template": {
        const result = await applyTemplate(VAULT_PATH, (args ?? {}) as { template: string; path: string; overwrite?: boolean });
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }
      case "insert_template": {
        const result = await insertTemplate(VAULT_PATH, (args ?? {}) as { template: string; path: string; position: "append" | "prepend" | "section"; section?: string; create_section?: boolean });
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }

      case "move_file": {
        const result = await moveFile(VAULT_PATH, (args ?? {}) as unknown as MoveFileParams);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }

      case "patch_note": {
        const result = await patchNote(VAULT_PATH, (args ?? {}) as unknown as PatchNoteParams);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }

      case "set_task_state": {
        const result = await setTaskState(VAULT_PATH, (args ?? {}) as unknown as SetTaskStateParams);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }

      case "add_tag": {
        const result = await addTag(VAULT_PATH, (args ?? {}) as unknown as TagParams);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }

      case "remove_tag": {
        const result = await removeTag(VAULT_PATH, (args ?? {}) as unknown as TagParams);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }

      case "set_frontmatter": {
        const result = await setNoteFrontmatter(VAULT_PATH, (args ?? {}) as unknown as SetFrontmatterParams);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }

      case "add_property_values": {
        const result = await addNotePropertyValues(VAULT_PATH, (args ?? {}) as unknown as PropertyValuesParams);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }

      case "remove_property_values": {
        const result = await removeNotePropertyValues(VAULT_PATH, (args ?? {}) as unknown as PropertyValuesParams);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }

      case "rename_property": {
        const result = await renameNoteProperty(VAULT_PATH, (args ?? {}) as unknown as RenamePropertyParams);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }

      case "add_section": {
        const result = await addNoteSection(VAULT_PATH, (args ?? {}) as unknown as AddSectionParams);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }

      case "append_to_section": {
        const result = await appendNoteSection(VAULT_PATH, (args ?? {}) as unknown as SectionEditParams);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }

      case "replace_section": {
        const result = await replaceNoteSection(VAULT_PATH, (args ?? {}) as unknown as SectionEditParams);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }

      case "bulk_edit": {
        const result = await bulkEdit(VAULT_PATH, (args ?? {}) as unknown as BulkEditParams);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: "text",
          text: `Error: ${message}`
        }
      ],
      isError: true
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Notes MCP server running on stdio");
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(console.error);
}
