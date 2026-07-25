/**
 * The one date engine, shared by template placeholders (`{{date:FORMAT}}`) and
 * daily-note filename formats.
 *
 * Both surfaces promise Moment.js-compatible tokens, because that is what
 * Obsidian itself uses — a format that renders in Obsidian must render here.
 * Plain dayjs falls short in two ways, so both are handled centrally rather
 * than in each caller:
 *
 * - Week tokens (`ww`, `gggg`, `WW`, `GGGG`) throw `t.weekYear is not a
 *   function` without the weekOfYear/weekYear/isoWeek plugins. A weekly-note
 *   format like `gggg-[W]ww` is a common Obsidian setup, so this crashed
 *   apply_template, insert_template, and resolve_daily_note outright.
 * - Day-of-year (`DDD`/`DDDD`) has no dayjs format token at all: dayjs renders
 *   `DDD` by concatenating three `D`s, so 2026-07-25 came out as "2525"
 *   instead of Moment's "206" — silently writing wrong text into notes.
 */

import dayjs, { Dayjs } from "dayjs";
import advancedFormat from "dayjs/plugin/advancedFormat.js";
import customParseFormat from "dayjs/plugin/customParseFormat.js";
import weekOfYear from "dayjs/plugin/weekOfYear.js";
import weekYear from "dayjs/plugin/weekYear.js";
import dayOfYear from "dayjs/plugin/dayOfYear.js";
import isoWeek from "dayjs/plugin/isoWeek.js";
import localeData from "dayjs/plugin/localeData.js";

dayjs.extend(advancedFormat);
dayjs.extend(customParseFormat);
dayjs.extend(weekOfYear);
dayjs.extend(weekYear);
dayjs.extend(dayOfYear);
dayjs.extend(isoWeek);
dayjs.extend(localeData);

export { dayjs };
export type { Dayjs };

/**
 * Apply `fn` to the parts of a Moment format string that are outside `[...]`
 * escapes, so literal text is never rewritten. `[W]` must stay a literal W.
 */
function mapUnescaped(fmt: string, fn: (chunk: string) => string): string {
  let out = "";
  let i = 0;
  while (i < fmt.length) {
    if (fmt[i] === "[") {
      const end = fmt.indexOf("]", i);
      if (end === -1) {
        out += fmt.slice(i); // unterminated escape: pass through verbatim
        break;
      }
      out += fmt.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    const next = fmt.indexOf("[", i);
    const chunk = next === -1 ? fmt.slice(i) : fmt.slice(i, next);
    out += fn(chunk);
    i = next === -1 ? fmt.length : next;
  }
  return out;
}

/**
 * Format `d` with a Moment-compatible format string.
 *
 * Day-of-year tokens are substituted before dayjs sees the format; the
 * resulting digits are inert to dayjs (no digit is a format token), so they
 * pass through unchanged.
 */
export function formatMoment(d: Dayjs, fmt: string): string {
  const substituted = mapUnescaped(fmt, (chunk) =>
    // DDDD before DDD so the longer token wins; DD and D are left to dayjs.
    chunk.replace(/DDDD|DDD/g, (token) => {
      const doy = d.dayOfYear();
      return token === "DDDD" ? String(doy).padStart(3, "0") : String(doy);
    })
  );
  return d.format(substituted);
}
