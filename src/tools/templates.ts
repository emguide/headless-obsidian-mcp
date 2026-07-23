import { readFile, stat, readdir } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { ListResponse } from "../types.js";
import { resolveVaultFile } from "./vault.js";
import { toListResponse, assertNonNegativeInt } from "./list-response.js";

/** Env override for the template folder; wins over `.obsidian/templates.json`. */
export const TEMPLATE_FOLDER_ENV = "OBSIDIAN_TEMPLATE_FOLDER";

/** Default cap for `list_templates`, matching the other list-style tools. */
const DEFAULT_LIMIT = 100;

export interface TemplateConfig {
  /** Vault-relative template folder. */
  folder: string;
  /** Plugin default for a bare `{{date}}` (from templates.json), if set. */
  dateFormat?: string;
  /** Plugin default for a bare `{{time}}` (from templates.json), if set. */
  timeFormat?: string;
}

/**
 * Resolve the core Templates plugin's configuration, config-first: read the
 * folder and default date/time formats from `.obsidian/templates.json`, then
 * let `OBSIDIAN_TEMPLATE_FOLDER` override the folder (for headless setups). If
 * neither yields a folder, throw — an unconfigured template folder is a setup
 * problem, reported loudly rather than as an empty result.
 */
export async function resolveTemplateConfig(
  vaultPath: string
): Promise<TemplateConfig> {
  let cfg: TemplateConfig | null = null;
  try {
    const raw = await readFile(
      join(vaultPath, ".obsidian", "templates.json"),
      "utf-8"
    );
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.folder === "string" && parsed.folder.length) {
      cfg = {
        folder: parsed.folder,
        dateFormat:
          typeof parsed.dateFormat === "string" ? parsed.dateFormat : undefined,
        timeFormat:
          typeof parsed.timeFormat === "string" ? parsed.timeFormat : undefined,
      };
    }
  } catch {
    /* no/invalid config file — fall through to the env override */
  }

  const envFolder = process.env[TEMPLATE_FOLDER_ENV];
  if (envFolder && envFolder.trim().length) {
    return {
      folder: envFolder.trim(),
      dateFormat: cfg?.dateFormat,
      timeFormat: cfg?.timeFormat,
    };
  }
  if (cfg) return cfg;
  throw new Error(
    `No template folder configured. Set the core Templates plugin's folder in .obsidian/templates.json, or set ${TEMPLATE_FOLDER_ENV}.`
  );
}

export interface TemplateHeader {
  /** Vault-relative path (with .md). */
  path: string;
  /** Basename without .md. */
  name: string;
  size: number;
  /** ISO timestamp. */
  modified: string;
}

/** Enumerate the markdown files directly in the template folder. */
async function templateFiles(
  vaultPath: string,
  folder: string
): Promise<TemplateHeader[]> {
  const dirFull = resolveVaultFile(vaultPath, folder);
  let entries: string[] = [];
  try {
    entries = await readdir(dirFull);
  } catch {
    return [];
  }
  const out: TemplateHeader[] = [];
  for (const e of entries) {
    if (!e.endsWith(".md")) continue;
    const st = await stat(join(dirFull, e));
    if (!st.isFile()) continue;
    out.push({
      path: `${folder}/${e}`,
      name: e.replace(/\.md$/, ""),
      size: st.size,
      modified: new Date(st.mtimeMs).toISOString(),
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Enumerate the configured template folder as headers, in the standard list
 * envelope. Throws when no template folder is configured.
 */
export async function listTemplates(
  vaultPath: string,
  params: { limit?: number; offset?: number }
): Promise<ListResponse<TemplateHeader>> {
  const { limit, offset } = params;
  assertNonNegativeInt(limit, "limit");
  assertNonNegativeInt(offset, "offset");
  const cfg = await resolveTemplateConfig(vaultPath);
  const all = await templateFiles(vaultPath, cfg.folder);
  const effectiveLimit = limit === undefined ? DEFAULT_LIMIT : limit;
  return toListResponse(all, effectiveLimit === 0 ? undefined : effectiveLimit, offset);
}

/**
 * Read a template's raw text by name (basename, with or without .md). A
 * not-found name fails loud, listing the available templates so the caller can
 * retry with a real one.
 */
export async function readTemplate(
  vaultPath: string,
  name: string
): Promise<{ path: string; raw: string }> {
  const cfg = await resolveTemplateConfig(vaultPath);
  const base = name.replace(/\.md$/, "");
  const rel = `${cfg.folder}/${base}.md`;
  const full = resolveVaultFile(vaultPath, rel);
  try {
    const raw = await readFile(full, "utf-8");
    return { path: rel, raw };
  } catch {
    const avail = (await templateFiles(vaultPath, cfg.folder)).map((t) => t.name);
    throw new Error(
      `Template not found: ${base}. Available: ${avail.join(", ") || "(none)"}`
    );
  }
}
