#!/usr/bin/env node

import process from "node:process";
import { readFileSync } from "node:fs";
import { Command } from "commander";
import { searchNotes } from "./tools/search.js";
import { readNotes } from "./tools/read.js";
import { listNotes } from "./tools/list.js";
import { getLinks } from "./tools/links.js";
import { listTags, findByTag } from "./tools/tags.js";
import { listRecentNotes } from "./tools/recent.js";
import { getRelatedNotes } from "./tools/related.js";
import {
  writeNote,
  appendNote,
  deleteNote,
  addTag,
  removeTag,
  setNoteFrontmatter,
  addNoteSection,
  appendNoteSection,
  replaceNoteSection,
} from "./tools/write.js";

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
    } else if (toolName === "get_related_notes") {
      result = await getRelatedNotes(VAULT_PATH!, args);
    } else if (toolName === "write_note") {
      result = await writeNote(VAULT_PATH!, args);
    } else if (toolName === "append_note") {
      result = await appendNote(VAULT_PATH!, args);
    } else if (toolName === "delete_note") {
      result = await deleteNote(VAULT_PATH!, args.path);
    } else if (toolName === "add_tag") {
      result = await addTag(VAULT_PATH!, args);
    } else if (toolName === "remove_tag") {
      result = await removeTag(VAULT_PATH!, args);
    } else if (toolName === "set_frontmatter") {
      result = await setNoteFrontmatter(VAULT_PATH!, args);
    } else if (toolName === "add_section") {
      result = await addNoteSection(VAULT_PATH!, args);
    } else if (toolName === "append_to_section") {
      result = await appendNoteSection(VAULT_PATH!, args);
    } else if (toolName === "replace_section") {
      result = await replaceNoteSection(VAULT_PATH!, args);
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

program
  .command("related")
  .description("Find the notes most related to a given note, ranked with reasons")
  .argument("<path>", "Relative note path")
  .option("-l, --limit <n>", "Maximum number of related notes to return (default: 10)")
  .action(async (path: string, options: any, command: Command) => {
    const verbose = command.parent?.opts().verbose ?? false;
    const args = {
      path,
      ...(options.limit && { limit: parseInt(options.limit, 10) }),
    };
    await queryTool("get_related_notes", args, verbose);
  });

function readContent(inline: string | undefined, file: string | undefined): string {
  if (file) return readFileSync(file, "utf-8");
  if (inline != null) return inline;
  return readFileSync(0, "utf-8"); // stdin
}

program
  .command("write")
  .description("Create a note, or overwrite one with --overwrite")
  .argument("<path>", "Relative note path")
  .argument("[content]", "Note body (omit to read from --file or stdin)")
  .option("-f, --file <file>", "Read the note body from a file")
  .option("-o, --overwrite", "Allow replacing an existing note")
  .action(async (path: string, content: string | undefined, options: any, command: Command) => {
    const verbose = command.parent?.opts().verbose ?? false;
    const args = {
      path,
      content: readContent(content, options.file),
      ...(options.overwrite && { overwrite: true }),
    };
    await queryTool("write_note", args, verbose);
  });

program
  .command("append")
  .description("Append text to the end of a note")
  .argument("<path>", "Relative note path")
  .argument("[content]", "Text to append (omit to read from --file or stdin)")
  .option("-f, --file <file>", "Read the text from a file")
  .option("-c, --create", "Create the note if it does not exist")
  .action(async (path: string, content: string | undefined, options: any, command: Command) => {
    const verbose = command.parent?.opts().verbose ?? false;
    const args = {
      path,
      content: readContent(content, options.file),
      ...(options.create && { create: true }),
    };
    await queryTool("append_note", args, verbose);
  });

program
  .command("delete")
  .description("Delete a note from the vault")
  .argument("<path>", "Relative note path")
  .action(async (path: string, _options: any, command: Command) => {
    const verbose = command.parent?.opts().verbose ?? false;
    await queryTool("delete_note", { path }, verbose);
  });

program
  .command("add-tag")
  .description("Add one or more tags to a note's frontmatter")
  .argument("<path>", "Relative note path")
  .argument("<tags...>", "Tags to add (with or without leading #)")
  .action(async (path: string, tags: string[], _options: any, command: Command) => {
    const verbose = command.parent?.opts().verbose ?? false;
    await queryTool("add_tag", { path, tags }, verbose);
  });

program
  .command("remove-tag")
  .description("Remove one or more tags from a note's frontmatter")
  .argument("<path>", "Relative note path")
  .argument("<tags...>", "Tags to remove (with or without leading #)")
  .action(async (path: string, tags: string[], _options: any, command: Command) => {
    const verbose = command.parent?.opts().verbose ?? false;
    await queryTool("remove_tag", { path, tags }, verbose);
  });

program
  .command("set-frontmatter")
  .description("Set (key=value) and/or unset frontmatter fields")
  .argument("<path>", "Relative note path")
  .option("-s, --set <pairs...>", "Fields to set as key=value")
  .option("-u, --unset <keys...>", "Frontmatter keys to remove")
  .action(async (path: string, options: any, command: Command) => {
    const verbose = command.parent?.opts().verbose ?? false;
    const set: Record<string, string> = {};
    for (const pair of options.set ?? []) {
      const eq = String(pair).indexOf("=");
      if (eq === -1) {
        console.error(`Error: --set expects key=value, got "${pair}"`);
        process.exit(1);
      }
      set[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    const args = {
      path,
      ...(options.set && { set }),
      ...(options.unset && { unset: options.unset }),
    };
    await queryTool("set_frontmatter", args, verbose);
  });

program
  .command("add-section")
  .description("Insert a new heading + content into a note")
  .argument("<path>", "Relative note path")
  .argument("<heading>", "Heading text (without leading #)")
  .argument("[content]", "Section body (omit to read from --file or stdin)")
  .option("-f, --file <file>", "Read the section body from a file")
  .option("-l, --level <n>", "Heading level 1-6 (default: 2)")
  .option("-a, --after <heading>", "Insert after the section with this heading")
  .action(async (path: string, heading: string, content: string | undefined, options: any, command: Command) => {
    const verbose = command.parent?.opts().verbose ?? false;
    const args = {
      path,
      heading,
      content: readContent(content, options.file),
      ...(options.level && { level: parseInt(options.level, 10) }),
      ...(options.after && { after: options.after }),
    };
    await queryTool("add_section", args, verbose);
  });

program
  .command("append-to-section")
  .description("Append text under an existing heading")
  .argument("<path>", "Relative note path")
  .argument("<heading>", "Heading text of the section")
  .argument("[content]", "Text to append (omit to read from --file or stdin)")
  .option("-f, --file <file>", "Read the text from a file")
  .option("-c, --create", "Create the section if it does not exist")
  .action(async (path: string, heading: string, content: string | undefined, options: any, command: Command) => {
    const verbose = command.parent?.opts().verbose ?? false;
    const args = {
      path,
      heading,
      content: readContent(content, options.file),
      ...(options.create && { create: true }),
    };
    await queryTool("append_to_section", args, verbose);
  });

program
  .command("replace-section")
  .description("Replace the body under an existing heading")
  .argument("<path>", "Relative note path")
  .argument("<heading>", "Heading text of the section")
  .argument("[content]", "New section body (omit to read from --file or stdin)")
  .option("-f, --file <file>", "Read the new body from a file")
  .action(async (path: string, heading: string, content: string | undefined, options: any, command: Command) => {
    const verbose = command.parent?.opts().verbose ?? false;
    const args = {
      path,
      heading,
      content: readContent(content, options.file),
    };
    await queryTool("replace_section", args, verbose);
  });

program.parseAsync(process.argv);
