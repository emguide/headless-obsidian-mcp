import {
  NoteDocument,
  addTags,
  removeTags,
  setFrontmatter,
  addPropertyValues,
  removePropertyValues,
  renameProperty,
} from "./note-document.js";
import { getIndex } from "./vault-index.js";
import { matchesWhere } from "./property-match.js";

export type BulkOperation =
  | { op: "add_tag"; tags: string[] }
  | { op: "remove_tag"; tags: string[] }
  | { op: "set_frontmatter"; set?: Record<string, unknown>; unset?: string[] }
  | { op: "add_property_values"; key: string; values: unknown[] }
  | { op: "remove_property_values"; key: string; values: unknown[] }
  | { op: "rename_property"; from: string; to: string };

function nonEmptyArray(v: unknown): v is unknown[] {
  return Array.isArray(v) && v.length > 0;
}

/** Validate the operations array up front; throws on any bad shape. */
export function validateOperations(operations: unknown): BulkOperation[] {
  if (!nonEmptyArray(operations)) {
    throw new Error("operations must be a non-empty array");
  }
  for (const raw of operations) {
    const op = raw as { op?: string };
    if (!op || typeof op !== "object" || typeof op.op !== "string") {
      throw new Error("each operation must be an object with an `op` string");
    }
    switch (op.op) {
      case "add_tag":
      case "remove_tag":
        if (!nonEmptyArray((raw as any).tags)) throw new Error("tags must be a non-empty array");
        break;
      case "set_frontmatter":
        if (!(raw as any).set && !(raw as any).unset) {
          throw new Error("set_frontmatter requires `set` and/or `unset`");
        }
        break;
      case "add_property_values":
      case "remove_property_values":
        if (!(raw as any).key || typeof (raw as any).key !== "string") {
          throw new Error("key must be a non-empty string");
        }
        if (!nonEmptyArray((raw as any).values)) throw new Error("values must be a non-empty array");
        break;
      case "rename_property":
        if (!(raw as any).from || typeof (raw as any).from !== "string") {
          throw new Error("from must be a non-empty string");
        }
        if (!(raw as any).to || typeof (raw as any).to !== "string") {
          throw new Error("to must be a non-empty string");
        }
        break;
      default:
        throw new Error(`unknown op: ${op.op}`);
    }
  }
  return operations as BulkOperation[];
}

/** Apply every operation in order to one doc. Returns true if anything changed. */
export function applyOperations(doc: NoteDocument, operations: BulkOperation[]): boolean {
  let changed = false;
  for (const op of operations) {
    switch (op.op) {
      case "add_tag":
        if (addTags(doc, op.tags) != null) changed = true;
        break;
      case "remove_tag":
        if (removeTags(doc, op.tags) != null) changed = true;
        break;
      case "set_frontmatter":
        if (setFrontmatter(doc, op.set, op.unset)) changed = true;
        break;
      case "add_property_values":
        if (addPropertyValues(doc, op.key, op.values) != null) changed = true;
        break;
      case "remove_property_values":
        if (removePropertyValues(doc, op.key, op.values) != null) changed = true;
        break;
      case "rename_property":
        if (renameProperty(doc, op.from, op.to)) changed = true;
        break;
    }
  }
  return changed;
}

export interface BulkSelect {
  paths?: string[];
  where?: Record<string, unknown>;
  tags?: string[];
  match?: "all" | "any";
  folder?: string;
  limit?: number;
}

function canonicalName(notePath: string): string {
  return notePath.replace(/\\/g, "/").replace(/\.md$/, "");
}

export async function resolveSelection(
  vaultPath: string,
  select: BulkSelect
): Promise<string[]> {
  const hasPaths = Array.isArray(select.paths) && select.paths.length > 0;
  const hasFilter = select.where != null || (Array.isArray(select.tags) && select.tags.length > 0);
  if (hasPaths && hasFilter) {
    throw new Error("select accepts either `paths` or a filter (`where`/`tags`), not both");
  }
  if (!hasPaths && !hasFilter) {
    throw new Error("select requires `paths`, `where`, or `tags`");
  }

  if (hasPaths) {
    return select.paths!.map(canonicalName);
  }

  const match = select.match ?? "all";
  const index = await getIndex(vaultPath);
  let entries = index.getEntries();

  if (select.folder && select.folder.trim()) {
    const prefix = select.folder.replace(/[\\/]+$/, "").replace(/\\/g, "/") + "/";
    entries = entries.filter((e) => (e.path + "/").startsWith(prefix));
  }
  if (select.where != null) {
    entries = entries.filter((e) => matchesWhere(e.frontmatter, select.where as any, match));
  }
  if (Array.isArray(select.tags) && select.tags.length > 0) {
    const wanted = select.tags.map((t) => String(t).replace(/^#/, "").toLowerCase());
    entries = entries.filter((e) => {
      const noteSet = new Set(e.tags.map((t) => t.toLowerCase()));
      return match === "all" ? wanted.every((w) => noteSet.has(w)) : wanted.some((w) => noteSet.has(w));
    });
  }
  if (select.limit !== undefined) {
    if (!Number.isInteger(select.limit) || select.limit < 1) {
      throw new Error("limit must be a positive integer");
    }
    entries = entries.slice(0, select.limit);
  }
  return entries.map((e) => e.path);
}
