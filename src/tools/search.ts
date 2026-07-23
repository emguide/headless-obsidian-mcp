import { spawn } from "node:child_process";
import { relative } from "node:path";
import { SearchNotesParams, SearchResult, SearchNotesResponse } from "../types.js";
import { getIndex } from "./vault-index.js";
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

  // Prevent regex DoS by blocking overly complex patterns
  const suspiciousPatterns = [
    /\(\?\#.*\){10,}/, // Excessive comments
    /\{[0-9]+,[0-9]*\}.*\{[0-9]+,[0-9]*\}/, // Multiple large quantifiers
    /(\(.*\).*){5,}/, // Excessive grouping
  ];

  for (const suspicious of suspiciousPatterns) {
    if (suspicious.test(pattern)) {
      throw new Error('Pattern complexity not allowed');
    }
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

  if (!vaultPath || typeof vaultPath !== 'string') {
    throw new Error('Vault path must be a non-empty string');
  }

  const hasFilter = folder !== undefined || tags !== undefined || where !== undefined;
  let candidatePaths: string[] | null = null; // null = whole-vault (no filter)

  if (hasFilter) {
    validateCandidateFilter({ tags, where, match });

    const index = await getIndex(vaultPath);
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
      return { results: [], truncated: false, files_returned: 0, files_omitted: 0, matches_capped_in: [] };
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
    return { results: [], truncated: false, files_returned: 0, files_omitted: 0, matches_capped_in: [] };
  }

  const results: SearchResult[] = [];
  const lines = stdout.trim().split('\n');

  const fileLimit = limit;                       // 0 = unlimited
  const matchLimit = max_matches_per_file;       // 0 = unlimited
  const cappedFiles = new Set<string>();

  let currentFile = '';
  let currentMatches: SearchResult['matches'] = [];
  let filesOmitted = 0;
  let skippingCurrentFile = false; // true once fileLimit reached; count distinct extra files
  let matchCapReachedForFile = false; // true once matchLimit reached within the current file

  const flushCurrent = () => {
    if (currentFile && currentMatches.length > 0) {
      results.push({ path: currentFile, matches: currentMatches });
    }
  };

  for (const line of lines) {
    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (parsed.type === 'match') {
      const relativePath = relative(vaultPath, parsed.data.path.text).replace(/\.md$/, '');

      if (currentFile !== relativePath) {
        // New file boundary: flush the previous file's matches.
        flushCurrent();
        currentFile = relativePath;
        currentMatches = [];
        matchCapReachedForFile = false;

        // Decide whether this new file fits under the file cap.
        skippingCurrentFile = fileLimit > 0 && results.length >= fileLimit;
        if (skippingCurrentFile) {
          filesOmitted += 1;
        }
      }

      if (skippingCurrentFile) {
        continue;
      }

      if (parsed.data.submatches && parsed.data.submatches.length > 0) {
        if (matchLimit > 0 && currentMatches.length >= matchLimit) {
          matchCapReachedForFile = true;
          cappedFiles.add(relativePath);
          continue;
        }
        currentMatches.push({
          line_number: parsed.data.line_number,
          content: parsed.data.lines.text,
          context_before: [],
          context_after: []
        });
      }
    } else if (parsed.type === 'context') {
      if (skippingCurrentFile || matchCapReachedForFile) {
        continue;
      }
      if (currentMatches.length > 0) {
        const lastMatch = currentMatches[currentMatches.length - 1];
        if (parsed.data.line_number < lastMatch.line_number) {
          lastMatch.context_before.push(parsed.data.lines.text);
        } else if (
          !(matchLimit > 0 && currentMatches.length >= matchLimit) ||
          lastMatch.context_after.length < context_lines
        ) {
          // Once the match buffer is full, only accept trailing context that
          // still fits the LAST KEPT match's own context window (bounded by
          // context_lines). Anything beyond that window, once the buffer is
          // full, is context_before leakage from the next (dropped) match's
          // context events arriving ahead of that match's own match event.
          lastMatch.context_after.push(parsed.data.lines.text);
        }
      }
    }
  }

  flushCurrent();

  return {
    results,
    truncated: filesOmitted > 0 || cappedFiles.size > 0,
    files_returned: results.length,
    files_omitted: filesOmitted,
    matches_capped_in: [...cappedFiles]
  };
}
