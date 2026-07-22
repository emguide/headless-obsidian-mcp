/**
 * Shared frontmatter condition matcher, used by `query_notes` and
 * `list_recent_notes`. A condition is either a bare scalar (equality, or
 * array-membership when the note's value is an array) or an operator object.
 * Comparisons are type-aware: numeric when both sides are numbers, chronological
 * when both parse as dates, else case-insensitive string compare.
 */

export type Condition =
  | string
  | number
  | boolean
  | {
      eq?: unknown;
      ne?: unknown;
      gt?: unknown;
      gte?: unknown;
      lt?: unknown;
      lte?: unknown;
      exists?: boolean;
      contains?: unknown;
    };

function eqLoose(a: unknown, b: unknown): boolean {
  return String(a).toLowerCase() === String(b).toLowerCase();
}

/** Membership (or, for a scalar `have`, loose equality) test used by bare scalars. */
function membership(have: unknown, want: unknown): boolean {
  if (Array.isArray(have)) return have.some((v) => eqLoose(v, want));
  return have != null && eqLoose(have, want);
}

/** Type-aware ordered compare: <0, 0, >0, or NaN when incomparable. */
function compare(have: unknown, want: unknown): number {
  const hn = typeof have === "number" ? have : Number(have);
  const wn = typeof want === "number" ? want : Number(want);
  if (!Number.isNaN(hn) && !Number.isNaN(wn) && have !== "" && want !== "") {
    return hn - wn;
  }
  const hd = Date.parse(String(have));
  const wd = Date.parse(String(want));
  if (!Number.isNaN(hd) && !Number.isNaN(wd)) return hd - wd;
  return String(have).toLowerCase().localeCompare(String(want).toLowerCase());
}

function evaluate(have: unknown, cond: Condition): boolean {
  // Bare scalar: equality / array-membership shorthand.
  if (cond === null || typeof cond !== "object") {
    return membership(have, cond);
  }
  const c = cond;
  if (c.exists !== undefined) {
    const present = have !== undefined;
    if (present !== c.exists) return false;
  }
  if (c.eq !== undefined && !membership(have, c.eq)) return false;
  if (c.ne !== undefined && membership(have, c.ne)) return false;
  if (c.contains !== undefined) {
    if (Array.isArray(have)) {
      if (!have.some((v) => eqLoose(v, c.contains))) return false;
    } else if (!String(have).toLowerCase().includes(String(c.contains).toLowerCase())) {
      return false;
    }
  }
  if (c.gt !== undefined && !(compare(have, c.gt) > 0)) return false;
  if (c.gte !== undefined && !(compare(have, c.gte) >= 0)) return false;
  if (c.lt !== undefined && !(compare(have, c.lt) < 0)) return false;
  if (c.lte !== undefined && !(compare(have, c.lte) <= 0)) return false;
  return true;
}

/**
 * Does a note's frontmatter satisfy `where`? With match="all" (default) every
 * condition must hold; with "any" at least one must.
 */
export function matchesWhere(
  frontmatter: Record<string, unknown>,
  where: Record<string, Condition>,
  match: "all" | "any" = "all"
): boolean {
  const entries = Object.entries(where);
  if (entries.length === 0) return true;
  if (match === "any") {
    return entries.some(([key, cond]) => evaluate(frontmatter[key], cond));
  }
  return entries.every(([key, cond]) => evaluate(frontmatter[key], cond));
}
