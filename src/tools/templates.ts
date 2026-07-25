import { readFile, stat, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { basename, join } from "node:path";
import process from "node:process";
import { ListResponse } from "../types.js";
import { resolveVaultFile } from "./vault.js";
import { toListResponse, assertNonNegativeInt } from "./list-response.js";
import { expand } from "./template-expand.js";
import {
  writeNote,
  appendNote,
  prependNote,
  appendNoteSection,
} from "./write.js";
import { LinkHealth } from "./link-health.js";

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

/**
 * Enumerate the markdown files under the template folder, recursively. A
 * template in a subfolder (`sub/name.md`) has its `name` reported as the
 * folder-relative path (`sub/name`) — the exact string `readTemplate` accepts —
 * so subfolder templates are both listed and offered in the "Available:" error.
 */
async function templateFiles(
  vaultPath: string,
  folder: string
): Promise<TemplateHeader[]> {
  const out: TemplateHeader[] = [];
  // Walk `folder` depth-first, accumulating markdown files. `rel` is the path
  // relative to the template folder (empty at the root); it becomes both the
  // reported `name` (minus .md) and the tail of the vault-relative `path`.
  const walk = async (rel: string): Promise<void> => {
    const dirFull = resolveVaultFile(vaultPath, rel ? `${folder}/${rel}` : folder);
    let entries: Dirent[] = [];
    try {
      entries = await readdir(dirFull, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await walk(childRel);
        continue;
      }
      if (!e.isFile() || !e.name.endsWith(".md")) continue;
      const st = await stat(join(dirFull, e.name));
      out.push({
        path: `${folder}/${childRel}`,
        name: childRel.replace(/\.md$/, ""),
        size: st.size,
        modified: new Date(st.mtimeMs).toISOString(),
      });
    }
  };
  await walk("");
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

/** The template config, or null when none is configured (no throw). */
async function templateConfigOrNull(
  vaultPath: string
): Promise<TemplateConfig | null> {
  try {
    return await resolveTemplateConfig(vaultPath);
  } catch {
    return null;
  }
}

/**
 * Read a template's raw text by name (basename, with or without .md). A name
 * is resolved inside the configured template folder first; failing that, it is
 * tried as a vault-relative note path — the Daily Notes plugin's template can
 * live anywhere in the vault (and exists without a Templates folder at all),
 * so `resolve_daily_note`'s template value is always accepted here. A
 * not-found name fails loud, listing the available templates so the caller can
 * retry with a real one.
 */
export async function readTemplate(
  vaultPath: string,
  name: string
): Promise<{ path: string; raw: string }> {
  const cfg = await templateConfigOrNull(vaultPath);
  const base = name.replace(/\.md$/, "");
  if (cfg) {
    const rel = `${cfg.folder}/${base}.md`;
    try {
      const raw = await readFile(resolveVaultFile(vaultPath, rel), "utf-8");
      return { path: rel, raw };
    } catch {
      /* not in the template folder — try the vault-relative fallback */
    }
  }
  const rel = `${base}.md`;
  try {
    const raw = await readFile(resolveVaultFile(vaultPath, rel), "utf-8");
    return { path: rel, raw };
  } catch {
    const avail = cfg
      ? (await templateFiles(vaultPath, cfg.folder)).map((t) => t.name)
      : [];
    throw new Error(
      `Template not found: ${base}. Available: ${avail.join(", ") || "(none)"} ` +
        `(a vault-relative note path is also accepted).`
    );
  }
}

/** {{title}} resolves to the note's basename, matching Obsidian. */
function titleOf(notePath: string): string {
  return basename(notePath).replace(/\.md$/, "");
}

/**
 * Expand a named template's placeholders for a given target note path. Config
 * is fetched leniently: with no Templates folder configured, a vault-path
 * template still expands, with the plugin-default date/time formats.
 */
async function expandTemplateFor(
  vaultPath: string,
  template: string,
  targetPath: string
): Promise<string> {
  const cfg = await templateConfigOrNull(vaultPath);
  const { raw } = await readTemplate(vaultPath, template);
  return expand(raw, {
    title: titleOf(targetPath),
    now: new Date(),
    dateFormat: cfg?.dateFormat,
    timeFormat: cfg?.timeFormat,
  });
}

/**
 * Create a new note from a template. Expands `{{title}}` (= the new note's
 * basename), `{{date}}`, `{{time}}`, then delegates to `write_note` — inheriting
 * its path-guard, git-guard, frontmatter validation, overwrite refusal, and
 * link-health reporting.
 */
export async function applyTemplate(
  vaultPath: string,
  {
    template,
    path,
    overwrite = false,
  }: { template: string; path: string; overwrite?: boolean }
): Promise<{ path: string; created: boolean } & LinkHealth> {
  const content = await expandTemplateFor(vaultPath, template, path);
  return writeNote(vaultPath, { path, content, overwrite });
}

/**
 * Expand a template into an *existing* note at `position` (`append` |
 * `prepend` | `section`). `{{title}}` = the existing note's basename. Delegates
 * to the matching content-write path, inheriting link-health and the section
 * tools' fail-loud ambiguity behavior. The target note must already exist —
 * a missing note surfaces the underlying "Note not found" error (fail-loud);
 * creating a note is `apply_template`'s job, not this one.
 */
export async function insertTemplate(
  vaultPath: string,
  {
    template,
    path,
    position,
    section,
    create_section = false,
  }: {
    template: string;
    path: string;
    position: "append" | "prepend" | "section";
    section?: string;
    create_section?: boolean;
  }
): Promise<{ path: string; position: string } & LinkHealth> {
  if (
    position !== "append" &&
    position !== "prepend" &&
    position !== "section"
  ) {
    throw new Error(
      `insert_template position must be "append", "prepend", or "section" (got ${JSON.stringify(position)}).`
    );
  }
  if (position === "section" && (!section || !section.length)) {
    throw new Error(
      'insert_template position "section" requires a section heading.'
    );
  }
  const content = await expandTemplateFor(vaultPath, template, path);

  let health: LinkHealth;
  if (position === "append") {
    const r = await appendNote(vaultPath, { path, content });
    health = {
      unresolved_links: r.unresolved_links,
      broken_anchors: r.broken_anchors,
    };
  } else if (position === "prepend") {
    const r = await prependNote(vaultPath, { path, content });
    health = {
      unresolved_links: r.unresolved_links,
      broken_anchors: r.broken_anchors,
    };
  } else {
    const r = await appendNoteSection(vaultPath, {
      path,
      heading: section!,
      content,
      create: create_section,
    });
    health = {
      unresolved_links: r.unresolved_links,
      broken_anchors: r.broken_anchors,
    };
  }
  return { path: path.replace(/\.md$/, ""), position, ...health };
}
