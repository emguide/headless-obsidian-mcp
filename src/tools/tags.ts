import { readFile } from "node:fs/promises";
import matter from "gray-matter";
import { walkVault, collectTags, buildHeader, assertVaultPath } from "./vault.js";
import { TagCount, FindByTagParams, NoteHeader } from "../types.js";

/** Read a note and return its unified tag set (frontmatter + inline). */
async function tagsForFile(fullPath: string): Promise<string[]> {
  try {
    const raw = await readFile(fullPath, "utf-8");
    const { data, content } = matter(raw);
    return collectTags(data as Record<string, unknown>, content);
  } catch {
    return [];
  }
}

/**
 * Aggregate every tag used across the vault with the number of notes that use
 * it, sorted by count (descending) then name. Unifies inline `#tags` with
 * frontmatter `tags:` so the vault's full topic index is visible to the agent.
 */
export async function listTags(vaultPath: string): Promise<TagCount[]> {
  assertVaultPath(vaultPath);
  const files = await walkVault(vaultPath);
  const counts = new Map<string, number>();

  await Promise.all(
    files.map(async (f) => {
      const tags = await tagsForFile(f.fullPath);
      for (const tag of new Set(tags)) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    })
  );

  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/**
 * Find notes matching one or more tags. With match="all" a note must carry
 * every requested tag; with "any" (default) at least one. Returns lightweight
 * headers, giving high-precision retrieval based on human curation.
 */
export async function findByTag(
  vaultPath: string,
  params: FindByTagParams
): Promise<NoteHeader[]> {
  assertVaultPath(vaultPath);

  const { tags, match = "any", limit } = params;
  if (!Array.isArray(tags) || tags.length === 0) {
    throw new Error("tags must be a non-empty array");
  }
  if (match !== "any" && match !== "all") {
    throw new Error('match must be "any" or "all"');
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error("limit must be a positive integer");
  }

  // Normalize requested tags: drop leading "#", lowercase for comparison.
  const wanted = tags.map((t) => String(t).replace(/^#/, "").toLowerCase());

  const files = await walkVault(vaultPath);
  const matched = [];

  for (const f of files) {
    const noteTags = (await tagsForFile(f.fullPath)).map((t) => t.toLowerCase());
    const noteSet = new Set(noteTags);
    const hit =
      match === "all"
        ? wanted.every((w) => noteSet.has(w))
        : wanted.some((w) => noteSet.has(w));
    if (hit) matched.push(f);
  }

  const limited = limit !== undefined ? matched.slice(0, limit) : matched;
  return Promise.all(limited.map((f) => buildHeader(f)));
}
