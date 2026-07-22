#!/usr/bin/env node

import process from "node:process";
import { Command } from "commander";
import { searchNotes } from "./tools/search.js";
import { readNotes } from "./tools/read.js";

const VAULT_PATH = process.env.OBSIDIAN_VAULT_PATH;
if (!VAULT_PATH) {
  console.error("Error: OBSIDIAN_VAULT_PATH environment variable is required");
  process.exit(1);
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
      result = await searchNotes(VAULT_PATH!, args);
    } else if (toolName === "read_notes") {
      result = await readNotes(VAULT_PATH!, args.paths);
    } else {
      throw new Error(`Unknown tool: ${toolName}`);
    }

    console.log(JSON.stringify(result, null, 2));

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Error:", message);
    process.exit(1);
  }
}

const program = new Command();

program
  .name("query")
  .version("1.0.0")
  .description("Query the Notes MCP server tools directly")
  .option("-v, --verbose", "Show the tool request being sent");

program
  .command("search")
  .description("Search through notes using ripgrep")
  .argument("<pattern>", "The search pattern")
  .option("-s, --case-sensitive", "Case sensitive search (default: false)")
  .option("-w, --whole-word", "Match whole words only")
  .option("-m, --multiline", "Enable multiline matching")
  .option("-c, --context <lines>", "Number of context lines to show", "5")
  .action(async (pattern: string, options: any, command: Command) => {
    const verbose = command.parent?.opts().verbose ?? false;
    const context = parseInt(options.context, 10);
    const args = {
      pattern,
      ...(options.caseSensitive && { case_sensitive: true }),
      ...(options.wholeWord && { whole_word: true }),
      ...(options.multiline && { multiline: true }),
      ...(context !== 5 && { context_lines: context })
    };
    await queryTool("search_notes", args, verbose);
  });

program
  .command("read")
  .description("Read one or more notes")
  .argument("<paths...>", "Relative note paths")
  .action(async (paths: string[], _options: any, command: Command) => {
    const verbose = command.parent?.opts().verbose ?? false;
    if (paths.length === 0) {
      console.error("Error: read command requires at least one note path");
      process.exit(1);
    }

    const args = { paths };
    await queryTool("read_notes", args, verbose);
  });

program.parseAsync(process.argv);
