#!/usr/bin/env node

import process from "node:process";
import { readFileSync } from "node:fs";
import { Command } from "commander";
import { searchNotes } from "./tools/search.js";
import { searchNotesRanked } from "./tools/search-ranked.js";
import { readNotes } from "./tools/read.js";
import { listNotes } from "./tools/list.js";
import { getLinks } from "./tools/links.js";
import { getOutline } from "./tools/outline.js";
import { readSection } from "./tools/section.js";
import { listTags, findByTag } from "./tools/tags.js";
import { listRecentNotes } from "./tools/recent.js";
import { getRelatedNotes } from "./tools/related.js";
import { getFrontmatter } from "./tools/frontmatter.js";
import { resolveNote } from "./tools/resolve.js";
import { getVaultStats } from "./tools/stats.js";
import { listVaultIssues } from "./tools/vault-issues.js";
import { listFiles } from "./tools/files.js";
import { listFolders } from "./tools/folders.js";
import { listTemplates, applyTemplate, insertTemplate } from "./tools/templates.js";
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
} from "./tools/write.js";
import {
  listProperties,
  getPropertyValues,
  queryNotes,
  getProperty,
} from "./tools/properties.js";
import { bulkEdit } from "./tools/bulk.js";

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
    } else if (toolName === "search_notes_ranked") {
      result = await searchNotesRanked(VAULT_PATH!, args);
    } else if (toolName === "read_notes") {
      result = await readNotes(VAULT_PATH!, args.paths);
    } else if (toolName === "list_notes") {
      result = await listNotes(VAULT_PATH!, args);
    } else if (toolName === "get_links") {
      result = await getLinks(VAULT_PATH!, args.path);
    } else if (toolName === "get_outline") {
      result = await getOutline(VAULT_PATH!, args.path);
    } else if (toolName === "read_section") {
      result = await readSection(VAULT_PATH!, args);
    } else if (toolName === "list_tags") {
      result = await listTags(VAULT_PATH!);
    } else if (toolName === "find_by_tag") {
      result = await findByTag(VAULT_PATH!, args);
    } else if (toolName === "list_recent_notes") {
      result = await listRecentNotes(VAULT_PATH!, args);
    } else if (toolName === "get_related_notes") {
      result = await getRelatedNotes(VAULT_PATH!, args);
    } else if (toolName === "get_frontmatter") {
      result = await getFrontmatter(VAULT_PATH!, args.path);
    } else if (toolName === "resolve_note") {
      result = await resolveNote(VAULT_PATH!, args.query);
    } else if (toolName === "get_vault_stats") {
      result = await getVaultStats(VAULT_PATH!);
    } else if (toolName === "list_vault_issues") {
      result = await listVaultIssues(VAULT_PATH!, args);
    } else if (toolName === "list_files") {
      result = await listFiles(VAULT_PATH!, args);
    } else if (toolName === "list_folders") {
      result = await listFolders(VAULT_PATH!, args);
    } else if (toolName === "write_note") {
      result = await writeNote(VAULT_PATH!, args);
    } else if (toolName === "append_note") {
      result = await appendNote(VAULT_PATH!, args);
    } else if (toolName === "prepend_note") {
      result = await prependNote(VAULT_PATH!, args);
    } else if (toolName === "delete_note") {
      result = await deleteNote(VAULT_PATH!, args.path, { permanent: args.permanent });
    } else if (toolName === "move_note") {
      result = await moveNote(VAULT_PATH!, args);
    } else if (toolName === "move_file") {
      result = await moveFile(VAULT_PATH!, args);
    } else if (toolName === "patch_note") {
      result = await patchNote(VAULT_PATH!, args);
    } else if (toolName === "rename_section") {
      result = await renameSectionInVault(VAULT_PATH!, args);
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
    } else if (toolName === "list_properties") {
      result = await listProperties(VAULT_PATH!, args);
    } else if (toolName === "list_property_values") {
      result = await getPropertyValues(VAULT_PATH!, args);
    } else if (toolName === "query_notes") {
      result = await queryNotes(VAULT_PATH!, args);
    } else if (toolName === "get_property") {
      result = await getProperty(VAULT_PATH!, args);
    } else if (toolName === "add_property_values") {
      result = await addNotePropertyValues(VAULT_PATH!, args);
    } else if (toolName === "remove_property_values") {
      result = await removeNotePropertyValues(VAULT_PATH!, args);
    } else if (toolName === "rename_property") {
      result = await renameNoteProperty(VAULT_PATH!, args);
    } else if (toolName === "bulk_edit") {
      result = await bulkEdit(VAULT_PATH!, args);
    } else if (toolName === "list_templates") {
      result = await listTemplates(VAULT_PATH!, args);
    } else if (toolName === "apply_template") {
      result = await applyTemplate(VAULT_PATH!, args);
    } else if (toolName === "insert_template") {
      result = await insertTemplate(VAULT_PATH!, args);
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

/** Parse a --where JSON string into an object, exiting cleanly on bad JSON. */
function parseWhere(json: string | undefined): unknown {
  if (json === undefined) return undefined;
  try {
    return JSON.parse(json);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Error:", "Invalid --where JSON: " + message);
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
  .option("-l, --limit <n>", "Max files to return (default: 20, 0 = unlimited)")
  .option("--max-matches <n>", "Max matches per file (default: 20, 0 = unlimited)")
  .option("--offset <n>", "Matching files to skip before the window (pagination)")
  .option("--folder <folder>", "Restrict to notes under this folder")
  .option("--tag <tag...>", "Restrict to notes with these tags (repeatable)")
  .option("--match <mode>", "tags match mode: any (default) or all")
  .option("--where <json>", "Frontmatter filter as JSON")
  .action(async (pattern: string, options: any, command: Command) => {
    const verbose = command.parent?.opts().verbose ?? false;
    const context = parseInt(options.context, 10);
    let where: unknown;
    if (options.where !== undefined) {
      try {
        where = JSON.parse(options.where);
      } catch (e) {
        console.error("Error:", "Invalid --where JSON: " + (e instanceof Error ? e.message : String(e)));
        process.exit(1);
      }
    }
    const args = {
      pattern,
      ...(options.caseSensitive && { case_sensitive: true }),
      ...(options.wholeWord && { whole_word: true }),
      ...(options.multiline && { multiline: true }),
      ...(context !== 5 && { context_lines: context }),
      ...(options.limit !== undefined && { limit: parseInt(options.limit, 10) }),
      ...(options.maxMatches !== undefined && { max_matches_per_file: parseInt(options.maxMatches, 10) }),
      ...(options.offset !== undefined && { offset: parseInt(options.offset, 10) }),
      ...(options.folder && { folder: options.folder }),
      ...(options.tag && { tags: options.tag }),           // commander collects repeated --tag into an array
      ...(options.match && { match: options.match }),
      ...(where !== undefined && { where }),
    };
    await queryTool("search_notes", args, verbose);
  });

program
  .command("search-ranked <query>")
  .description("BM25 relevance-ranked full-text search, optionally scoped by folder/tags/where")
  .option("-l, --limit <n>", "Maximum number of results (default 100; 0 = unbounded)")
  .option("--offset <n>", "Ranked hits to skip before the window (pagination; reaches hits past the 100 cap)")
  .option("--folder <folder>", "Restrict to notes under this folder")
  .option("--tag <tag...>", "Restrict to notes with these tags (repeatable)")
  .option("--match <mode>", "tags match mode: any (default) or all")
  .option("--where <json>", "Frontmatter filter as JSON")
  .action(async (query: string, options: any, command: Command) => {
    const verbose = command.parent?.opts().verbose ?? false;
    const args: any = { query };
    if (options.limit !== undefined) args.limit = parseInt(options.limit, 10);
    if (options.offset !== undefined) args.offset = parseInt(options.offset, 10);
    if (options.folder !== undefined) args.folder = options.folder;
    if (options.tag) args.tags = options.tag; // commander collects repeated --tag into an array
    if (options.match !== undefined) args.match = options.match;
    if (options.where !== undefined) {
      try {
        args.where = JSON.parse(options.where);
      } catch (e) {
        console.error("Error:", "Invalid --where JSON: " + (e instanceof Error ? e.message : String(e)));
        process.exit(1);
      }
    }
    await queryTool("search_notes_ranked", args, verbose);
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
  .description("List notes as lightweight headers, optionally scoped by folder/tags/where")
  .option("-f, --folder <folder>", "Restrict to notes under this folder")
  .option("--tag <tag...>", "Restrict to notes with these tags (repeatable)")
  .option("--match <mode>", "tags match mode: any (default) or all")
  .option("--where <json>", "Frontmatter filter as JSON")
  .option("-l, --limit <n>", "Maximum number of notes to return")
  .option("-o, --offset <n>", "Rows to skip before the window (pagination)")
  .action(async (options: any, command: Command) => {
    const verbose = command.parent?.opts().verbose ?? false;
    const where = parseWhere(options.where);
    const args = {
      ...(options.folder && { folder: options.folder }),
      ...(options.tag && { tags: options.tag }),
      ...(options.match && { match: options.match }),
      ...(where !== undefined && { where }),
      ...(options.limit && { limit: parseInt(options.limit, 10) }),
      ...(options.offset !== undefined && { offset: parseInt(options.offset, 10) })
    };
    await queryTool("list_notes", args, verbose);
  });

program
  .command("folders")
  .description("List folders as a flat tree with note counts")
  .option("-f, --folder <folder>", "Restrict to folders under this folder")
  .option("-d, --depth <n>", "Relative depth cap (1 = immediate children)")
  .option("-l, --limit <n>", "Maximum number of folders to return")
  .option("-o, --offset <n>", "Rows to skip before the window (pagination)")
  .action(async (options: any, command: Command) => {
    const verbose = command.parent?.opts().verbose ?? false;
    const args = {
      ...(options.folder && { folder: options.folder }),
      ...(options.depth && { depth: parseInt(options.depth, 10) }),
      ...(options.limit && { limit: parseInt(options.limit, 10) }),
      ...(options.offset !== undefined && { offset: parseInt(options.offset, 10) }),
    };
    await queryTool("list_folders", args, verbose);
  });

program
  .command("templates")
  .description("List the vault's core Templates-plugin templates")
  .option("-l, --limit <n>", "Maximum number of templates to return")
  .option("-o, --offset <n>", "Rows to skip before the window (pagination)")
  .action(async (options: any, command: Command) => {
    const verbose = command.parent?.opts().verbose ?? false;
    const args = {
      ...(options.limit && { limit: parseInt(options.limit, 10) }),
      ...(options.offset !== undefined && { offset: parseInt(options.offset, 10) }),
    };
    await queryTool("list_templates", args, verbose);
  });

program
  .command("template-apply")
  .description("Create a new note from a template (expands {{title}}/{{date}}/{{time}})")
  .argument("<template>", "Template name (basename) or template-folder-relative path")
  .argument("<path>", "Destination note path for the new note")
  .option("-o, --overwrite", "Overwrite an existing note at the destination")
  .action(async (template: string, path: string, options: any, command: Command) => {
    const verbose = command.parent?.opts().verbose ?? false;
    const args = { template, path, ...(options.overwrite && { overwrite: true }) };
    await queryTool("apply_template", args, verbose);
  });

program
  .command("template-insert")
  .description("Expand a template into an existing note (append/prepend/section)")
  .argument("<template>", "Template name (basename) or template-folder-relative path")
  .argument("<path>", "Existing note to insert into")
  .requiredOption("--position <pos>", "Where to insert: append | prepend | section")
  .option("--section <heading>", "Heading (or ' > '-joined path) when position is 'section'")
  .option("--create-section", "Create the section if missing (position 'section' only)")
  .action(async (template: string, path: string, options: any, command: Command) => {
    const verbose = command.parent?.opts().verbose ?? false;
    const args = {
      template,
      path,
      position: options.position,
      ...(options.section && { section: options.section }),
      ...(options.createSection && { create_section: true }),
    };
    await queryTool("insert_template", args, verbose);
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
  .command("outline <path>")
  .description("Show a note's heading outline (levels, paths, ambiguity)")
  .action(async (path: string, _options: any, command: Command) => {
    const verbose = command.parent?.opts().verbose ?? false;
    await queryTool("get_outline", { path }, verbose);
  });

program
  .command("read-section <path> <section>")
  .description("Read one section by heading or \"A > B\" path")
  .option("--include-subsections", "Include nested subsections")
  .action(async (path: string, section: string, options: any, command: Command) => {
    const verbose = command.parent?.opts().verbose ?? false;
    await queryTool(
      "read_section",
      { path, section, include_subsections: !!options.includeSubsections },
      verbose
    );
  });

program
  .command("tags")
  .description("List every tag in the vault with note counts")
  .option("-o, --offset <n>", "Rows to skip before the window (pagination)")
  .action(async (options: any, command: Command) => {
    const verbose = command.parent?.opts().verbose ?? false;
    const args = {
      ...(options.offset !== undefined && { offset: parseInt(options.offset, 10) })
    };
    await queryTool("list_tags", args, verbose);
  });

program
  .command("find-by-tag")
  .description("Find notes matching one or more tags, optionally scoped by folder/where")
  .argument("<tags...>", "Tags to match (with or without leading #)")
  .option("-a, --all", "Require all tags (default: any)")
  .option("-f, --folder <folder>", "Restrict to notes under this folder")
  .option("--where <json>", "Additional frontmatter filter as JSON (all conditions apply)")
  .option("-l, --limit <n>", "Maximum number of notes to return")
  .option("-o, --offset <n>", "Rows to skip before the window (pagination)")
  .action(async (tags: string[], options: any, command: Command) => {
    const verbose = command.parent?.opts().verbose ?? false;
    const where = parseWhere(options.where);
    const args = {
      tags,
      ...(options.all && { match: "all" }),
      ...(options.folder && { folder: options.folder }),
      ...(where !== undefined && { where }),
      ...(options.limit && { limit: parseInt(options.limit, 10) }),
      ...(options.offset !== undefined && { offset: parseInt(options.offset, 10) })
    };
    await queryTool("find_by_tag", args, verbose);
  });

program
  .command("recent")
  .description("List notes ordered by recency (newest first), optionally scoped by folder/tags/where")
  .option("-l, --limit <n>", "Maximum number of notes to return (default: 20)")
  .option("-s, --since <date>", "Only include notes on or after this ISO date")
  .option("-d, --date-field <field>", "Frontmatter date field to sort by")
  .option("-f, --folder <folder>", "Restrict to notes under this folder")
  .option("--tag <tag...>", "Restrict to notes with these tags (repeatable)")
  .option("--match <mode>", "tags match mode: any (default) or all")
  .option("--where <json>", "Frontmatter filter as JSON")
  .option("-o, --offset <n>", "Rows to skip before the window (pagination)")
  .action(async (options: any, command: Command) => {
    const verbose = command.parent?.opts().verbose ?? false;
    const where = parseWhere(options.where);
    const args = {
      ...(options.limit && { limit: parseInt(options.limit, 10) }),
      ...(options.since && { since: options.since }),
      ...(options.dateField && { date_field: options.dateField }),
      ...(options.folder && { folder: options.folder }),
      ...(options.tag && { tags: options.tag }),
      ...(options.match && { match: options.match }),
      ...(where !== undefined && { where }),
      ...(options.offset !== undefined && { offset: parseInt(options.offset, 10) })
    };
    await queryTool("list_recent_notes", args, verbose);
  });

program
  .command("related")
  .description("Find the notes most related to a given note, ranked with reasons; scope the candidate pool by folder/tags/where")
  .argument("<path>", "Relative note path")
  .option("-f, --folder <folder>", "Restrict candidates to notes under this folder")
  .option("--tag <tag...>", "Restrict candidates to notes with these tags (repeatable)")
  .option("--match <mode>", "tags match mode: any (default) or all")
  .option("--where <json>", "Restrict candidates by frontmatter filter as JSON")
  .option("-l, --limit <n>", "Maximum number of related notes to return (default 100; 0 = unbounded)")
  .option("-o, --offset <n>", "Rows to skip before the window (pagination)")
  .action(async (path: string, options: any, command: Command) => {
    const verbose = command.parent?.opts().verbose ?? false;
    const where = parseWhere(options.where);
    const args = {
      path,
      ...(options.folder && { folder: options.folder }),
      ...(options.tag && { tags: options.tag }),
      ...(options.match && { match: options.match }),
      ...(where !== undefined && { where }),
      ...(options.limit && { limit: parseInt(options.limit, 10) }),
      ...(options.offset !== undefined && { offset: parseInt(options.offset, 10) }),
    };
    await queryTool("get_related_notes", args, verbose);
  });

program
  .command("frontmatter")
  .description("Read just a note's parsed frontmatter")
  .argument("<path>", "Relative note path")
  .action(async (path: string, _options: any, command: Command) => {
    const verbose = command.parent?.opts().verbose ?? false;
    await queryTool("get_frontmatter", { path }, verbose);
  });

program
  .command("resolve")
  .description("Resolve a title/alias/basename to a note path (exact, case-insensitive)")
  .argument("<query>", "Human-facing note name (title, alias, or basename)")
  .action(async (query: string, _options: any, command: Command) => {
    const verbose = command.parent?.opts().verbose ?? false;
    await queryTool("resolve_note", { query }, verbose);
  });

program
  .command("stats")
  .description("Summarize the whole vault (notes, tags, link-graph health, size)")
  .action(async (_options: any, command: Command) => {
    const verbose = command.parent?.opts().verbose ?? false;
    await queryTool("get_vault_stats", {}, verbose);
  });

program
  .command("vault-issues <kind>")
  .description("List orphans or unresolved_links")
  .option("-l, --limit <n>", "Maximum number of rows to return")
  .option("-o, --offset <n>", "Rows/groups to skip before the window (pagination)")
  .action(async (kind: string, options: any, command: Command) => {
    const verbose = command.parent?.opts().verbose ?? false;
    const args = {
      kind,
      ...(options.limit !== undefined && { limit: parseInt(options.limit, 10) }),
      ...(options.offset !== undefined && { offset: parseInt(options.offset, 10) }),
    };
    await queryTool("list_vault_issues", args, verbose);
  });

program
  .command("files")
  .description("List non-markdown files (attachments)")
  .option("-f, --folder <folder>", "Restrict to files under this folder")
  .option("-e, --extension <ext>", "Filter by extension (dot optional)")
  .option("-l, --limit <n>", "Maximum number of files to return")
  .option("-o, --offset <n>", "Rows to skip before the window (pagination)")
  .action(async (options: any, command: Command) => {
    const verbose = command.parent?.opts().verbose ?? false;
    const args = {
      ...(options.folder && { folder: options.folder }),
      ...(options.extension && { extension: options.extension }),
      ...(options.limit !== undefined && { limit: parseInt(options.limit, 10) }),
      ...(options.offset !== undefined && { offset: parseInt(options.offset, 10) }),
    };
    await queryTool("list_files", args, verbose);
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
  .command("prepend")
  .description("Prepend text to the start of a note's body (after any frontmatter)")
  .argument("<path>", "Relative note path")
  .argument("[content]", "Text to prepend (omit to read from --file or stdin)")
  .option("-f, --file <file>", "Read the text from a file")
  .option("-c, --create", "Create the note if it does not exist")
  .action(async (path: string, content: string | undefined, options: any, command: Command) => {
    const verbose = command.parent?.opts().verbose ?? false;
    const args = {
      path,
      content: readContent(content, options.file),
      ...(options.create && { create: true }),
    };
    await queryTool("prepend_note", args, verbose);
  });

program
  .command("delete")
  .description("Delete a note (trash-safe by default; --permanent to unlink)")
  .argument("<path>", "Relative note path")
  .option("-p, --permanent", "Permanently delete instead of moving to .trash")
  .action(async (path: string, options: any, command: Command) => {
    const verbose = command.parent?.opts().verbose ?? false;
    await queryTool("delete_note", { path, ...(options.permanent && { permanent: true }) }, verbose);
  });

program
  .command("move")
  .description("Move or rename a note, updating wikilinks that point to it")
  .argument("<from>", "Current relative note path")
  .argument("<to>", "New relative note path")
  .option("-o, --overwrite", "Allow replacing an existing note at the destination")
  .option("-n, --no-update-links", "Do not rewrite wikilinks that point to this note")
  .action(async (from: string, to: string, options: any, command: Command) => {
    const verbose = command.parent?.opts().verbose ?? false;
    const args = {
      from,
      to,
      ...(options.overwrite && { overwrite: true }),
      ...(options.updateLinks === false && { update_links: false }),
    };
    await queryTool("move_note", args, verbose);
  });

program
  .command("move-file")
  .description("Move or rename an arbitrary file (attachment/image), no link rewriting")
  .argument("<from>", "Current relative file path (with extension)")
  .argument("<to>", "New relative file path (with extension)")
  .option("-o, --overwrite", "Allow replacing an existing file at the destination")
  .action(async (from: string, to: string, options: any, command: Command) => {
    const verbose = command.parent?.opts().verbose ?? false;
    const args = { from, to, ...(options.overwrite && { overwrite: true }) };
    await queryTool("move_file", args, verbose);
  });

program
  .command("patch")
  .description("Apply a literal find/replace patch to a note")
  .argument("<path>", "Relative note path")
  .argument("<find>", "Exact literal text to find")
  .argument("<replace>", "Replacement text")
  .option("-a, --all", "Replace every occurrence instead of only the first")
  .action(async (path: string, find: string, replace: string, options: any, command: Command) => {
    const verbose = command.parent?.opts().verbose ?? false;
    const args = { path, find, replace, ...(options.all && { all: true }) };
    await queryTool("patch_note", args, verbose);
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

program
  .command("bulk-edit")
  .description("Apply frontmatter mutations to many notes (JSON select + operations)")
  .requiredOption("--select <json>", "Selection JSON: {paths:[...]} or {where:{...}} / {tags:[...]}")
  .requiredOption("--operations <json>", "Operations JSON array, e.g. [{\"op\":\"add_tag\",\"tags\":[\"x\"]}]")
  .option("--dry-run", "Preview matched notes without writing")
  .option("--expected-count <n>", "Abort if the match count differs", (v) => parseInt(v, 10))
  .action(async (options: any, command: Command) => {
    const verbose = command.parent?.opts().verbose ?? false;
    let select: any;
    try {
      select = JSON.parse(options.select);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Error:", "Invalid --select JSON: " + message);
      process.exit(1);
    }
    let operations: any;
    try {
      operations = JSON.parse(options.operations);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Error:", "Invalid --operations JSON: " + message);
      process.exit(1);
    }
    const args = {
      select,
      operations,
      ...(options.dryRun && { dry_run: true }),
      ...(options.expectedCount !== undefined && { expected_count: options.expectedCount }),
    };
    await queryTool("bulk_edit", args, verbose);
  });

program
  .command("properties")
  .description("List the frontmatter property schema (keys, counts, types)")
  .option("--no-tags", "Omit the tags key")
  .option("-o, --offset <n>", "Rows to skip before the window (pagination)", (v) => parseInt(v, 10))
  .action(async (options: any, command: Command) => {
    await queryTool(
      "list_properties",
      { include_tags: options.tags, ...(options.offset !== undefined && { offset: options.offset }) },
      command.parent?.opts().verbose
    );
  });

program
  .command("property-values <key>")
  .description("List distinct values of a property with counts")
  .option("-l, --limit <n>", "Maximum number of values", (v) => parseInt(v, 10))
  .option("-o, --offset <n>", "Rows to skip before the window (pagination)", (v) => parseInt(v, 10))
  .action(async (key: string, options: any, command: Command) => {
    await queryTool(
      "list_property_values",
      { key, limit: options.limit, ...(options.offset !== undefined && { offset: options.offset }) },
      command.parent?.opts().verbose
    );
  });

program
  .command("query")
  .description("Find notes by frontmatter condition (JSON where object), optionally scoped by folder/tags")
  .requiredOption("--where <json>", "Conditions as a JSON object")
  .option("--match <mode>", "all (default) or any (governs the where conditions)", "all")
  .option("-f, --folder <folder>", "Restrict to notes under this folder")
  .option("--tag <tag...>", "Additionally restrict to notes with these tags (repeatable; any of them)")
  .option("-l, --limit <n>", "Maximum number of notes", (v) => parseInt(v, 10))
  .option("-o, --offset <n>", "Rows to skip before the window (pagination)", (v) => parseInt(v, 10))
  .action(async (options: any, command: Command) => {
    const where = parseWhere(options.where);
    await queryTool(
      "query_notes",
      {
        where,
        match: options.match,
        ...(options.folder && { folder: options.folder }),
        ...(options.tag && { tags: options.tag }),
        limit: options.limit,
        ...(options.offset !== undefined && { offset: options.offset }),
      },
      command.parent?.opts().verbose
    );
  });

program
  .command("get-property <path> <key>")
  .description("Read one frontmatter property from a note")
  .action(async (path: string, key: string, _options: any, command: Command) => {
    await queryTool("get_property", { path, key }, command.parent?.opts().verbose);
  });

program
  .command("add-property-values <path> <key> <values...>")
  .description("Add values to an array-valued property")
  .action(async (path: string, key: string, values: string[], _options: any, command: Command) => {
    await queryTool("add_property_values", { path, key, values }, command.parent?.opts().verbose);
  });

program
  .command("remove-property-values <path> <key> <values...>")
  .description("Remove values from an array-valued property")
  .action(async (path: string, key: string, values: string[], _options: any, command: Command) => {
    await queryTool("remove_property_values", { path, key, values }, command.parent?.opts().verbose);
  });

program
  .command("rename-property <path> <from> <to>")
  .description("Rename a frontmatter property key in a note")
  .action(async (path: string, from: string, to: string, _options: any, command: Command) => {
    await queryTool("rename_property", { path, from, to }, command.parent?.opts().verbose);
  });

program
  .command("rename-section <path> <from> <to>")
  .description("Rename a heading and rewrite inbound [[note#heading]] anchors")
  .option("--no-update-anchors", "Do not rewrite inbound anchors")
  .action(async (path: string, from: string, to: string, options: any, command: Command) => {
    await queryTool(
      "rename_section",
      { path, from, to, update_anchors: options.updateAnchors },
      command.parent?.opts().verbose
    );
  });

program.parseAsync(process.argv);
