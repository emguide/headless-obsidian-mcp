import { readFile, stat } from "node:fs/promises";
import { parseMatter } from "./matter-safe.js";
import { Note, NoteMetadata, ReadNotesResult } from "../types.js";
import { collectTags, resolveNotePath } from "./vault.js";
import { getIndex, VaultIndex } from "./vault-index.js";
import { noteNotFoundMessage, resolveNoteName } from "./not-found.js";

export async function readNotes(vaultPath: string, notePaths: string[]): Promise<ReadNotesResult> {
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
  const errors: Array<{ path: string; error: string }> = [];
  // Built once up front: read_notes now addresses notes the same way the
  // index-backed readers do (a bare basename or wrong-case name resolves via
  // resolveNoteName), and the same index enriches missing-note errors with
  // did-you-mean candidates.
  let index: VaultIndex | null = null;
  try {
    index = await getIndex(vaultPath);
  } catch {
    // Index unavailable - fall back to literal paths and bare error messages.
  }

  for (const notePath of notePaths) {
    try {
      // Input validation for each path
      if (!notePath || typeof notePath !== 'string') {
        throw new Error('Note path must be a non-empty string');
      }

      // Resolve the human-facing name to a canonical vault path (index-backed,
      // case-insensitive, bare-basename fallback); falls back to the literal
      // path when the index is unavailable or the name does not resolve.
      const canonical = index ? resolveNoteName(index, notePath) : notePath.replace(/\.md$/, '');

      // Prevent path traversal via the shared guard (resolveNotePath) rather than
      // a duplicated inline check — the inline copy tested `.includes("..")` with
      // no separator, so a legitimate note whose name merely contains ".." (an
      // ellipsis title like "And then...") was misclassified as an attack and,
      // since traversal fails the whole batch, poisoned every other path.
      const fullPath = resolveNotePath(vaultPath, canonical);

      // Check file size before reading (max 10MB)
      const fileInfo = await stat(fullPath);
      if (fileInfo.size > 10 * 1024 * 1024) {
        throw new Error('Note file too large (max 10MB)');
      }

      const content = await readFile(fullPath, "utf-8");

      const { data: frontmatter, content: markdownContent } = parseMatter(content);

      const tags = collectTags(frontmatter, markdownContent);

      const path = canonical.replace(/\.md$/, '');

      notes.push({
        path,
        // Verbatim body (gray-matter already strips the frontmatter block). No
        // trim: the docs promise the body "unmodified" for patch_note matching,
        // and the shared body-relative line convention (get_outline/list_tasks/
        // search_notes) breaks if a leading blank line is silently dropped.
        contents: markdownContent,
        frontmatter: frontmatter as NoteMetadata,
        tags
      });
    } catch (error) {
      // Log full error details to stderr for debugging
      console.error(`Error reading note ${notePath}:`, error);

      const message = error instanceof Error ? error.message : String(error);

      // Path traversal is a security violation, not a missing file: fail the whole batch.
      if (message.includes('path traversal')) {
        throw error;
      }
      let errorMessage = `Note not found or not readable: ${notePath}`;
      // Only a genuinely missing file gets did-you-mean candidates; a
      // too-large or unreadable file is a different failure, not a near-miss.
      // (The index was built up front; if it was unavailable, keep the bare message.)
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT' && index) {
        errorMessage = noteNotFoundMessage(index, notePath, 'Note not found or not readable');
      }
      errors.push({ path: notePath, error: errorMessage });
    }
  }

  return { notes, errors };
}
