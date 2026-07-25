import { assertVaultPath } from "./vault.js";
import { getIndex } from "./vault-index.js";
import { FolderEntry, ListFoldersParams, ListResponse } from "../types.js";
import { toListResponse, assertNonNegativeInt } from "./list-response.js";

/** Default cap so the first orientation call is bounded (matches list_notes). */
const DEFAULT_LIMIT = 100;

interface Agg {
  direct: number;
  total: number;
  children: Set<string>;
}

/**
 * Enumerate the vault's folders as a flat, bounded list — the folder-level
 * counterpart to list_notes. Derived entirely from the shared index's note
 * paths (markdown only, zero extra I/O): a note at `a/b/c.md` contributes
 * folders `a` and `a/b`. Each folder reports `notes` (direct), `total_notes`
 * (recursive), and `subfolders` (direct children). Root-level notes contribute
 * no folder. Optional `folder` scopes to strict descendants; `depth` caps the
 * relative level; `limit` follows the standard envelope policy.
 */
export async function listFolders(
  vaultPath: string,
  params: ListFoldersParams = {}
): Promise<ListResponse<FolderEntry>> {
  assertVaultPath(vaultPath);

  const { folder, depth, limit, offset } = params;
  assertNonNegativeInt(limit, "limit");
  assertNonNegativeInt(offset, "offset");
  assertNonNegativeInt(depth, "depth");

  const index = await getIndex(vaultPath);

  // Aggregate direct/recursive note counts and direct-child folders per folder.
  const agg = new Map<string, Agg>();
  const get = (p: string): Agg => {
    let a = agg.get(p);
    if (!a) {
      a = { direct: 0, total: 0, children: new Set() };
      agg.set(p, a);
    }
    return a;
  };

  for (const entry of index.getEntries()) {
    const segments = entry.path.split("/");
    segments.pop(); // drop the filename — leaves the folder segments
    if (segments.length === 0) continue; // root-level note: no folder

    // Every ancestor folder gets a recursive +1; the immediate parent also a
    // direct +1; and every folder registers its immediate child folder.
    for (let i = 0; i < segments.length; i++) {
      const path = segments.slice(0, i + 1).join("/");
      const a = get(path);
      a.total += 1;
      if (i === segments.length - 1) a.direct += 1;
      if (i > 0) {
        const parent = segments.slice(0, i).join("/");
        get(parent).children.add(path);
      }
    }
  }

  let rows: FolderEntry[] = [...agg.entries()].map(([path, a]) => ({
    path,
    notes: a.direct,
    total_notes: a.total,
    subfolders: a.children.size,
  }));

  // Scope to strict descendants of `folder`, and compute depth relative to it.
  let scopeSegments = 0;
  if (folder && folder.trim()) {
    const scope = folder.replace(/[\\/]+$/, "").replace(/\\/g, "/");
    const prefix = scope + "/";
    scopeSegments = scope.split("/").length;
    rows = rows.filter((r) => r.path.startsWith(prefix));
  }

  if (depth !== undefined) {
    rows = rows.filter((r) => r.path.split("/").length - scopeSegments <= depth);
  }

  rows.sort((a, b) => a.path.localeCompare(b.path));

  const effectiveLimit = limit === undefined ? DEFAULT_LIMIT : limit;
  return toListResponse(rows, effectiveLimit === 0 ? undefined : effectiveLimit, offset);
}
