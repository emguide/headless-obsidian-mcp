import { assertVaultPath } from "./vault.js";
import { getIndex, entryToHeader } from "./vault-index.js";
import { matchesWhere } from "./property-match.js";
import {
  ListPropertiesParams,
  PropertySchemaEntry,
  PropertyValuesParamsRead,
  PropertyValueCount,
  QueryNotesParams,
  GetPropertyParams,
  NoteHeader,
} from "../types.js";

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
): Promise<PropertySchemaEntry[]> {
  assertVaultPath(vaultPath);
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

  return [...counts.entries()]
    .map(([key, count]) => ({
      key,
      count,
      types: [...(types.get(key) ?? [])].sort(),
    }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

/**
 * Faceted distinct values for one property key, with the number of notes each
 * value appears in. Array-valued properties count each element once per note.
 */
export async function getPropertyValues(
  vaultPath: string,
  params: PropertyValuesParamsRead
): Promise<{ key: string; values: PropertyValueCount[] }> {
  assertVaultPath(vaultPath);
  const { key, limit } = params;
  if (!key || typeof key !== "string") {
    throw new Error("key must be a non-empty string");
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error("limit must be a positive integer");
  }
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

  let values = [...counts.values()].sort(
    (a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value))
  );
  if (limit !== undefined) values = values.slice(0, limit);
  return { key, values };
}

/**
 * Find notes whose frontmatter satisfies a set of conditions. Returns
 * lightweight headers so results compose with the other knowledge-base tools.
 */
export async function queryNotes(
  vaultPath: string,
  params: QueryNotesParams
): Promise<NoteHeader[]> {
  assertVaultPath(vaultPath);
  const { where, match = "all", limit } = params;
  if (!where || typeof where !== "object" || Array.isArray(where)) {
    throw new Error("where must be an object of property conditions");
  }
  if (match !== "all" && match !== "any") {
    throw new Error('match must be "all" or "any"');
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error("limit must be a positive integer");
  }
  const index = await getIndex(vaultPath);
  const matched = index
    .getEntries()
    .filter((e) => matchesWhere(e.frontmatter, where, match));
  const limited = limit !== undefined ? matched.slice(0, limit) : matched;
  return limited.map(entryToHeader);
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
