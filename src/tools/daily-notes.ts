import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import dayjs from "dayjs";
import advancedFormat from "dayjs/plugin/advancedFormat.js";
import customParseFormat from "dayjs/plugin/customParseFormat.js";
import { assertVaultPath, resolveNotePath } from "./vault.js";

dayjs.extend(advancedFormat);
dayjs.extend(customParseFormat);

/** Env override for the daily-notes folder; wins over `.obsidian/daily-notes.json`. */
export const DAILY_FOLDER_ENV = "OBSIDIAN_DAILY_FOLDER";

/** Obsidian's built-in default filename format for daily notes. */
export const DEFAULT_DAILY_FORMAT = "YYYY-MM-DD";

export interface DailyNotesConfig {
  /** Vault-relative daily-notes folder; "" means the vault root. */
  folder: string;
  /** Moment-compatible filename format (may contain `/` for nested folders). */
  format: string;
  /** Vault-relative template note path (no .md), or null when unset. */
  template: string | null;
}

/**
 * Resolve the Daily Notes core plugin's configuration, config-first: read
 * `.obsidian/daily-notes.json` (missing keys take Obsidian's own defaults —
 * vault root, YYYY-MM-DD, no template), then let `OBSIDIAN_DAILY_FOLDER`
 * override the folder for headless setups. If neither the config file nor the
 * env var exists, throw: with no evidence the plugin is in use, guessing
 * root/YYYY-MM-DD would silently resolve wrong paths.
 */
export async function resolveDailyConfig(
  vaultPath: string
): Promise<DailyNotesConfig> {
  let cfg: DailyNotesConfig | null = null;
  try {
    const raw = await readFile(
      join(vaultPath, ".obsidian", "daily-notes.json"),
      "utf-8"
    );
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      cfg = {
        folder:
          typeof parsed.folder === "string" && parsed.folder.length
            ? parsed.folder.replace(/\/+$/, "")
            : "",
        format:
          typeof parsed.format === "string" && parsed.format.length
            ? parsed.format
            : DEFAULT_DAILY_FORMAT,
        template:
          typeof parsed.template === "string" && parsed.template.length
            ? parsed.template.replace(/\.md$/, "")
            : null,
      };
    }
  } catch {
    /* no/invalid config file — fall through to the env override */
  }

  const envFolder = process.env[DAILY_FOLDER_ENV];
  if (envFolder && envFolder.trim().length) {
    return {
      folder: envFolder.trim().replace(/\/+$/, ""),
      format: cfg?.format ?? DEFAULT_DAILY_FORMAT,
      template: cfg?.template ?? null,
    };
  }
  if (cfg) return cfg;
  throw new Error(
    `No daily-notes configuration found. Enable the Daily notes core plugin ` +
      `(creates .obsidian/daily-notes.json), or set ${DAILY_FOLDER_ENV}.`
  );
}

export interface DailyNoteResult {
  /** The resolved calendar date, ISO YYYY-MM-DD. */
  date: string;
  /** Canonical vault-relative note path, no .md. */
  path: string;
  /** Whether that note currently exists on disk. */
  exists: boolean;
  /** The configured daily-note template (vault-relative, no .md), or null. */
  template: string | null;
}

const DATE_FORMS_HINT =
  'Accepted date forms: "YYYY-MM-DD", "today" (default), "yesterday", "tomorrow".';

/** Parse the `date` param against the injected clock. Fail-loud on anything else. */
function parseDate(date: string | undefined, now: Date): dayjs.Dayjs {
  const d = dayjs(now);
  if (date === undefined) return d;
  if (typeof date !== "string" || !date.trim()) {
    throw new Error(`A date must be a non-empty string. ${DATE_FORMS_HINT}`);
  }
  const keyword = date.trim().toLowerCase();
  if (keyword === "today") return d;
  if (keyword === "yesterday") return d.subtract(1, "day");
  if (keyword === "tomorrow") return d.add(1, "day");
  const parsed = dayjs(date.trim(), "YYYY-MM-DD", true);
  if (!parsed.isValid()) {
    throw new Error(`Unrecognized date: ${JSON.stringify(date)}. ${DATE_FORMS_HINT}`);
  }
  return parsed;
}

/**
 * Map a calendar date to its canonical daily-note path — folder + the date
 * rendered with the plugin's Moment format (slashes in the format nest
 * folders, as in Obsidian). The result is traversal-guarded like every other
 * note path; `exists` is a fresh stat, so a just-created note shows up
 * immediately. `now` is injectable for tests.
 */
export async function resolveDailyNote(
  vaultPath: string,
  params: { date?: string },
  now: Date = new Date()
): Promise<DailyNoteResult> {
  assertVaultPath(vaultPath);
  const cfg = await resolveDailyConfig(vaultPath);
  const day = parseDate(params.date, now);
  const rendered = day.format(cfg.format);
  const path = cfg.folder ? `${cfg.folder}/${rendered}` : rendered;
  const fullPath = resolveNotePath(vaultPath, path);

  let exists = false;
  try {
    exists = (await stat(fullPath)).isFile();
  } catch {
    /* missing note — exists stays false */
  }

  return {
    date: day.format("YYYY-MM-DD"),
    path,
    exists,
    template: cfg.template,
  };
}
