import { spawn } from "node:child_process";
import { relative } from "node:path";
import { SearchNotesParams, SearchResult, SearchNotesResponse } from "../types.js";
import { getIndex, type VaultIndex } from "./vault-index.js";
import type { Condition } from "./property-match.js";
import { resolveCandidates, validateCandidateFilter } from "./candidate-filter.js";

interface RipgrepResult {
  stdout: string;
  stderr: string;
  code: number;
}

function runRipgrep(args: string[]): Promise<RipgrepResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("rg", args);

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      resolve({ stdout, stderr, code: code ?? 0 });
    });
  });
}

export async function searchNotes(vaultPath: string, params: SearchNotesParams): Promise<SearchNotesResponse> {
  const {
    pattern,
    case_sensitive = false,
    whole_word = false,
    multiline = false,
    context_lines = 5,
    limit = 20,
    max_matches_per_file = 20,
    offset = 0,
    folder,
    tags,
    match = "any",
    where,
  } = params;

  // Input validation
  if (!pattern || typeof pattern !== 'string') {
    throw new Error('Pattern must be a non-empty string');
  }

  if (pattern.length > 1000) {
    throw new Error('Pattern too long (max 1000 characters)');
  }

  if (!Number.isInteger(context_lines) || context_lines < 0 || context_lines > 100) {
    throw new Error('Context lines must be an integer between 0 and 100');
  }

  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error('limit must be a non-negative integer (0 = unlimited)');
  }

  if (!Number.isInteger(max_matches_per_file) || max_matches_per_file < 0) {
    throw new Error('max_matches_per_file must be a non-negative integer (0 = unlimited)');
  }

  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error('offset must be a non-negative integer');
  }

  if (!vaultPath || typeof vaultPath !== 'string') {
    throw new Error('Vault path must be a non-empty string');
  }

  const hasFilter = folder !== undefined || tags !== undefined || where !== undefined;
  let candidatePaths: string[] | null = null; // null = whole-vault (no filter)
  let index: VaultIndex | null = null; // kept for the body_line pass below

  if (hasFilter) {
    validateCandidateFilter({ tags, where, match });

    index = await getIndex(vaultPath);
    const matched = resolveCandidates(index, {
      folder,
      tags,
      where: where as Record<string, Condition> | undefined,
      tagMatch: match,
      whereMatch: "all", // search_notes: match governs only tags
    });

    candidatePaths = matched.map((e) => e.fullPath);

    // Zero-candidate guard: never fall through to a whole-vault rg (which would
    // search the cwd given no path args). Return the empty result directly.
    if (candidatePaths.length === 0) {
      return { results: [], truncated: false, files_returned: 0, files_skipped: 0, files_omitted: 0, matches_capped_in: [] };
    }
  }

  const baseArgs = [
    "--json",
    "--type", "md",
    "--context", context_lines.toString(),
  ];
  if (!case_sensitive) baseArgs.push("--ignore-case");
  if (whole_word) baseArgs.push("--word-regexp");
  if (multiline) baseArgs.push("--multiline");

  // Collect rg stdout across one or more invocations. With filters we pass an
  // explicit candidate path list, chunked so a large vault never overflows
  // ARG_MAX; without filters we search the whole vault root once.
  let stdout = "";
  const CHUNK = 500; // conservative path-count per rg call
  const runChunk = async (paths: string[]): Promise<void> => {
    const args = [...baseArgs, "--", pattern, ...paths];
    const r = await runRipgrep(args);
    if (r.code !== 0 && r.code !== 1) {
      console.error(`ripgrep failed with code ${r.code}:`, r.stderr);
      throw new Error(`Search failed`);
    }
    stdout += r.stdout;
  };

  if (candidatePaths === null) {
    await runChunk([vaultPath]);
  } else {
    for (let i = 0; i < candidatePaths.length; i += CHUNK) {
      await runChunk(candidatePaths.slice(i, i + CHUNK));
    }
  }

  if (!stdout.trim()) {
    return { results: [], truncated: false, files_returned: 0, files_skipped: 0, files_omitted: 0, matches_capped_in: [] };
  }

  const results: SearchResult[] = [];
  const lines = stdout.trim().split('\n');

  const fileLimit = limit;                       // 0 = unlimited
  const matchLimit = max_matches_per_file;       // 0 = unlimited
  const cappedFiles = new Set<string>();

  /**
   * One file's raw rg events. Context is kept keyed by line number rather than
   * appended to "the match seen so far": rg emits a match's LEADING context
   * BEFORE the match event itself, so at a file boundary those events arrive
   * while the previous file is still current. Attributing them positionally
   * pushed the next file's leading lines onto the previous file's last match
   * and dropped each file's own leading context.
   */
  interface RawFile {
    path: string;
    matches: { line_number: number; content: string }[];
    context: Map<number, string>;
  }

  // --- Pass 1: group the event stream by the path each event carries --------
  const rawFiles: RawFile[] = [];
  const byPath = new Map<string, RawFile>();
  const fileFor = (eventPath: string): RawFile => {
    const relativePath = relative(vaultPath, eventPath).replace(/\.md$/, '');
    let file = byPath.get(relativePath);
    if (!file) {
      file = { path: relativePath, matches: [], context: new Map() };
      byPath.set(relativePath, file);
      rawFiles.push(file);
    }
    return file;
  };

  for (const line of lines) {
    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const eventPath = parsed?.data?.path?.text;
    if (typeof eventPath !== 'string') continue; // e.g. the trailing summary event

    if (parsed.type === 'match') {
      if (parsed.data.submatches && parsed.data.submatches.length > 0) {
        fileFor(eventPath).matches.push({
          line_number: parsed.data.line_number,
          content: parsed.data.lines.text,
        });
      }
    } else if (parsed.type === 'context') {
      fileFor(eventPath).context.set(parsed.data.line_number, parsed.data.lines.text);
    }
  }

  /** Context lines in the inclusive line range [from, to], in line order. */
  const contextRange = (ctx: Map<number, string>, from: number, to: number): string[] => {
    const out: string[] = [];
    for (let n = Math.max(1, from); n <= to; n++) {
      const text = ctx.get(n);
      if (text !== undefined) out.push(text);
    }
    return out;
  };

  // --- Pass 2: window the files, cap matches, attach each match's own context
  let filesSkipped = 0; // distinct matching files dropped before the window by offset
  let filesOmitted = 0; // distinct matching files dropped after it by limit
  // Sorted by path so `offset` pages are stable. ripgrep's parallel walker
  // emits files in a nondeterministic order that varies between invocations,
  // and each paginated call re-runs it — so windowing raw emission order let
  // page 2 repeat files from page 1 and skip others. Matches the index-backed
  // tools' ordering (VaultIndex.getEntries).
  const matching = rawFiles
    .filter((f) => f.matches.length > 0)
    .sort((a, b) => a.path.localeCompare(b.path));

  for (let i = 0; i < matching.length; i++) {
    const file = matching[i];
    // Window the matching files: offset first (skip the leading `offset` files
    // outright), then the file cap over the post-offset window.
    if (i < offset) {
      filesSkipped += 1;
      continue;
    }
    if (fileLimit > 0 && results.length >= fileLimit) {
      filesOmitted += 1;
      continue;
    }

    const kept = matchLimit > 0 ? file.matches.slice(0, matchLimit) : file.matches;
    if (kept.length < file.matches.length) cappedFiles.add(file.path);

    results.push({
      path: file.path,
      matches: kept.map((m) => ({
        line_number: m.line_number,
        body_line: null, // annotated from the index after collection
        content: m.content,
        context_before: contextRange(file.context, m.line_number - context_lines, m.line_number - 1),
        context_after: contextRange(file.context, m.line_number + 1, m.line_number + context_lines),
      })),
    });
  }

  // Bridge ripgrep's file-absolute line numbers to the body-relative
  // convention of get_outline/list_tasks/set_task_state: body_line =
  // line_number - bodyBegin (the note's frontmatter raw-line count, from the
  // same gray-matter parse those tools read). Hits inside the frontmatter
  // block — and files the index doesn't know — stay null.
  if (results.length > 0) {
    const idx = index ?? (await getIndex(vaultPath));
    for (const file of results) {
      const bodyBegin = idx.getEntry(file.path)?.bodyBegin;
      if (bodyBegin === undefined) continue;
      for (const m of file.matches) {
        m.body_line = m.line_number > bodyBegin ? m.line_number - bodyBegin : null;
      }
    }
  }

  return {
    results,
    // Skipping forward via offset never sets truncated (matches the envelope
    // rule); only a dropped-after-window file or a per-file match cap does.
    truncated: filesOmitted > 0 || cappedFiles.size > 0,
    files_returned: results.length,
    files_skipped: filesSkipped,
    files_omitted: filesOmitted,
    matches_capped_in: [...cappedFiles]
  };
}
