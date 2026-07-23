import { assertVaultPath } from "./vault.js";
import { getIndex, entryToHeader } from "./vault-index.js";
import { toListResponse, assertNonNegativeInt } from "./list-response.js";
import { resolveCandidates, validateCandidateFilter } from "./candidate-filter.js";
import {
  ListPropertiesParams,
  PropertySchemaEntry,
  PropertyValuesParamsRead,
  PropertyValueCount,
  QueryNotesParams,
  GetPropertyParams,
  NoteHeader,
  ListResponse,
} from "../types.js";

/** Default cap for this module's list-style tools so an unbounded call is still bounded. */
const DEFAULT_LIMIT = 100;

/** Canonical vault name for a note path (forward slashes, no .md suffix). */
function canonicalName(notePath: string): string {
  return notePath.replace(/\\/g, "/").replace(/\.md$/, "");
}

/** Classify a frontmatter value into a coarse type label. */
function typeOf(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "array";
  if (value instanceof Date) return "date";
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return t;
  return "object";
}

/**
 * The vault's frontmatter schema: every property key with the number of notes
 * using it and the distinct value types observed. Mirrors list_tags. Derived
 * from the shared index — no extra file reads.
 */
export async function listProperties(
  vaultPath: string,
  params: ListPropertiesParams = {}
): Promise<ListResponse<PropertySchemaEntry>> {
  assertVaultPath(vaultPath);
  assertNonNegativeInt(params.offset, "offset");
  const includeTags = params.include_tags !== false;
  const index = await getIndex(vaultPath);

  const counts = new Map<string, number>();
  const types = new Map<string, Set<string>>();
  for (const entry of index.getEntries()) {
    for (const [key, value] of Object.entries(entry.frontmatter)) {
      if (!includeTags && key === "tags") continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      const set = types.get(key) ?? new Set<string>();
      set.add(typeOf(value));
      types.set(key, set);
    }
  }

  const props = [...counts.entries()]
    .map(([key, count]) => ({
      key,
      count,
      types: [...(types.get(key) ?? [])].sort(),
    }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  return toListResponse(props, undefined, params.offset ?? 0);
}

/**
 * Faceted distinct values for one property key, with the number of notes each
 * value appears in. Array-valued properties count each element once per note.
 */
export async function getPropertyValues(
  vaultPath: string,
  params: PropertyValuesParamsRead
): Promise<{ key: string } & ListResponse<PropertyValueCount>> {
  assertVaultPath(vaultPath);
  const { key, limit, offset } = params;
  if (!key || typeof key !== "string") {
    throw new Error("key must be a non-empty string");
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
    throw new Error("limit must be a positive integer");
  }
  assertNonNegativeInt(offset, "offset");
  const index = await getIndex(vaultPath);

  // Count by stringified value so distinct object identities collapse sensibly.
  const counts = new Map<string, { value: unknown; count: number }>();
  for (const entry of index.getEntries()) {
    const raw = entry.frontmatter[key];
    if (raw === undefined) continue;
    const items = Array.isArray(raw) ? raw : [raw];
    for (const item of new Set(items)) {
      const k = String(item);
      const slot = counts.get(k) ?? { value: item, count: 0 };
      slot.count += 1;
      counts.set(k, slot);
    }
  }

  const values = [...counts.values()].sort(
    (a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value))
  );
  const effectiveLimit = limit === undefined ? DEFAULT_LIMIT : limit;
  return { key, ...toListResponse(values, effectiveLimit === 0 ? undefined : effectiveLimit, offset) };
}

/**
 * Find notes whose frontmatter satisfies a set of conditions. `match` governs
 * how the `where` conditions combine ("all" default). Optionally narrow further
 * with `folder` and `tags` (any of them) — the shared candidate-filter
 * vocabulary — so a frontmatter query can be scoped to a folder or tag set
 * without a client-side join. Returns lightweight headers so results compose
 * with the other knowledge-base tools.
 */
export async function queryNotes(
  vaultPath: string,
  params: QueryNotesParams
): Promise<ListResponse<NoteHeader>> {
  assertVaultPath(vaultPath);
  const { where, match = "all", folder, tags, limit, offset } = params;
  if (!where || typeof where !== "object" || Array.isArray(where)) {
    throw new Error("where must be an object of property conditions");
  }
  if (match !== "all" && match !== "any") {
    throw new Error('match must be "all" or "any"');
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
    throw new Error("limit must be a positive integer");
  }
  assertNonNegativeInt(offset, "offset");
  validateCandidateFilter({ tags });
  const index = await getIndex(vaultPath);
  // `match` governs the `where` conditions (query_notes' primary filter); the
  // optional `tags` narrowing is an independent "any" membership constraint.
  const matched = resolveCandidates(index, {
    folder,
    tags,
    where,
    tagMatch: "any",
    whereMatch: match,
  });
  const effectiveLimit = limit === undefined ? DEFAULT_LIMIT : limit;
  return toListResponse(matched.map(entryToHeader), effectiveLimit === 0 ? undefined : effectiveLimit, offset);
}

/**
 * Read a single frontmatter property from one note. `present` distinguishes an
 * absent key from a key explicitly set to null.
 */
export async function getProperty(
  vaultPath: string,
  params: GetPropertyParams
): Promise<{ path: string; key: string; value: unknown; present: boolean }> {
  assertVaultPath(vaultPath);
  const { path, key } = params;
  if (!path || typeof path !== "string") throw new Error("A note path is required");
  if (!key || typeof key !== "string") throw new Error("key must be a non-empty string");
  const index = await getIndex(vaultPath);
  const canonical = canonicalName(path);
  const resolved = index.resolve(canonical) ?? canonical;
  const entry = index.getEntry(resolved);
  if (!entry) throw new Error(`Note not found: ${canonical}`);
  const present = key in entry.frontmatter;
  return {
    path: entry.path,
    key,
    value: present ? entry.frontmatter[key] : undefined,
    present,
  };
}
