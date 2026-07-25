import process from "node:process";
import { isWriteTool } from "./write.js";
import { TOOLS_ENV } from "./env-flags.js";

/** Retired master write switch. Setting it at all is a startup error. */
export const RETIRED_ALLOW_WRITES_ENV = "OBSIDIAN_ALLOW_WRITES";

/** Policy applied when OBSIDIAN_TOOLS is unset: the read-only surface. */
export const DEFAULT_POLICY = "reads";

/** The always-exposed, groupless introspection tool. */
const ALWAYS_EXPOSED = "get_config";

/**
 * The domain taxonomy: every gated tool belongs to exactly one group. Modes
 * (read|write) are not stored here — they derive from isWriteTool, so write
 * classification keeps its single source of truth in write.ts.
 */
const GROUP_MEMBERS: Readonly<Record<string, readonly string[]>> = {
  search: ["search_notes", "search_notes_ranked"],
  notes: [
    "read_notes", "list_notes", "list_recent_notes", "resolve_note", "resolve_daily_note",
    "write_note", "append_note", "prepend_note", "patch_note", "delete_note", "move_note",
  ],
  sections: [
    "get_outline", "read_section",
    "add_section", "append_to_section", "replace_section", "rename_section",
  ],
  links: ["get_links", "get_related_notes"],
  tags: ["list_tags", "find_by_tag", "add_tag", "remove_tag"],
  properties: [
    "get_frontmatter", "list_properties", "list_property_values", "query_notes", "get_property",
    "set_frontmatter", "add_property_values", "remove_property_values", "rename_property",
  ],
  tasks: ["list_tasks", "set_task_state"],
  templates: ["list_templates", "apply_template", "insert_template"],
  files: [
    "list_files", "list_folders",
    "move_file", "create_folder", "move_folder", "delete_folder",
  ],
  vault: ["get_vault_stats", "list_vault_issues"],
  bulk: ["bulk_edit"],
};

export const GROUP_NAMES: readonly string[] = Object.keys(GROUP_MEMBERS);

/** Every gated tool name (get_config is not gated and not listed). */
export const GATED_TOOL_NAMES: ReadonlySet<string> = new Set(
  Object.values(GROUP_MEMBERS).flat()
);

export interface ToolPolicy {
  /** Raw OBSIDIAN_TOOLS value, or null when unset (default policy in force). */
  policy: string | null;
  /** Tool names the server exposes; always contains get_config. */
  exposed: ReadonlySet<string>;
}

/** Expand one (already-lowercased, un-negated) token, or null if unknown. */
function expandToken(token: string): Set<string> | null {
  if (token === "all") return new Set(GATED_TOOL_NAMES);
  if (token === "reads" || token === "writes") {
    const wantWrite = token === "writes";
    return new Set([...GATED_TOOL_NAMES].filter((n) => isWriteTool(n) === wantWrite));
  }
  const dot = token.indexOf(".");
  if (dot !== -1) {
    const members = GROUP_MEMBERS[token.slice(0, dot)];
    const mode = token.slice(dot + 1);
    if (!members || (mode !== "read" && mode !== "write")) return null;
    return new Set(members.filter((n) => isWriteTool(n) === (mode === "write")));
  }
  const members = GROUP_MEMBERS[token];
  if (members) return new Set(members);
  if (GATED_TOOL_NAMES.has(token) || token === ALWAYS_EXPOSED) return new Set([token]);
  return null;
}

function vocabularyHint(): string {
  return (
    `Valid selectors: all, reads, writes; groups: ${GROUP_NAMES.join(", ")} ` +
    `(optionally suffixed .read or .write); or an individual tool name. ` +
    `Prefix any selector with '-' to exclude it.`
  );
}

/**
 * Evaluate a raw OBSIDIAN_TOOLS policy (null = unset -> DEFAULT_POLICY) to
 * the set of exposed tool names. Left to right; '-' subtracts; when the FIRST
 * token subtracts, evaluation starts from the default policy (reads) so that
 * trimming a group can never silently expose the write tools. get_config is
 * always added. Throws on unknown tokens and on policies selecting no tools.
 */
export function evaluatePolicy(raw: string | null): ReadonlySet<string> {
  const source = raw ?? DEFAULT_POLICY;
  const tokens = source
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) {
    throw new Error(
      `${TOOLS_ENV} is set but selects no tools. Unset it for the default ` +
        `("${DEFAULT_POLICY}"), or provide selectors. ${vocabularyHint()}`
    );
  }
  const exposed: Set<string> = tokens[0].startsWith("-")
    ? new Set(expandToken(DEFAULT_POLICY)!)
    : new Set();
  for (const token of tokens) {
    const negate = token.startsWith("-");
    const bare = negate ? token.slice(1).trim() : token;
    const expansion = expandToken(bare);
    if (expansion === null) {
      throw new Error(
        `Unknown ${TOOLS_ENV} selector: ${JSON.stringify(token)}. ${vocabularyHint()}`
      );
    }
    for (const name of expansion) {
      if (negate) exposed.delete(name);
      else exposed.add(name);
    }
  }
  exposed.add(ALWAYS_EXPOSED);
  if (exposed.size === 1) {
    // Only the always-on get_config survived: the policy gates away every tool.
    throw new Error(
      `${TOOLS_ENV} policy ${JSON.stringify(source)} selects no tools ` +
        `(get_config alone is always exposed and does not count). ${vocabularyHint()}`
    );
  }
  return exposed;
}

/**
 * Resolve the effective tool policy from the environment. Fail-loud on the
 * retired OBSIDIAN_ALLOW_WRITES switch: a config that sets it expects the old
 * gating semantics, and silently running read-only (or ignoring it) would be
 * exactly the drift this module exists to prevent.
 */
export function resolveToolPolicy(env: NodeJS.ProcessEnv = process.env): ToolPolicy {
  if (env[RETIRED_ALLOW_WRITES_ENV] !== undefined) {
    throw new Error(
      `${RETIRED_ALLOW_WRITES_ENV} has been replaced by ${TOOLS_ENV}. Unset it; ` +
        `use ${TOOLS_ENV}=all to expose every tool, or see the docs for the selector grammar.`
    );
  }
  const raw = env[TOOLS_ENV];
  const policy = raw === undefined ? null : raw;
  return { policy, exposed: evaluatePolicy(policy) };
}
