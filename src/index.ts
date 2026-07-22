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
import { readNotes } from "./tools/read.js";
import { listNotes } from "./tools/list.js";
import { getLinks } from "./tools/links.js";
import { listTags, findByTag } from "./tools/tags.js";
import { listRecentNotes } from "./tools/recent.js";
import {
  SearchNotesParams,
  ListNotesParams,
  FindByTagParams,
  RecentNotesParams,
} from "./types.js";

const VAULT_PATH = process.env.OBSIDIAN_VAULT_PATH;
if (!VAULT_PATH) {
  console.error("Error: OBSIDIAN_VAULT_PATH environment variable is required");
  process.exit(1);
}

const server = new Server(
  {
    name: "notes-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
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
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
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
