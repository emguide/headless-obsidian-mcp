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
import { canonicalName } from "./vault.js";
import { Condition } from "./property-match.js";
import { resolveCandidates } from "./candidate-filter.js";
import { assertNonNegativeInt } from "./list-response.js";
import {
  readRaw,
  writeResolved,
  assertSyncableBeforeWrite,
  afterWrite,
} from "./write.js";

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
      case "set_frontmatter": {
        const s = (raw as any).set;
        const u = (raw as any).unset;
        const hasSet = s != null && typeof s === "object" && !Array.isArray(s) && Object.keys(s).length > 0;
        const hasUnset = Array.isArray(u) && u.length > 0;
        if (!hasSet && !hasUnset) {
          throw new Error("set_frontmatter requires a non-empty `set` object and/or non-empty `unset` array");
        }
        break;
      }
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
  where?: Record<string, Condition>;
  tags?: string[];
  match?: "all" | "any";
  folder?: string;
  limit?: number;
}

export async function resolveSelection(
  vaultPath: string,
  select: BulkSelect
): Promise<string[]> {
  if (select.where != null && (typeof select.where !== "object" || Array.isArray(select.where))) {
    throw new Error("select.where must be an object of frontmatter conditions");
  }
  if (Array.isArray(select.paths) && select.paths.length === 0 && select.where == null && !(Array.isArray(select.tags) && select.tags.length > 0)) {
    throw new Error("select.paths is empty; provide at least one path or use a filter (`where`/`tags`)");
  }

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
  let entries = resolveCandidates(index, {
    folder: select.folder,
    where: select.where,
    tags: Array.isArray(select.tags) && select.tags.length > 0 ? select.tags : undefined,
    tagMatch: match,   // bulk: match governs both tags...
    whereMatch: match, // ...and where
  });
  // `limit: 0` is the vault-wide sentinel for "unbounded"; any other negative
  // or non-integer value is rejected.
  assertNonNegativeInt(select.limit, "limit");
  if (select.limit !== undefined && select.limit > 0) {
    entries = entries.slice(0, select.limit);
  }
  return entries.map((e) => e.path);
}

export interface BulkEditParams {
  select: BulkSelect;
  operations: BulkOperation[];
  dry_run?: boolean;
  expected_count?: number;
}

export interface BulkNoteResult {
  path: string;
  ok: boolean;
  changed?: boolean;
  error?: string;
}

export interface BulkEditResult {
  dry_run: boolean;
  matched_count: number;
  applied_count?: number;
  failed_count?: number;
  matched?: string[];
  operations?: BulkOperation[];
  results?: BulkNoteResult[];
}

/**
 * Batch orchestrator: validate + resolve the selection, take exactly one git
 * snapshot for the whole batch (real runs only), then apply the operations
 * note-by-note with per-note error isolation so one bad note never aborts the
 * rest of the batch.
 */
export async function bulkEdit(
  vaultPath: string,
  params: BulkEditParams
): Promise<BulkEditResult> {
  const operations = validateOperations(params.operations);
  const matched = await resolveSelection(vaultPath, params.select ?? {});

  if (params.expected_count !== undefined && params.expected_count !== matched.length) {
    throw new Error(
      `expected_count ${params.expected_count} but ${matched.length} notes matched`
    );
  }

  if (params.dry_run) {
    return {
      dry_run: true,
      matched_count: matched.length,
      matched,
      operations,
    };
  }

  await assertSyncableBeforeWrite(vaultPath);

  const results: BulkNoteResult[] = [];
  for (const notePath of matched) {
    try {
      // Read through the shared funnel helper so a missing note in the batch
      // reports the polished "Note not found: x. Did you mean…?" message every
      // other write path uses, instead of leaking a raw ENOENT with an absolute
      // filesystem path.
      const raw = await readRaw(vaultPath, notePath);
      const doc = NoteDocument.parse(raw);
      const changed = applyOperations(doc, operations);
      if (changed) await writeResolved(vaultPath, notePath, doc.serialize());
      results.push({ path: notePath, ok: true, changed });
    } catch (error) {
      results.push({
        path: notePath,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const appliedCount = results.filter((r) => r.ok).length;
  await afterWrite(vaultPath, `bulk_edit: ${appliedCount} notes`);

  return {
    dry_run: false,
    matched_count: matched.length,
    applied_count: appliedCount,
    failed_count: results.filter((r) => !r.ok).length,
    results,
  };
}
