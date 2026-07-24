import { assertVaultPath, headingPaths } from "./vault.js";
import { getIndex, IndexEntry } from "./vault-index.js";
import { TASK_STATUSES } from "./vault.js";
import { ListTasksParams, ListResponse, TaskRow } from "../types.js";
import { toListResponse, assertNonNegativeInt } from "./list-response.js";
import { resolveCandidates, validateCandidateFilter } from "./candidate-filter.js";

/** Default cap so the first orientation call is bounded, matching list_notes. */
const DEFAULT_LIMIT = 100;

/**
 * List checkbox tasks across the vault as structured rows (path, text, named
 * status, raw marker, 1-based line, enclosing heading-path). Index-backed: no
 * per-call file reads. Scope with the shared folder/tags/where/match filters
 * plus an optional `status` set, so "open tasks in projects/ tagged #work" is a
 * single call. Returns the standard ListResponse window.
 */
export async function listTasks(
  vaultPath: string,
  params: ListTasksParams = {}
): Promise<ListResponse<TaskRow>> {
  assertVaultPath(vaultPath);

  const { folder, tags, match, where, status, limit, offset } = params;

  if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
    throw new Error("limit must be a positive integer");
  }
  assertNonNegativeInt(offset, "offset");
  validateCandidateFilter({ tags, where, match });

  if (status !== undefined) {
    if (!Array.isArray(status) || status.length === 0) {
      throw new Error("status must be a non-empty array when provided");
    }
    for (const s of status) {
      if (!TASK_STATUSES.includes(s)) {
        throw new Error(
          `status contains an invalid value "${s}"; valid: ${TASK_STATUSES.join(", ")}`
        );
      }
    }
  }
  const statusSet = status ? new Set(status) : undefined;

  const index = await getIndex(vaultPath);
  const entries = resolveCandidates(index, {
    folder,
    tags,
    where,
    tagMatch: match ?? "any",
    whereMatch: "all",
  });

  const rows: TaskRow[] = [];
  for (const entry of entries) {
    for (const task of entryTaskRows(entry)) {
      if (statusSet && !statusSet.has(task.status)) continue;
      rows.push(task);
    }
  }

  const effectiveLimit = limit === undefined ? DEFAULT_LIMIT : limit;
  return toListResponse(rows, effectiveLimit === 0 ? undefined : effectiveLimit, offset);
}

/** Project one note's cached tasks into TaskRows, attaching heading-path context. */
function entryTaskRows(entry: IndexEntry): TaskRow[] {
  const paths = headingPaths(entry.headings);
  return entry.tasks.map((task) => ({
    path: entry.path,
    text: task.text,
    status: task.status,
    marker: task.marker,
    line: task.line + 1, // index tasks are 0-based; expose 1-based (body-relative, like get_outline)
    section: sectionForLine(entry, paths, task.line),
  }));
}

/**
 * The " > "-joined heading-path of the nearest heading at or before `line`,
 * or null when the task sits above every heading. Headings are in document
 * order, so the last heading whose line <= the task's line wins.
 */
function sectionForLine(
  entry: IndexEntry,
  paths: string[],
  line: number
): string | null {
  let result: string | null = null;
  for (let i = 0; i < entry.headings.length; i++) {
    if (entry.headings[i].line <= line) result = paths[i];
    else break;
  }
  return result;
}
