import { resolveTemplateConfig } from "./templates.js";
import { gitGuardEnabled } from "./env-flags.js";
import { GATED_TOOL_NAMES, resolveToolPolicy } from "./tool-policy.js";
import { isWriteTool } from "./write.js";

/** Obsidian's built-in defaults for a bare {{date}} / {{time}}. */
const DEFAULT_DATE_FORMAT = "YYYY-MM-DD";
const DEFAULT_TIME_FORMAT = "HH:mm";

export interface ServerConfig {
  template: {
    /** Resolved template folder, or null when none is configured. */
    folder: string | null;
    /** Effective format for a bare {{date}} (never undefined). */
    date_format: string;
    /** Effective format for a bare {{time}} (never undefined). */
    time_format: string;
  };
  writes: {
    writes_enabled: boolean;
    git_autocommit: boolean;
  };
  vault: {
    path: string;
  };
  tools: {
    /** Raw OBSIDIAN_TOOLS value, or null when unset (default policy in force). */
    policy: string | null;
    /** Exposed tool names, sorted (always includes get_config). */
    exposed: string[];
    /** Gated tool names the policy hides, sorted. */
    excluded: string[];
  };
}

export type ConfigSection = keyof ServerConfig;

const SECTIONS: ConfigSection[] = ["template", "writes", "vault", "tools"];

/**
 * Assemble the server's own configuration. Unlike the template tools, an
 * unconfigured template folder is reported as folder: null rather than thrown —
 * "no template folder is configured" is a valid answer here.
 */
export async function resolveServerConfig(
  vaultPath: string
): Promise<ServerConfig> {
  let folder: string | null = null;
  let dateFormat = DEFAULT_DATE_FORMAT;
  let timeFormat = DEFAULT_TIME_FORMAT;
  try {
    const cfg = await resolveTemplateConfig(vaultPath);
    folder = cfg.folder;
    if (cfg.dateFormat) dateFormat = cfg.dateFormat;
    if (cfg.timeFormat) timeFormat = cfg.timeFormat;
  } catch {
    /* no template folder configured — folder stays null, formats stay default */
  }

  const { policy, exposed } = resolveToolPolicy();

  return {
    template: { folder, date_format: dateFormat, time_format: timeFormat },
    writes: {
      writes_enabled: [...exposed].some((name) => isWriteTool(name)),
      git_autocommit: gitGuardEnabled(),
    },
    vault: { path: vaultPath },
    tools: {
      policy,
      exposed: [...exposed].sort(),
      excluded: [...GATED_TOOL_NAMES].filter((name) => !exposed.has(name)).sort(),
    },
  };
}

/**
 * Return the whole config, or a single unwrapped section. An unknown section
 * name throws, listing the valid sections (fail-loud).
 */
export function selectConfigSection(
  config: ServerConfig,
  section?: string
): ServerConfig | ServerConfig[ConfigSection] {
  if (section === undefined) return config;
  if ((SECTIONS as string[]).includes(section)) {
    return config[section as ConfigSection];
  }
  throw new Error(
    `Unknown config section: ${JSON.stringify(section)}. Valid sections: ${SECTIONS.join(", ")}.`
  );
}
