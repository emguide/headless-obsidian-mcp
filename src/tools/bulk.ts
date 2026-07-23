import {
  NoteDocument,
  addTags,
  removeTags,
  setFrontmatter,
  addPropertyValues,
  removePropertyValues,
  renameProperty,
} from "./note-document.js";

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
