#!/usr/bin/env -S deno run --allow-read --allow-run --allow-env

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { searchNotes } from "./tools/search.ts";
import { readNotes } from "./tools/read.ts";
import { SearchNotesParams } from "./types.ts";

const VAULT_PATH = Deno.env.get("OBSIDIAN_VAULT_PATH");
if (!VAULT_PATH) {
  console.error("Error: OBSIDIAN_VAULT_PATH environment variable is required");
  Deno.exit(1);
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
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "search_notes": {
        const params = args as SearchNotesParams;
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
        const { paths } = args as { paths: string[] };
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

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error.message}`
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

if (import.meta.main) {
  main().catch(console.error);
}