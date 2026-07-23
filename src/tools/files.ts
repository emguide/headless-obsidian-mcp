import { assertVaultPath, walkVault } from "./vault.js";
import { ListFilesParams, VaultFileEntry } from "../types.js";

/**
 * List non-markdown files in the vault (attachments, images, PDFs) so an agent
 * can find the file it is asked to move. Reuses walkVault's traversal and
 * ignore rules, filtered to non-.md files. Does not touch the vault index.
 */
export async function listFiles(
  vaultPath: string,
  params: ListFilesParams = {}
): Promise<VaultFileEntry[]> {
  assertVaultPath(vaultPath);
  const { folder, extension, limit } = params;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error("limit must be a positive integer");
  }

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
    const dot = f.path.lastIndexOf(".");
    const ext = dot >= 0 ? f.path.slice(dot + 1).toLowerCase() : "";
    if (wantExt !== undefined && ext !== wantExt) continue;
    out.push({
      path: f.path,
      size: f.size,
      modified: f.mtime.toISOString(),
      extension: ext,
    });
  }

  return limit !== undefined ? out.slice(0, limit) : out;
}
