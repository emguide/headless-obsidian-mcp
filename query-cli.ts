#!/usr/bin/env -S deno run --allow-read --allow-run --allow-env

import { Command } from "@cliffy/command";
import { searchNotes } from "./src/tools/search.ts";
import { readNotes } from "./src/tools/read.ts";

const VAULT_PATH = Deno.env.get("OBSIDIAN_VAULT_PATH");
if (!VAULT_PATH) {
  console.error("Error: OBSIDIAN_VAULT_PATH environment variable is required");
  Deno.exit(1);
}

async function queryTool(toolName: string, args: any, verbose: boolean) {
  try {
    if (verbose) {
      console.error("Tool Request:");
      console.error(JSON.stringify({
        tool: toolName,
        arguments: args
      }, null, 2));
      console.error("");
    }

    let result;
    if (toolName === "search_notes") {
      result = await searchNotes(VAULT_PATH, args);
    } else if (toolName === "read_notes") {
      result = await readNotes(VAULT_PATH, args.paths);
    } else {
      throw new Error(`Unknown tool: ${toolName}`);
    }
    
    console.log(JSON.stringify(result, null, 2));
    
  } catch (error) {
    console.error("Error:", error.message);
    Deno.exit(1);
  }
}

const searchCommand = new Command()
  .description("Search through notes using ripgrep")
  .arguments("<pattern:string>")
  .option("-s, --case-sensitive", "Case sensitive search (default: false)")
  .option("-w, --whole-word", "Match whole words only")
  .option("-m, --multiline", "Enable multiline matching")
  .option("-c, --context <lines:number>", "Number of context lines to show", { default: 5 })
  .action(async (options, pattern) => {
    const args = {
      pattern,
      ...(options.caseSensitive && { case_sensitive: true }),
      ...(options.wholeWord && { whole_word: true }),
      ...(options.multiline && { multiline: true }),
      ...(options.context !== 5 && { context_lines: options.context })
    };
    await queryTool("search_notes", args, options.verbose);
  });

const readCommand = new Command()
  .description("Read one or more notes")
  .arguments("<...paths:string>")
  .action(async (options, ...paths) => {
    if (paths.length === 0) {
      console.error("Error: read command requires at least one note path");
      Deno.exit(1);
    }
    
    const args = { paths };
    await queryTool("read_notes", args, options.verbose);
  });

const mainCommand = new Command()
  .name("query")
  .version("1.0.0")
  .description("Query the Notes MCP server tools directly")
  .globalOption("-v, --verbose", "Show the tool request being sent")
  .command("search", searchCommand)
  .command("read", readCommand);

if (import.meta.main) {
  await mainCommand.parse(Deno.args);
}