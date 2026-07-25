import { dayjs, formatMoment } from "./date-format.js";

export interface ExpandOptions {
  /** Value for {{title}} — the target note's basename. */
  title: string;
  /** Clock for {{date}} / {{time}}. */
  now: Date;
  /** Default format for a bare {{date}}. Default "YYYY-MM-DD". */
  dateFormat?: string;
  /** Default format for a bare {{time}}. Default "HH:mm". */
  timeFormat?: string;
}

const DEFAULT_DATE = "YYYY-MM-DD";
const DEFAULT_TIME = "HH:mm";

/**
 * Expand the core Templates-plugin placeholders in `text`:
 *   {{title}}          -> opts.title
 *   {{date}}           -> now formatted with dateFormat (default YYYY-MM-DD)
 *   {{time}}           -> now formatted with timeFormat (default HH:mm)
 *   {{date:FORMAT}}    -> now formatted with the inline Moment FORMAT
 *   {{time:FORMAT}}    -> now formatted with the inline Moment FORMAT
 *
 * Any other `{{...}}` token is passed through unchanged (report-only
 * philosophy — we never silently drop syntax we don't understand, e.g.
 * Templater's `{{tp...}}`). Dates render in the host's local timezone, matching
 * how Obsidian renders for the user.
 */
export function expand(text: string, opts: ExpandOptions): string {
  const d = dayjs(opts.now);
  const dateFmt =
    opts.dateFormat && opts.dateFormat.length ? opts.dateFormat : DEFAULT_DATE;
  const timeFmt =
    opts.timeFormat && opts.timeFormat.length ? opts.timeFormat : DEFAULT_TIME;

  return text.replace(/\{\{([^}]*)\}\}/g, (whole, inner: string) => {
    const trimmed = inner.trim();
    if (trimmed === "title") return opts.title;
    if (trimmed === "date") return formatMoment(d, dateFmt);
    if (trimmed === "time") return formatMoment(d, timeFmt);
    const m = /^(date|time)\s*:\s*(.+)$/.exec(trimmed);
    if (m) return formatMoment(d, m[2].trim());
    return whole; // unknown token -> passthrough
  });
}
