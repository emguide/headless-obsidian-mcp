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
import { listTags, findByTag } from "./tools/tags.js";
import { listRecentNotes } from "./tools/recent.js";
import { getRelatedNotes } from "./tools/related.js";
import { getFrontmatter } from "./tools/frontmatter.js";
import { getVaultStats } from "./tools/stats.js";
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
  isWriteTool,
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
} from "./tools/write.js";
import {
  SearchNotesParams,
  ListNotesParams,
  FindByTagParams,
  RecentNotesParams,
  RelatedNotesParams,
  RankedSearchParams,
} from "./types.js";
import { ALLOW_WRITES_ENV, writesEnabled } from "./tools/env-flags.js";

const VAULT_PATH = process.env.OBSIDIAN_VAULT_PATH;
if (!VAULT_PATH) {
  console.error("Error: OBSIDIAN_VAULT_PATH environment variable is required");
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
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = [
      {
        name: "search_notes",
        description: "Search through Obsidian notes using ripgrep. Returns matching notes with context lines.",
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
            }
          },
          required: ["pattern"]
        }
      },
      {
        name: "search_notes_ranked",
        description:
          "Full-text search ranked by BM25 relevance. Returns the most relevant notes first (title/heading/tag matches boosted), each with a relevance score and a matched snippet. Complements search_notes (which is literal/regex, unranked).",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Free-text query (max 1000 chars). Multi-word queries are ranked by relevance.",
            },
            limit: {
              type: "number",
              description: "Maximum number of results (default: 10, max: 100).",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "read_notes",
        description: "Read one or more Obsidian notes by their relative paths. Returns parsed note data including metadata and tags.",
        inputSchema: {
          type: "object",
          properties: {
            paths: {
              type: "array",
              items: { type: "string" },
              description: "Array of relative note paths (with or without .md extension)"
            }
          },
          required: ["paths"]
        }
      },
      {
        name: "list_notes",
        description: "List notes in the vault as lightweight headers (path, title, tags, first heading, size, modified time) without full contents. Use it to discover what exists and orient before searching or reading.",
        inputSchema: {
          type: "object",
          properties: {
            folder: {
              type: "string",
              description: "Restrict to notes under this folder, relative to the vault root"
            },
            limit: {
              type: "number",
              description: "Maximum number of notes to return"
            }
          }
        }
      },
      {
        name: "get_links",
        description: "Resolve the Obsidian link graph for a note: outbound [[wikilinks]] resolved to real notes, links that resolve to nothing, and backlinks (other notes that link to this one). Use it to traverse related knowledge.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Relative note path (with or without .md extension)"
            }
          },
          required: ["path"]
        }
      },
      {
        name: "list_tags",
        description: "List every tag used across the vault with the number of notes using it, sorted by frequency. Unifies inline #tags and frontmatter tags:. Use it to see the vault's topic index.",
        inputSchema: {
          type: "object",
          properties: {}
        }
      },
      {
        name: "find_by_tag",
        description: "Find notes matching one or more tags, returning lightweight headers. High-precision retrieval based on human curation.",
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
              description: 'Require "any" (default) or "all" of the tags'
            },
            limit: {
              type: "number",
              description: "Maximum number of notes to return"
            }
          },
          required: ["tags"]
        }
      },
      {
        name: "list_recent_notes",
        description: "List notes ordered by recency (newest first), as lightweight headers. Sort by filesystem mtime or a frontmatter date field, with optional since cutoff and frontmatter equality filters. Use it to find current material.",
        inputSchema: {
          type: "object",
          properties: {
            limit: {
              type: "number",
              description: "Maximum number of notes to return (default: 20)"
            },
            since: {
              type: "string",
              description: "Only include notes on or after this ISO date"
            },
            date_field: {
              type: "string",
              description: "Frontmatter field to sort by instead of filesystem mtime (e.g. 'updated')"
            },
            where: {
              type: "object",
              description: "Frontmatter equality filters, e.g. { \"status\": \"active\" }"
            }
          }
        }
      },
      {
        name: "get_related_notes",
        description: "Find the notes most related to a given note, ranked, without embeddings: a transparent blend of shared tags, direct links, shared out-links (co-reference), and shared backlinks (co-citation). Each result carries the reasons it surfaced. Use it for associative recall - 'I'm looking at X, what else is relevant?'",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Relative note path (with or without .md extension)"
            },
            limit: {
              type: "number",
              description: "Maximum number of related notes to return (default: 10)"
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
              description: "Relative note path (with or without .md extension)"
            }
          },
          required: ["path"]
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
        name: "write_note",
        description: "Create a note, or overwrite an existing one. Refuses to overwrite unless overwrite:true is passed. Use the structure-aware tools (add_section, set_frontmatter, add_tag) for surgical edits instead of rewriting a whole note.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative note path (with or without .md)" },
            content: { type: "string", description: "Full note body (may include frontmatter)" },
            overwrite: { type: "boolean", description: "Allow replacing an existing note (default: false)" }
          },
          required: ["path", "content"]
        }
      },
      {
        name: "append_note",
        description: "Append text to the end of an existing note. Set create:true to create the note if it is missing.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative note path (with or without .md)" },
            content: { type: "string", description: "Text to append" },
            create: { type: "boolean", description: "Create the note if it does not exist (default: false)" }
          },
          required: ["path", "content"]
        }
      },
      {
        name: "prepend_note",
        description: "Prepend text to the start of a note's body. Any frontmatter block is preserved and the text is inserted after it. Set create:true to create the note if it is missing.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative note path (with or without .md)" },
            content: { type: "string", description: "Text to prepend" },
            create: { type: "boolean", description: "Create the note if it does not exist (default: false)" }
          },
          required: ["path", "content"]
        }
      },
      {
        name: "delete_note",
        description: "Delete a note. Trash-safe by default: the note is moved to the vault's .trash folder so the deletion is recoverable. Pass permanent:true to unlink it outright. Errors if the note does not exist.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative note path (with or without .md)" },
            permanent: { type: "boolean", description: "Permanently delete instead of moving to .trash (default: false)" }
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
            from: { type: "string", description: "Current relative note path (with or without .md)" },
            to: { type: "string", description: "New relative note path (with or without .md)" },
            overwrite: { type: "boolean", description: "Allow replacing an existing note at the destination (default: false)" },
            update_links: { type: "boolean", description: "Rewrite wikilinks in other notes that point to this note (default: true)" }
          },
          required: ["from", "to"]
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
        description: "Apply a literal find/replace patch to a note's raw text. The match is an exact string (never a regex). Replaces the first occurrence by default, or every occurrence with all:true. Errors if the text to find is not present.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative note path (with or without .md)" },
            find: { type: "string", description: "Exact literal text to find" },
            replace: { type: "string", description: "Replacement text" },
            all: { type: "boolean", description: "Replace every occurrence instead of only the first (default: false)" }
          },
          required: ["path", "find", "replace"]
        }
      },
      {
        name: "add_tag",
        description: "Add one or more tags to a note's frontmatter without rewriting the note. Existing tags are not duplicated. Returns the resulting tag list.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative note path (with or without .md)" },
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
            path: { type: "string", description: "Relative note path (with or without .md)" },
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
            path: { type: "string", description: "Relative note path (with or without .md)" },
            set: { type: "object", description: "Frontmatter fields to set, e.g. { \"status\": \"done\" }" },
            unset: { type: "array", items: { type: "string" }, description: "Frontmatter keys to remove" }
          },
          required: ["path"]
        }
      },
      {
        name: "add_section",
        description: "Insert a new heading + content into a note without touching the rest. Appends at the end by default, or immediately after the section named by `after`. Errors if a section with the same heading and level already exists.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative note path (with or without .md)" },
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
        description: "Append text to the body of an existing section (before the next heading), leaving the rest of the note untouched. Set create:true to create the section if it is missing.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative note path (with or without .md)" },
            heading: { type: "string", description: "Heading text of the section to append to" },
            content: { type: "string", description: "Text to append under the heading" },
            create: { type: "boolean", description: "Create the section if it does not exist (default: false)" }
          },
          required: ["path", "heading", "content"]
        }
      },
      {
        name: "replace_section",
        description: "Replace the body under an existing heading (the heading line is kept), leaving the rest of the note untouched. Errors if the section is missing.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative note path (with or without .md)" },
            heading: { type: "string", description: "Heading text of the section to replace" },
            content: { type: "string", description: "New body text for the section" }
          },
          required: ["path", "heading", "content"]
        }
      }
    ];

  // Expose the write tools only when writing is enabled; stay read-only otherwise.
  return {
    tools: writesEnabled() ? tools : tools.filter((tool) => !isWriteTool(tool.name)),
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    // Gate every mutating tool behind the write master switch (defense in depth:
    // the tool is also hidden from list_tools when writes are disabled).
    if (isWriteTool(name) && !writesEnabled()) {
      throw new Error(
        `Writing is disabled. Set ${ALLOW_WRITES_ENV}=1 (or true/yes/on) to enable the write tools.`
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
              text: JSON.stringify(results, null, 2)
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
          content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
        };
      }

      case "read_notes": {
        const { paths } = args as unknown as { paths: string[] };
        if (!Array.isArray(paths) || paths.length === 0) {
          throw new Error("Paths array is required for read_notes");
        }
        const notes = await readNotes(VAULT_PATH, paths);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(notes, null, 2)
            }
          ]
        };
      }

      case "list_notes": {
        const results = await listNotes(VAULT_PATH, (args ?? {}) as ListNotesParams);
        return {
          content: [{ type: "text", text: JSON.stringify(results, null, 2) }]
        };
      }

      case "get_links": {
        const { path } = args as unknown as { path: string };
        if (!path || typeof path !== "string") {
          throw new Error("A note path is required for get_links");
        }
        const results = await getLinks(VAULT_PATH, path);
        return {
          content: [{ type: "text", text: JSON.stringify(results, null, 2) }]
        };
      }

      case "list_tags": {
        const results = await listTags(VAULT_PATH);
        return {
          content: [{ type: "text", text: JSON.stringify(results, null, 2) }]
        };
      }

      case "find_by_tag": {
        const results = await findByTag(VAULT_PATH, (args ?? {}) as unknown as FindByTagParams);
        return {
          content: [{ type: "text", text: JSON.stringify(results, null, 2) }]
        };
      }

      case "list_recent_notes": {
        const results = await listRecentNotes(VAULT_PATH, (args ?? {}) as RecentNotesParams);
        return {
          content: [{ type: "text", text: JSON.stringify(results, null, 2) }]
        };
      }

      case "get_related_notes": {
        const results = await getRelatedNotes(VAULT_PATH, (args ?? {}) as unknown as RelatedNotesParams);
        return {
          content: [{ type: "text", text: JSON.stringify(results, null, 2) }]
        };
      }

      case "get_frontmatter": {
        const { path } = args as unknown as { path: string };
        if (!path || typeof path !== "string") {
          throw new Error("A note path is required for get_frontmatter");
        }
        const result = await getFrontmatter(VAULT_PATH, path);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "get_vault_stats": {
        const result = await getVaultStats(VAULT_PATH);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "write_note": {
        const result = await writeNote(VAULT_PATH, (args ?? {}) as unknown as WriteNoteParams);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "append_note": {
        const result = await appendNote(VAULT_PATH, (args ?? {}) as unknown as AppendNoteParams);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "prepend_note": {
        const result = await prependNote(VAULT_PATH, (args ?? {}) as unknown as PrependNoteParams);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "delete_note": {
        const { path, permanent } = args as unknown as { path: string; permanent?: boolean };
        if (!path || typeof path !== "string") {
          throw new Error("A note path is required for delete_note");
        }
        const result = await deleteNote(VAULT_PATH, path, { permanent });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "move_note": {
        const result = await moveNote(VAULT_PATH, (args ?? {}) as unknown as MoveNoteParams);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "move_file": {
        const result = await moveFile(VAULT_PATH, (args ?? {}) as unknown as MoveFileParams);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "patch_note": {
        const result = await patchNote(VAULT_PATH, (args ?? {}) as unknown as PatchNoteParams);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "add_tag": {
        const result = await addTag(VAULT_PATH, (args ?? {}) as unknown as TagParams);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "remove_tag": {
        const result = await removeTag(VAULT_PATH, (args ?? {}) as unknown as TagParams);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "set_frontmatter": {
        const result = await setNoteFrontmatter(VAULT_PATH, (args ?? {}) as unknown as SetFrontmatterParams);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "add_section": {
        const result = await addNoteSection(VAULT_PATH, (args ?? {}) as unknown as AddSectionParams);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "append_to_section": {
        const result = await appendNoteSection(VAULT_PATH, (args ?? {}) as unknown as SectionEditParams);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "replace_section": {
        const result = await replaceNoteSection(VAULT_PATH, (args ?? {}) as unknown as SectionEditParams);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
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
