import { readFile, stat } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import matter from "gray-matter";
import { Note, NoteMetadata } from "../types.js";

export async function readNotes(vaultPath: string, notePaths: string[]): Promise<Note[]> {
  // Input validation
  if (!vaultPath || typeof vaultPath !== 'string') {
    throw new Error('Vault path must be a non-empty string');
  }

  if (!Array.isArray(notePaths) || notePaths.length === 0) {
    throw new Error('Note paths must be a non-empty array');
  }

  if (notePaths.length > 50) {
    throw new Error('Cannot read more than 50 notes at once');
  }

  const notes: Note[] = [];
  const resolvedVaultPath = resolve(vaultPath);

  for (const notePath of notePaths) {
    try {
      // Input validation for each path
      if (!notePath || typeof notePath !== 'string') {
        throw new Error('Note path must be a non-empty string');
      }

      // Prevent path traversal by validating the resolved path
      const fileName = `${notePath}${notePath.endsWith('.md') ? '' : '.md'}`;
      const fullPath = resolve(join(vaultPath, fileName));

      // Ensure the resolved path is within the vault directory
      const relativePath = relative(resolvedVaultPath, fullPath);
      if (relativePath.startsWith('..') || relativePath.includes('..')) {
        throw new Error('Invalid note path: path traversal not allowed');
      }

      // Check file size before reading (max 10MB)
      const fileInfo = await stat(fullPath);
      if (fileInfo.size > 10 * 1024 * 1024) {
        throw new Error('Note file too large (max 10MB)');
      }

      const content = await readFile(fullPath, "utf-8");

      const { data: frontmatter, content: markdownContent } = matter(content);

      const tags = extractObsidianTags(markdownContent);
      const cleanContent = removeObsidianTags(markdownContent);

      const name = notePath.replace(/\.md$/, '');

      notes.push({
        name,
        contents: cleanContent.trim(),
        metadata: frontmatter as NoteMetadata,
        tags
      });
    } catch (error) {
      // Log full error details to stderr for debugging
      console.error(`Error reading note ${notePath}:`, error);

      const message = error instanceof Error ? error.message : String(error);

      // Don't expose detailed file system errors - just indicate the note wasn't found/readable
      if (message.includes('path traversal')) {
        throw error; // Re-throw security errors with full details
      }
      throw new Error(`Note not found or not readable: ${notePath}`);
    }
  }

  return notes;
}

function extractObsidianTags(content: string): string[] {
  const tagRegex = /#[\w-]+/g;
  const matches = content.match(tagRegex);
  return matches ? matches.map(tag => tag.substring(1)) : [];
}

function removeObsidianTags(content: string): string {
  return content.replace(/#[\w-]+/g, '').replace(/\n\s*\n\s*\n/g, '\n\n');
}
