#!/usr/bin/env node

import process from "node:process";
import { Command } from "commander";
import { searchNotes } from "./tools/search.js";
import { readNotes } from "./tools/read.js";
import { listNotes } from "./tools/list.js";
import { getLinks } from "./tools/links.js";
import { listTags, findByTag } from "./tools/tags.js";
import { listRecentNotes } from "./tools/recent.js";

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
    } else if (toolName === "list_notes") {
      result = await listNotes(VAULT_PATH!, args);
    } else if (toolName === "get_links") {
      result = await getLinks(VAULT_PATH!, args.path);
    } else if (toolName === "list_tags") {
      result = await listTags(VAULT_PATH!);
    } else if (toolName === "find_by_tag") {
      result = await findByTag(VAULT_PATH!, args);
    } else if (toolName === "list_recent_notes") {
      result = await listRecentNotes(VAULT_PATH!, args);
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

program
  .command("list")
  .description("List notes as lightweight headers")
  .option("-f, --folder <folder>", "Restrict to notes under this folder")
  .option("-l, --limit <n>", "Maximum number of notes to return")
  .action(async (options: any, command: Command) => {
    const verbose = command.parent?.opts().verbose ?? false;
    const args = {
      ...(options.folder && { folder: options.folder }),
      ...(options.limit && { limit: parseInt(options.limit, 10) })
    };
    await queryTool("list_notes", args, verbose);
  });

program
  .command("links")
  .description("Show outbound links, unresolved links, and backlinks for a note")
  .argument("<path>", "Relative note path")
  .action(async (path: string, _options: any, command: Command) => {
    const verbose = command.parent?.opts().verbose ?? false;
    await queryTool("get_links", { path }, verbose);
  });

program
  .command("tags")
  .description("List every tag in the vault with note counts")
  .action(async (_options: any, command: Command) => {
    const verbose = command.parent?.opts().verbose ?? false;
    await queryTool("list_tags", {}, verbose);
  });

program
  .command("find-by-tag")
  .description("Find notes matching one or more tags")
  .argument("<tags...>", "Tags to match (with or without leading #)")
  .option("-a, --all", "Require all tags (default: any)")
  .option("-l, --limit <n>", "Maximum number of notes to return")
  .action(async (tags: string[], options: any, command: Command) => {
    const verbose = command.parent?.opts().verbose ?? false;
    const args = {
      tags,
      ...(options.all && { match: "all" }),
      ...(options.limit && { limit: parseInt(options.limit, 10) })
    };
    await queryTool("find_by_tag", args, verbose);
  });

program
  .command("recent")
  .description("List notes ordered by recency (newest first)")
  .option("-l, --limit <n>", "Maximum number of notes to return (default: 20)")
  .option("-s, --since <date>", "Only include notes on or after this ISO date")
  .option("-d, --date-field <field>", "Frontmatter date field to sort by")
  .action(async (options: any, command: Command) => {
    const verbose = command.parent?.opts().verbose ?? false;
    const args = {
      ...(options.limit && { limit: parseInt(options.limit, 10) }),
      ...(options.since && { since: options.since }),
      ...(options.dateField && { date_field: options.dateField })
    };
    await queryTool("list_recent_notes", args, verbose);
  });

program.parseAsync(process.argv);
