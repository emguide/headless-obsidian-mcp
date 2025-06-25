import { SearchNotesParams, SearchResult } from "../types.ts";
import { relative } from "@std/path";

export async function searchNotes(vaultPath: string, params: SearchNotesParams): Promise<SearchResult[]> {
  const { 
    pattern, 
    case_sensitive = false, 
    whole_word = false, 
    multiline = false, 
    context_lines = 5 
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
  
  if (!vaultPath || typeof vaultPath !== 'string') {
    throw new Error('Vault path must be a non-empty string');
  }
  
  const args = [
    "rg",
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

  const command = new Deno.Command("rg", {
    args: args.slice(1),
  });

  const { stdout, stderr, code } = await command.output();
  
  if (code !== 0 && code !== 1) {
    const errorText = new TextDecoder().decode(stderr);
    // Log full error details to stderr for debugging
    console.error(`ripgrep failed with code ${code}:`, errorText);
    throw new Error(`Search failed`);
  }

  const output = new TextDecoder().decode(stdout);
  if (!output.trim()) {
    return [];
  }

  const results: SearchResult[] = [];
  const lines = output.trim().split('\n');
  
  let currentFile = '';
  let currentMatches: SearchResult['matches'] = [];
  
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      
      if (parsed.type === 'match') {
        const relativePath = relative(vaultPath, parsed.data.path.text).replace(/\.md$/, '');
        
        if (currentFile !== relativePath) {
          if (currentFile && currentMatches.length > 0) {
            results.push({ path: currentFile, matches: currentMatches });
          }
          currentFile = relativePath;
          currentMatches = [];
        }
        
        const contextBefore: string[] = [];
        const contextAfter: string[] = [];
        
        if (parsed.data.submatches && parsed.data.submatches.length > 0) {
          currentMatches.push({
            line_number: parsed.data.line_number,
            content: parsed.data.lines.text,
            context_before: contextBefore,
            context_after: contextAfter
          });
        }
      } else if (parsed.type === 'context') {
        if (currentMatches.length > 0) {
          const lastMatch = currentMatches[currentMatches.length - 1];
          if (parsed.data.line_number < lastMatch.line_number) {
            lastMatch.context_before.push(parsed.data.lines.text);
          } else {
            lastMatch.context_after.push(parsed.data.lines.text);
          }
        }
      }
    } catch (e) {
      continue;
    }
  }
  
  if (currentFile && currentMatches.length > 0) {
    results.push({ path: currentFile, matches: currentMatches });
  }
  
  return results;
}