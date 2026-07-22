import { spawn } from "node:child_process";
import { relative } from "node:path";
import { SearchNotesParams, SearchResult, SearchNotesResponse } from "../types.js";

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
    max_matches_per_file = 20
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

  const args = [
    "--json",
    "--type", "md",
    "--context", context_lines.toString(),
  ];

  if (!case_sensitive) {
    args.push("--ignore-case");
  }

  if (whole_word) {
    args.push("--word-regexp");
  }

  if (multiline) {
    args.push("--multiline");
  }

  // Use -- separator to prevent pattern from being interpreted as flags
  args.push("--", pattern, vaultPath);

  const { stdout, stderr, code } = await runRipgrep(args);

  if (code !== 0 && code !== 1) {
    // Log full error details to stderr for debugging
    console.error(`ripgrep failed with code ${code}:`, stderr);
    throw new Error(`Search failed`);
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
        } else {
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
