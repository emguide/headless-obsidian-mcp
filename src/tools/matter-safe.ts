/**
 * Safe frontmatter parsing — the single gray-matter entry point.
 *
 * gray-matter ships an `eval()`-based `javascript` engine that is selected by a
 * language tag on the opening fence (`---js`). Because the vault index parses
 * every note on each refresh, and nearly every tool call refreshes the index, a
 * single note beginning with `---js` would execute arbitrary code as the server
 * user on the next tool call. Notes are untrusted input: they arrive from shared
 * vaults, from Obsidian Sync, and from `git pull` under `OBSIDIAN_GIT_SYNC`.
 *
 * Two layers keep that shut:
 *
 * 1. A non-YAML language tag is never handed to gray-matter at all — the block
 *    is treated as ordinary body text. This also aligns the read side with
 *    `NoteDocument.parse`, whose FENCE regex requires a bare `---` and so has
 *    always treated `---js` as body; previously readers and writers disagreed
 *    about whether such a block was frontmatter.
 * 2. Only the YAML engine is registered, so no other engine can be reached even
 *    if the language check above is ever bypassed.
 *
 * Every `matter()` call in the codebase goes through `parseMatter`, and every
 * `matter.stringify` through `stringifyMatter`, so the hardening cannot be lost
 * by adding a new call site that forgets the options object.
 */

import matter from "gray-matter";

/**
 * The opening fence and its optional language tag. A leading BOM is tolerated
 * because gray-matter strips one before parsing, so the tag must be read from
 * the same position gray-matter would read it from.
 */
const OPEN_FENCE = /^\uFEFF?---([^\r\n]*)\r?\n/;

/** Language tags that mean "YAML frontmatter". Empty = gray-matter's default. */
const YAML_LANGUAGES = new Set(["", "yaml", "yml"]);

/**
 * Engine allow-list. Restricting the map to YAML means any other language tag
 * raises gray-matter's "engine is not registered" error rather than selecting
 * an executable engine — defense in depth behind the language check.
 */
// gray-matter's bundled type definitions omit the `engines` registry, so reach
// it through a narrow cast rather than re-implementing its YAML engine here
// (which would risk drifting from the loader gray-matter itself uses).
const yamlEngine = (matter as unknown as { engines: Record<string, unknown> })
  .engines.yaml;

const SAFE_ENGINES = {
  yaml: yamlEngine,
  yml: yamlEngine,
} as NonNullable<matter.GrayMatterOption<string, never>["engines"]>;

export interface ParsedMatter {
  /** Parsed frontmatter, or `{}` when the note has none. */
  data: Record<string, unknown>;
  /**
   * The body with the frontmatter block removed. Always a suffix of the input,
   * which is the invariant the index's `bodyBegin` math and `set_task_state`'s
   * byte-preserving reattach both rely on.
   */
  content: string;
}

/**
 * Language tag on the note's opening fence: `""` for a bare `---`, `null` when
 * the note has no opening fence at all.
 */
export function frontmatterLanguage(raw: string): string | null {
  const match = OPEN_FENCE.exec(raw);
  if (!match) return null;
  return match[1].trim().toLowerCase();
}

/**
 * Parse a note's frontmatter. A block tagged with a non-YAML language is left
 * as body text rather than executed or interpreted.
 */
export function parseMatter(raw: string): ParsedMatter {
  const language = frontmatterLanguage(raw);
  if (language !== null && !YAML_LANGUAGES.has(language)) {
    // Not YAML — never hand it to an engine. Treat the whole note as body.
    return { data: {}, content: raw };
  }
  const parsed = matter(raw, { engines: SAFE_ENGINES, language: "yaml" });
  return {
    data: (parsed.data ?? {}) as Record<string, unknown>,
    content: parsed.content,
  };
}

/**
 * A `Date` that carries no time of day — i.e. what an unquoted `created:
 * 2026-07-25` in frontmatter parses to. js-yaml would dump it back as a full
 * ISO timestamp, silently rewriting a key the write never addressed.
 */
function isDateOnly(value: unknown): value is Date {
  return (
    value instanceof Date &&
    !Number.isNaN(value.getTime()) &&
    value.toISOString().endsWith("T00:00:00.000Z")
  );
}

/**
 * Placeholder marker for a date-only value during serialization. js-yaml 3
 * gives no usable hook for overriding how it represents `Date` (its built-in
 * timestamp type wins over a same-tag custom type, and forcing the issue
 * disturbs unrelated keys), so the value is dumped as a plain scalar token and
 * restored afterwards. The token holds only characters YAML emits unquoted.
 */
const DATE_TOKEN_PREFIX = "__obsidian_mcp_date_";

/**
 * Placeholder for a top-level empty-string value, restored to a bare `key:`.
 *
 * js-yaml dumps `""` as `key: ''`, but Obsidian's own property editor writes an
 * empty property as a bare `key:` — so every note this server created carried a
 * quoting artifact no Obsidian-authored note has, which agents were hand-patching
 * away after each write. Both forms render identically in Obsidian (`''` is an
 * empty text property, a bare key is null), so the difference is cosmetic in
 * effect but persistent in the file.
 *
 * The round-trip consequence is deliberate and accepted: reading a bare `key:`
 * back yields `null`, not `""`, so a pre-existing `key: ''` on disk becomes null
 * the next time any frontmatter write re-serializes that note. Unlike the
 * date-only case above — where a silent rewrite turned `2026-07-25` into a full
 * ISO timestamp, visibly changing the value — an empty string and null present
 * the same empty property to the user.
 *
 * Array elements are left alone: a bare `-` in a list means null, and an empty
 * list entry is not the case this addresses.
 */
const EMPTY_TOKEN = "__obsidian_mcp_empty__";

/** Shared prefix of both placeholders, for one collision check. */
const TOKEN_PREFIX = "__obsidian_mcp_";

/**
 * Serialize a body plus frontmatter data back to note text (YAML only).
 *
 * Date-only values round-trip in their original `YYYY-MM-DD` form rather than
 * being expanded to `2026-07-25T00:00:00.000Z`. Dates that do carry a time are
 * dumped as full ISO timestamps, which is already lossless.
 */
export function stringifyMatter(
  body: string,
  data: Record<string, unknown>
): string {
  const dates: string[] = [];

  // If the token prefix somehow occurs in the real content, restoring it would
  // corrupt that text — fall back to plain serialization instead.
  const collides =
    body.includes(TOKEN_PREFIX) || JSON.stringify(data).includes(TOKEN_PREFIX);

  const encode = (value: unknown): unknown => {
    if (!collides && isDateOnly(value)) {
      const index = dates.length;
      dates.push(value.toISOString().slice(0, 10));
      return `${DATE_TOKEN_PREFIX}${index}__`;
    }
    return value;
  };

  let emptied = false;
  const prepared: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value)) {
      prepared[key] = value.map(encode);
      continue;
    }
    if (!collides && value === "") {
      emptied = true;
      prepared[key] = EMPTY_TOKEN;
      continue;
    }
    prepared[key] = encode(value);
  }

  let out = matter.stringify(body, prepared, {
    engines: SAFE_ENGINES,
    language: "yaml",
  });

  if (emptied) {
    // Consume the separating space too, so the line is `key:` rather than
    // `key: ` — the trailing whitespace parses identically but reads as a diff
    // artifact. The token is unique (guarded by `collides`), so a global
    // replace cannot reach real content.
    out = out.replace(new RegExp(`:[ \\t]*'?"?${EMPTY_TOKEN}"?'?`, "g"), ":");
  }

  if (dates.length > 0) {
    // Drop any quoting js-yaml added, so the restored date stays a YAML date.
    out = out.replace(
      new RegExp(`'?"?${DATE_TOKEN_PREFIX}(\\d+)__"?'?`, "g"),
      (whole, index: string) => dates[Number(index)] ?? whole
    );
  }
  return out;
}
