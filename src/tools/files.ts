import { assertVaultPath, walkVault } from "./vault.js";
import { ListFilesParams, ListResponse, VaultFileEntry } from "../types.js";
import { toListResponse, assertNonNegativeInt } from "./list-response.js";

/** Default cap on `list_files` so an unbounded call is still bounded. */
const DEFAULT_LIMIT = 100;

/**
 * List non-markdown files in the vault (attachments, images, PDFs) so an agent
 * can find the file it is asked to move. Reuses walkVault's traversal and
 * ignore rules, filtered to non-.md files. Does not touch the vault index.
 *
 * Bounded by default: with no `limit`, at most `DEFAULT_LIMIT` files are
 * returned. Pass `limit: 0` for an unbounded list. The result is a
 * `ListResponse` envelope reporting `returned`/`omitted`/`truncated` so a
 * capped list is never mistaken for a complete one.
 */
export async function listFiles(
  vaultPath: string,
  params: ListFilesParams = {}
): Promise<ListResponse<VaultFileEntry>> {
  assertVaultPath(vaultPath);
  const { folder, extension, limit, offset } = params;
  assertNonNegativeInt(limit, "limit");
  assertNonNegativeInt(offset, "offset");

  const wantExt = extension
    ? extension.replace(/^\./, "").toLowerCase()
    : undefined;
  const folderPrefix = folder
    ? folder.replace(/\\/g, "/").replace(/\/$/, "") + "/"
    : undefined;

  const files = await walkVault(vaultPath, (name) => !name.endsWith(".md"));

  const out: VaultFileEntry[] = [];
  for (const f of files) {
    if (folderPrefix && !f.path.startsWith(folderPrefix)) continue;
    // Derive the extension from the BASENAME, not the whole relative path: an
    // extensionless file inside a dot-containing folder (`img.assets/README`)
    // otherwise picked up the folder's dot and reported a slash-containing,
    // case-mangled "extension" ("assets/readme") that no filter could match.
    // A leading-dot basename (`.gitignore`) is a hidden file, not an extension.
    const base = f.path.slice(f.path.lastIndexOf("/") + 1);
    const dot = base.lastIndexOf(".");
    const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
    if (wantExt !== undefined && ext !== wantExt) continue;
    out.push({
      path: f.path,
      size: f.size,
      modified: f.mtime.toISOString(),
      extension: ext,
    });
  }

  const effectiveLimit = limit === undefined ? DEFAULT_LIMIT : limit;
  return toListResponse(out, effectiveLimit === 0 ? undefined : effectiveLimit, offset);
}
