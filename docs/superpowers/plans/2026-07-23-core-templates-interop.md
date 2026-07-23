# Core Templates Interop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an agent discover, apply, and insert the vault's existing core Templates-plugin templates, reproducing Obsidian's `{{title}}`/`{{date}}`/`{{time}}` substitution faithfully.

**Architecture:** A pure expansion engine (`template-expand.ts`) does placeholder substitution using `dayjs` for Moment-token fidelity, with `now` injected for deterministic tests. A resolver (`templates.ts`) locates the template folder config-first (`.obsidian/templates.json` → `OBSIDIAN_TEMPLATE_FOLDER` override) and reads templates. Three thin tools — `list_templates` (read), `apply_template` / `insert_template` (gated writes) — expand then delegate to the *existing* write paths (`writeNote`, `appendNote`, `prependNote`, `appendNoteSection`), inheriting path-guard, git-guard, frontmatter validation, and link-health for free.

**Tech Stack:** TypeScript, Node's `node:test` runner via tsx, `dayjs` (new dependency) + `advancedFormat` + `customParseFormat` plugins, MCP SDK, commander (query CLI).

## Global Constraints

- **Node 18+**; ESM with `.js` import specifiers (source is `.ts`, imports use `.js`).
- **New dependency allowed:** `dayjs` + its `advancedFormat` and `customParseFormat` plugins. No other new runtime deps.
- **Verb taxonomy:** `list_` for the read tool, mutation-named verbs for writes. Tool names: `list_templates`, `apply_template`, `insert_template`. No synonyms.
- **Write gating:** `apply_template` / `insert_template` MUST be added to `WRITE_TOOL_NAMES` in `src/tools/write.ts` so they are hidden unless `OBSIDIAN_ALLOW_WRITES` is truthy and routed through the git guard. `list_templates` is a read tool, never gated.
- **Determinism:** `expand()` takes an injected `now: Date`; its unit tests never call the wall clock. Tool code may call `new Date()` (consistent with `vault-index.ts`/`recent.ts`).
- **Path-guard:** every vault path resolves through `resolveVaultFile` / `resolveNotePath` from `src/tools/vault.ts` (path-traversal protected).
- **Link-health convention:** the two write tools return `unresolved_links` / `broken_anchors` in their result, exactly as the existing content-write tools do (delegation gives this automatically).
- **Unknown `{{...}}` tokens pass through literally** — never dropped.
- **Docs rule:** update BOTH `CLAUDE.md` and `README.md`.
- **Tests** live in `tests/*.test.ts`; use `makeVault` from `tests/fixtures.ts` for temp vaults.

---

## File Structure

- Create `src/tools/template-expand.ts` — pure `expand(text, { title, now, dateFormat?, timeFormat? })`.
- Create `src/tools/templates.ts` — folder resolution, template resolution/read/list, and the three tool functions (`listTemplates`, `applyTemplate`, `insertTemplate`).
- Modify `src/tools/write.ts` — add the two write-tool names to `WRITE_TOOL_NAMES`.
- Modify `src/index.ts` — register three tools (schema + dispatch).
- Modify `src/query-cli.ts` — add `templates list`, `template apply`, `template insert` subcommands.
- Modify `package.json` — add `dayjs` dependency.
- Create tests: `tests/template-expand.test.ts`, `tests/templates.test.ts`, `tests/templates-cli.test.ts`.
- Modify `CLAUDE.md`, `README.md`.

---

## Task 1: Add `dayjs` dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install dayjs**

Run: `npm install dayjs`
Expected: `package.json` gains `"dayjs": "^1.x"` under `dependencies`; `package-lock.json` updated.

- [ ] **Step 2: Verify the plugins resolve**

Run: `node -e "const d=require('dayjs'); d.extend(require('dayjs/plugin/advancedFormat')); d.extend(require('dayjs/plugin/customParseFormat')); console.log(d('2026-07-23T14:05:09').format('YYYY-MM-DD ddd Do HH:mm'))"`
Expected: prints `2026-07-23 Thu 23rd 14:05` (confirms `advancedFormat`'s `Do` token works).

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "build: add dayjs for Moment-compatible template date formatting"
```

---

## Task 2: Expansion engine (`template-expand.ts`)

**Files:**
- Create: `src/tools/template-expand.ts`
- Test: `tests/template-expand.test.ts`

**Interfaces:**
- Consumes: `dayjs` (Task 1).
- Produces:
  ```ts
  export interface ExpandOptions {
    title: string;          // {{title}} value (target note's basename)
    now: Date;              // clock for {{date}}/{{time}}
    dateFormat?: string;    // default for bare {{date}} (default "YYYY-MM-DD")
    timeFormat?: string;    // default for bare {{time}} (default "HH:mm")
  }
  export function expand(text: string, opts: ExpandOptions): string;
  ```

- [ ] **Step 1: Write the failing tests**

Create `tests/template-expand.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { expand } from "../src/tools/template-expand.js";

const NOW = new Date("2026-07-23T14:05:09Z");
// Use UTC-based format tokens in assertions to avoid host-timezone flake.
const base = { title: "My Note", now: NOW };

test("{{title}} substitutes the title", () => {
  assert.equal(expand("# {{title}}", base), "# My Note");
});

test("bare {{date}} uses default YYYY-MM-DD", () => {
  assert.equal(expand("d: {{date}}", base), "d: 2026-07-23");
});

test("bare {{time}} uses default HH:mm", () => {
  // NOW is 14:05 UTC; format in UTC for a stable assertion.
  assert.equal(expand("t: {{time}}", { ...base, now: new Date("2026-07-23T14:05:00Z") }), "t: 14:05");
});

test("{{date:FORMAT}} honors an inline Moment format", () => {
  assert.equal(expand("{{date:YYYY/MM/DD}}", base), "2026/07/23");
});

test("advancedFormat token Do works", () => {
  assert.equal(expand("{{date:Do MMMM YYYY}}", base), "23rd July 2026");
});

test("[literal] escaping is preserved", () => {
  assert.equal(expand("{{date:[Week] YYYY}}", base), "Week 2026");
});

test("dateFormat/timeFormat options override the defaults", () => {
  assert.equal(
    expand("{{date}} {{time}}", { ...base, dateFormat: "DD.MM.YYYY", timeFormat: "HH.mm" }),
    "23.07.2026 14.05"
  );
});

test("unknown {{token}} passes through literally", () => {
  assert.equal(expand("{{tp.file.title}} {{cursor}}", base), "{{tp.file.title}} {{cursor}}");
});

test("multiple placeholders in one template", () => {
  assert.equal(
    expand("# {{title}}\nCreated {{date}} at {{time}}", { title: "Log", now: new Date("2026-07-23T09:30:00Z") }),
    "# Log\nCreated 2026-07-23 at 09:30"
  );
});
```

> **Timezone note for the implementer:** `dayjs(date)` formats in the host's local timezone. To keep the tests above deterministic regardless of the CI host's TZ, format in UTC — call `dayjs.utc(now)` (requires the `utc` plugin) **or** run the test process with `TZ=UTC`. Choose ONE: add `dayjs/plugin/utc` and use `dayjs.utc(...)` inside `expand` **only if** you decide templates should render UTC. Since Obsidian renders in the user's local TZ, prefer **local** rendering in `expand` (plain `dayjs(now)`) and instead make the tests robust by asserting with a fixed `TZ`. Set `process.env.TZ = "UTC"` at the top of `tests/template-expand.test.ts` (before importing dayjs-using code) so the assertions above hold. Add that line as the very first statement.

Add as the first line of the test file:
```ts
process.env.TZ = "UTC";
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test tests/template-expand.test.ts`
Expected: FAIL — `Cannot find module '../src/tools/template-expand.js'`.

- [ ] **Step 3: Implement `template-expand.ts`**

```ts
import dayjs from "dayjs";
import advancedFormat from "dayjs/plugin/advancedFormat.js";
import customParseFormat from "dayjs/plugin/customParseFormat.js";

dayjs.extend(advancedFormat);
dayjs.extend(customParseFormat);

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
 * Any other {{...}} token is passed through unchanged (report-only philosophy —
 * we never silently drop syntax we don't understand, e.g. Templater's {{tp...}}).
 */
export function expand(text: string, opts: ExpandOptions): string {
  const d = dayjs(opts.now);
  const dateFmt = opts.dateFormat && opts.dateFormat.length ? opts.dateFormat : DEFAULT_DATE;
  const timeFmt = opts.timeFormat && opts.timeFormat.length ? opts.timeFormat : DEFAULT_TIME;

  return text.replace(/\{\{([^}]*)\}\}/g, (whole, inner: string) => {
    const trimmed = inner.trim();
    if (trimmed === "title") return opts.title;
    if (trimmed === "date") return d.format(dateFmt);
    if (trimmed === "time") return d.format(timeFmt);
    const m = /^(date|time)\s*:\s*(.+)$/.exec(trimmed);
    if (m) return d.format(m[2].trim());
    return whole; // unknown token -> passthrough
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test tests/template-expand.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tools/template-expand.ts tests/template-expand.test.ts
git commit -m "feat: template placeholder expansion engine ({{title}}/{{date}}/{{time}})"
```

---

## Task 3: Folder + template resolution (`templates.ts`, read side)

**Files:**
- Create: `src/tools/templates.ts`
- Test: `tests/templates.test.ts` (resolution + `listTemplates` portions)

**Interfaces:**
- Consumes: `resolveVaultFile` from `./vault.js`; `flagEnabled` from `./env-flags.js`; `ListResponse`/paging helper from `./list-response.js` (match how `list.ts` builds its envelope — read `src/tools/list.ts` and `src/tools/list-response.ts` first and mirror the exact helper used there).
- Produces:
  ```ts
  export const TEMPLATE_FOLDER_ENV = "OBSIDIAN_TEMPLATE_FOLDER";
  export interface TemplateConfig { folder: string; dateFormat?: string; timeFormat?: string; }
  export async function resolveTemplateConfig(vaultPath: string): Promise<TemplateConfig>; // throws if unconfigured
  export async function readTemplate(vaultPath: string, name: string): Promise<{ path: string; raw: string }>; // throws not-found (lists candidates)
  export interface TemplateHeader { path: string; name: string; size: number; modified: string; }
  export async function listTemplates(vaultPath: string, params: { limit?: number; offset?: number }): Promise<ListResponse<TemplateHeader>>;
  ```

- [ ] **Step 1: Write the failing tests**

Create `tests/templates.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { makeVault, Fixture } from "./fixtures.js";
import { resolveTemplateConfig, readTemplate, listTemplates } from "../src/tools/templates.js";

async function vaultWithTemplates(): Promise<Fixture> {
  const fx = await makeVault([
    { path: "Templates/Meeting.md", content: "# {{title}}\nDate: {{date}}\n" },
    { path: "Templates/Daily.md", content: "# {{title}}\n" },
    { path: "notes/keep.md", content: "# Keep\n" },
  ]);
  await mkdir(join(fx.vaultPath, ".obsidian"), { recursive: true });
  await writeFile(
    join(fx.vaultPath, ".obsidian", "templates.json"),
    JSON.stringify({ folder: "Templates", dateFormat: "YYYY-MM-DD", timeFormat: "HH:mm" }),
    "utf-8"
  );
  return fx;
}

test("resolveTemplateConfig reads folder + formats from templates.json", async () => {
  const fx = await vaultWithTemplates();
  try {
    const cfg = await resolveTemplateConfig(fx.vaultPath);
    assert.equal(cfg.folder, "Templates");
    assert.equal(cfg.dateFormat, "YYYY-MM-DD");
    assert.equal(cfg.timeFormat, "HH:mm");
  } finally { await fx.cleanup(); }
});

test("OBSIDIAN_TEMPLATE_FOLDER overrides templates.json", async () => {
  const fx = await vaultWithTemplates();
  process.env.OBSIDIAN_TEMPLATE_FOLDER = "notes";
  try {
    const cfg = await resolveTemplateConfig(fx.vaultPath);
    assert.equal(cfg.folder, "notes");
  } finally { delete process.env.OBSIDIAN_TEMPLATE_FOLDER; await fx.cleanup(); }
});

test("resolveTemplateConfig throws when unconfigured", async () => {
  const fx = await makeVault([{ path: "a.md", content: "# A\n" }]);
  try {
    await assert.rejects(() => resolveTemplateConfig(fx.vaultPath), /template folder/i);
  } finally { await fx.cleanup(); }
});

test("listTemplates enumerates the folder, not other notes", async () => {
  const fx = await vaultWithTemplates();
  try {
    const res = await listTemplates(fx.vaultPath, {});
    const names = res.results.map(r => r.name).sort();
    assert.deepEqual(names, ["Daily", "Meeting"]);
    assert.ok(res.results.every(r => r.path.startsWith("Templates/")));
  } finally { await fx.cleanup(); }
});

test("readTemplate returns raw text; unknown name lists candidates", async () => {
  const fx = await vaultWithTemplates();
  try {
    const { raw } = await readTemplate(fx.vaultPath, "Meeting");
    assert.match(raw, /\{\{title\}\}/);
    await assert.rejects(() => readTemplate(fx.vaultPath, "Nope"), /Meeting|Daily/);
  } finally { await fx.cleanup(); }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test tests/templates.test.ts`
Expected: FAIL — module `../src/tools/templates.js` not found.

- [ ] **Step 3: Implement the read side of `templates.ts`**

First read `src/tools/list-response.ts` and `src/tools/files.ts` to copy the exact envelope-building + pagination helper and the directory-listing style. Then:

```ts
import { readFile, stat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { resolveVaultFile } from "./vault.js";
// Import the SAME envelope helper files.ts uses (e.g. paginate / buildListResponse).
import { /* paginate helper */ } from "./list-response.js";

export const TEMPLATE_FOLDER_ENV = "OBSIDIAN_TEMPLATE_FOLDER";

export interface TemplateConfig { folder: string; dateFormat?: string; timeFormat?: string; }

/** Config-first: templates.json, then OBSIDIAN_TEMPLATE_FOLDER override. Throws if neither. */
export async function resolveTemplateConfig(vaultPath: string): Promise<TemplateConfig> {
  let cfg: TemplateConfig | null = null;
  try {
    const raw = await readFile(join(vaultPath, ".obsidian", "templates.json"), "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.folder === "string" && parsed.folder.length) {
      cfg = {
        folder: parsed.folder,
        dateFormat: typeof parsed.dateFormat === "string" ? parsed.dateFormat : undefined,
        timeFormat: typeof parsed.timeFormat === "string" ? parsed.timeFormat : undefined,
      };
    }
  } catch { /* no/invalid config file — fall through to env */ }

  const envFolder = process.env[TEMPLATE_FOLDER_ENV];
  if (envFolder && envFolder.trim().length) {
    return { folder: envFolder.trim(), dateFormat: cfg?.dateFormat, timeFormat: cfg?.timeFormat };
  }
  if (cfg) return cfg;
  throw new Error(
    `No template folder configured. Set the core Templates plugin's folder in .obsidian/templates.json, or set ${TEMPLATE_FOLDER_ENV}.`
  );
}

export interface TemplateHeader { path: string; name: string; size: number; modified: string; }

async function templateFiles(vaultPath: string, folder: string): Promise<TemplateHeader[]> {
  const dirFull = resolveVaultFile(vaultPath, folder);
  let entries: string[] = [];
  try { entries = await readdir(dirFull); } catch { return []; }
  const out: TemplateHeader[] = [];
  for (const e of entries) {
    if (!e.endsWith(".md")) continue;
    const rel = `${folder}/${e}`;
    const st = await stat(join(dirFull, e));
    if (!st.isFile()) continue;
    out.push({
      path: rel,
      name: e.replace(/\.md$/, ""),
      size: st.size,
      modified: new Date(st.mtimeMs).toISOString(),
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export async function listTemplates(vaultPath: string, params: { limit?: number; offset?: number }) {
  const cfg = await resolveTemplateConfig(vaultPath); // throws if unconfigured
  const all = await templateFiles(vaultPath, cfg.folder);
  // Build the { results, returned, skipped, omitted, truncated } envelope with the
  // SAME helper files.ts/list.ts uses — do not hand-roll it.
  return /* paginate(all, params.limit, params.offset) */;
}

export async function readTemplate(vaultPath: string, name: string): Promise<{ path: string; raw: string }> {
  const cfg = await resolveTemplateConfig(vaultPath);
  const base = name.replace(/\.md$/, "");
  const rel = `${cfg.folder}/${base}.md`;
  const full = resolveVaultFile(vaultPath, rel);
  try {
    const raw = await readFile(full, "utf-8");
    return { path: rel, raw };
  } catch {
    const avail = (await templateFiles(vaultPath, cfg.folder)).map(t => t.name);
    throw new Error(`Template not found: ${base}. Available: ${avail.join(", ") || "(none)"}`);
  }
}
```

Replace the two `/* ... */` placeholders with the real pagination helper discovered from `files.ts`. Ensure `listTemplates`' return type is `ListResponse<TemplateHeader>` (or whatever `files.ts` returns).

- [ ] **Step 4: Run to verify pass**

Run: `npx tsx --test tests/templates.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tools/templates.ts tests/templates.test.ts
git commit -m "feat: template folder resolution + list_templates read side"
```

---

## Task 4: `applyTemplate` + `insertTemplate` (write side of `templates.ts`)

**Files:**
- Modify: `src/tools/templates.ts`
- Modify: `src/tools/write.ts` (add tool names to `WRITE_TOOL_NAMES`)
- Test: extend `tests/templates.test.ts`

**Interfaces:**
- Consumes: `expand` (Task 2); `readTemplate`/`resolveTemplateConfig` (Task 3); `writeNote`, `appendNote`, `prependNote`, `appendNoteSection` from `./write.js` (signatures verified: each takes `(vaultPath, paramsObject)` and returns `{ path, ... } & LinkHealth`).
- Produces:
  ```ts
  export async function applyTemplate(vaultPath: string, params: { template: string; path: string; overwrite?: boolean }):
    Promise<{ path: string; created: boolean; unresolved_links: string[]; broken_anchors: { target: string; anchor: string }[] }>;
  export async function insertTemplate(vaultPath: string, params: { template: string; path: string; position: "append" | "prepend" | "section"; section?: string; create_section?: boolean }):
    Promise<{ path: string; position: string; unresolved_links: string[]; broken_anchors: { target: string; anchor: string }[] }>;
  ```

- [ ] **Step 1: Write the failing tests** (append to `tests/templates.test.ts`)

```ts
import { applyTemplate, insertTemplate } from "../src/tools/templates.js";
import { readFile } from "node:fs/promises";

test("applyTemplate creates a note, {{title}} = destination basename", async () => {
  const fx = await vaultWithTemplates();
  try {
    const res = await applyTemplate(fx.vaultPath, { template: "Meeting", path: "meetings/Standup" });
    assert.equal(res.created, true);
    assert.equal(res.path, "meetings/Standup");
    assert.deepEqual(res.unresolved_links, []);
    const body = await readFile(join(fx.vaultPath, "meetings/Standup.md"), "utf-8");
    assert.match(body, /# Standup/);           // {{title}} -> basename
    assert.match(body, /Date: \d{4}-\d\d-\d\d/); // {{date}} expanded
  } finally { await fx.cleanup(); }
});

test("applyTemplate refuses to clobber without overwrite", async () => {
  const fx = await vaultWithTemplates();
  try {
    await applyTemplate(fx.vaultPath, { template: "Daily", path: "d1" });
    await assert.rejects(() => applyTemplate(fx.vaultPath, { template: "Daily", path: "d1" }), /exists/i);
  } finally { await fx.cleanup(); }
});

test("insertTemplate appends expanded template into an existing note", async () => {
  const fx = await vaultWithTemplates();
  try {
    await applyTemplate(fx.vaultPath, { template: "Daily", path: "notes/keep2" }); // creates # keep2
    const res = await insertTemplate(fx.vaultPath, { template: "Meeting", path: "notes/keep2", position: "append" });
    assert.equal(res.position, "append");
    const body = await readFile(join(fx.vaultPath, "notes/keep2.md"), "utf-8");
    assert.match(body, /# keep2[\s\S]*Date: \d{4}-\d\d-\d\d/); // {{title}} = existing basename (keep2), not template
  } finally { await fx.cleanup(); }
});

test("insertTemplate into a section", async () => {
  const fx = await vaultWithTemplates();
  try {
    await applyTemplate(fx.vaultPath, { template: "Daily", path: "notes/log" });
    await insertTemplate(fx.vaultPath, { template: "Daily", path: "notes/log", position: "section", section: "Notes", create_section: true });
    const body = await readFile(join(fx.vaultPath, "notes/log.md"), "utf-8");
    assert.match(body, /## Notes/);
  } finally { await fx.cleanup(); }
});

test("insertTemplate section=missing without create_section fails loud", async () => {
  const fx = await vaultWithTemplates();
  try {
    await applyTemplate(fx.vaultPath, { template: "Daily", path: "notes/log2" });
    await assert.rejects(
      () => insertTemplate(fx.vaultPath, { template: "Daily", path: "notes/log2", position: "section", section: "Nope" }),
      /Nope|section/i
    );
  } finally { await fx.cleanup(); }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test tests/templates.test.ts`
Expected: FAIL — `applyTemplate`/`insertTemplate` not exported.

- [ ] **Step 3: Implement the write side** (append to `src/tools/templates.ts`)

```ts
import { basename } from "node:path";
import { expand } from "./template-expand.js";
import { writeNote, appendNote, prependNote, appendNoteSection } from "./write.js";

/** {{title}} = the note's basename, matching Obsidian. */
function titleOf(notePath: string): string {
  return basename(notePath).replace(/\.md$/, "");
}

export async function applyTemplate(
  vaultPath: string,
  { template, path, overwrite = false }: { template: string; path: string; overwrite?: boolean }
) {
  const cfg = await resolveTemplateConfig(vaultPath);
  const { raw } = await readTemplate(vaultPath, template);
  const content = expand(raw, {
    title: titleOf(path),
    now: new Date(),
    dateFormat: cfg.dateFormat,
    timeFormat: cfg.timeFormat,
  });
  const res = await writeNote(vaultPath, { path, content, overwrite });
  return res; // { path, created, unresolved_links, broken_anchors }
}

export async function insertTemplate(
  vaultPath: string,
  { template, path, position, section, create_section = false }:
    { template: string; path: string; position: "append" | "prepend" | "section"; section?: string; create_section?: boolean }
) {
  if (position === "section" && (!section || !section.length)) {
    throw new Error('insert_template position "section" requires a section heading.');
  }
  const cfg = await resolveTemplateConfig(vaultPath);
  const { raw } = await readTemplate(vaultPath, template);
  const content = expand(raw, {
    title: titleOf(path),
    now: new Date(),
    dateFormat: cfg.dateFormat,
    timeFormat: cfg.timeFormat,
  });

  let health: { unresolved_links: string[]; broken_anchors: { target: string; anchor: string }[] };
  if (position === "append") {
    const r = await appendNote(vaultPath, { path, content });
    health = { unresolved_links: r.unresolved_links, broken_anchors: r.broken_anchors };
  } else if (position === "prepend") {
    const r = await prependNote(vaultPath, { path, content });
    health = { unresolved_links: r.unresolved_links, broken_anchors: r.broken_anchors };
  } else {
    const r = await appendNoteSection(vaultPath, { path, heading: section!, content, create: create_section });
    health = { unresolved_links: r.unresolved_links, broken_anchors: r.broken_anchors };
  }
  return { path: path.replace(/\.md$/, ""), position, ...health };
}
```

> **Note:** `appendNote`/`prependNote` require the note to exist (they throw "Note not found" unless `create` is set). `insert_template` targets an *existing* note by design, so we do NOT pass `create`. If the note is missing, the underlying "Note not found" error surfaces — acceptable and fail-loud. Do not add a `create` path here (that's `apply_template`'s job).

- [ ] **Step 4: Add tool names to the write gate** — in `src/tools/write.ts`, add to the `WRITE_TOOL_NAMES` set:

```ts
  "apply_template",
  "insert_template",
```

- [ ] **Step 5: Run to verify pass**

Run: `npx tsx --test tests/templates.test.ts`
Expected: PASS (all Task 3 + Task 4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/tools/templates.ts src/tools/write.ts tests/templates.test.ts
git commit -m "feat: apply_template and insert_template (delegating to existing write paths)"
```

---

## Task 5: Register the three tools in the MCP server

**Files:**
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `listTemplates`, `applyTemplate`, `insertTemplate` from `./tools/templates.js`.

- [ ] **Step 1: Import the tool functions** near the other tool imports in `src/index.ts`:

```ts
import { listTemplates, applyTemplate, insertTemplate } from "./tools/templates.js";
```

- [ ] **Step 2: Add three tool definitions** in the `ListToolsRequestSchema` handler's tools array. Read an existing read-tool block (e.g. `list_folders`) and an existing write-tool block (e.g. `append_note`) first and mirror their shape exactly. Definitions:

```ts
{
  name: "list_templates",
  description: "Enumerate the vault's core Templates-plugin template folder as { path, name, size, modified } headers. Folder resolved from .obsidian/templates.json (or OBSIDIAN_TEMPLATE_FOLDER). Read-only.",
  inputSchema: {
    type: "object",
    properties: {
      limit: { type: "number", description: "Maximum number of templates to return (default 100; 0 = unbounded)" },
      offset: { type: "number", description: "Rows to skip, for pagination (default 0)." }
    }
  }
},
{
  name: "apply_template",
  description: "Create a new note from a core Templates-plugin template, expanding {{title}} (= new note's basename), {{date}}, {{time}}, and {{date:FORMAT}}/{{time:FORMAT}}. Unknown {{...}} tokens pass through. Returns link-health (unresolved_links, broken_anchors). Refuses to clobber unless overwrite:true.",
  inputSchema: {
    type: "object",
    properties: {
      template: { type: "string", description: "Template name (basename) or template-folder-relative path" },
      path: { type: "string", description: "Destination note path for the new note (.md optional)" },
      overwrite: { type: "boolean", description: "Overwrite an existing note (default false)" }
    },
    required: ["template", "path"]
  }
},
{
  name: "insert_template",
  description: "Expand a core Templates-plugin template into an EXISTING note: position 'append' | 'prepend' | 'section'. {{title}} = the existing note's basename. Returns link-health. Section addressing and fail-loud ambiguity match append_to_section.",
  inputSchema: {
    type: "object",
    properties: {
      template: { type: "string", description: "Template name (basename) or template-folder-relative path" },
      path: { type: "string", description: "Existing note to insert into (.md optional)" },
      position: { type: "string", enum: ["append", "prepend", "section"], description: "Where to insert" },
      section: { type: "string", description: "Heading (or ' > '-joined heading-path) when position is 'section'" },
      create_section: { type: "boolean", description: "Create the section if missing (position 'section' only; default false)" }
    },
    required: ["template", "path", "position"]
  }
},
```

- [ ] **Step 3: Add three dispatch cases** in the `CallToolRequestSchema` handler's `switch`, mirroring existing cases (which wrap the result in `{ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }` — copy the exact wrapper an existing case uses):

```ts
case "list_templates": {
  const result = await listTemplates(VAULT_PATH, (args ?? {}) as { limit?: number; offset?: number });
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}
case "apply_template": {
  const result = await applyTemplate(VAULT_PATH, (args ?? {}) as { template: string; path: string; overwrite?: boolean });
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}
case "insert_template": {
  const result = await insertTemplate(VAULT_PATH, (args ?? {}) as { template: string; path: string; position: "append" | "prepend" | "section"; section?: string; create_section?: boolean });
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}
```

> The existing gating machinery filters `WRITE_TOOL_NAMES` out of `list_tools` and rejects their calls when writes are off. Because `apply_template`/`insert_template` were added to `WRITE_TOOL_NAMES` in Task 4, no extra gating code is needed here — verify by reading how the handler already filters (grep `isWriteTool` / `writesEnabled` in `src/index.ts`).

- [ ] **Step 4: Build to verify types**

Run: `npm run build`
Expected: `tsc` completes with no errors.

- [ ] **Step 5: Full test run**

Run: `npm test`
Expected: all prior tests plus new template tests pass; 0 failures.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts
git commit -m "feat: register list_templates / apply_template / insert_template MCP tools"
```

---

## Task 6: Query CLI subcommands

**Files:**
- Modify: `src/query-cli.ts`
- Test: `tests/templates-cli.test.ts`

**Interfaces:**
- Consumes: `listTemplates`, `applyTemplate`, `insertTemplate`.

- [ ] **Step 1: Write the failing CLI test**

Create `tests/templates-cli.test.ts` — model it on `tests/folders-cli.test.ts` (read that file first for the exact `execFileAsync` + `tsx src/query-cli.ts` invocation and how it points `OBSIDIAN_VAULT_PATH` at the fixture):

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { makeVault } from "./fixtures.js";

const execFileAsync = promisify(execFile);
async function run(vault: string, args: string[]) {
  return execFileAsync("npx", ["tsx", "src/query-cli.ts", ...args], {
    env: { ...process.env, OBSIDIAN_VAULT_PATH: vault },
  });
}

test("templates list + template apply via CLI", async () => {
  const fx = await makeVault([{ path: "Templates/Daily.md", content: "# {{title}}\n{{date}}\n" }]);
  await mkdir(join(fx.vaultPath, ".obsidian"), { recursive: true });
  await writeFile(join(fx.vaultPath, ".obsidian", "templates.json"), JSON.stringify({ folder: "Templates" }), "utf-8");
  try {
    const { stdout: list } = await run(fx.vaultPath, ["templates", "list"]);
    assert.match(list, /Daily/);
    await run(fx.vaultPath, ["template", "apply", "Daily", "j/entry"]);
    const body = await readFile(join(fx.vaultPath, "j/entry.md"), "utf-8");
    assert.match(body, /# entry/);
  } finally { await fx.cleanup(); }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test tests/templates-cli.test.ts`
Expected: FAIL — unknown command `templates`.

- [ ] **Step 3: Add the subcommands** in `src/query-cli.ts`. Read an existing command (e.g. the `folders` command and the `append` command) to copy the exact `.command().action()` style, output printing, and how the vault path is obtained. Add:

```ts
// templates list
program.command("templates")
  .argument("<sub>", "subcommand: list")
  .option("--limit <n>", "max results", (v) => parseInt(v, 10))
  .option("--offset <n>", "rows to skip", (v) => parseInt(v, 10))
  .action(async (sub, opts) => {
    if (sub !== "list") throw new Error(`Unknown templates subcommand: ${sub}`);
    const result = await listTemplates(getVaultPath(), { limit: opts.limit, offset: opts.offset });
    printJson(result); // use whatever the file's existing print helper is
  });

// template apply|insert
const tpl = program.command("template");
tpl.command("apply <template> <path>")
  .option("-o, --overwrite", "overwrite existing")
  .action(async (template, path, opts) => {
    printJson(await applyTemplate(getVaultPath(), { template, path, overwrite: !!opts.overwrite }));
  });
tpl.command("insert <template> <path>")
  .requiredOption("--position <pos>", "append|prepend|section")
  .option("--section <heading>", "section heading (position section)")
  .option("--create-section", "create the section if missing")
  .action(async (template, path, opts) => {
    printJson(await insertTemplate(getVaultPath(), {
      template, path, position: opts.position, section: opts.section, create_section: !!opts.createSection,
    }));
  });
```

Adapt `getVaultPath()`/`printJson()` to the file's actual helpers (grep the file — it already resolves the vault path and prints results for every other command; reuse those, don't invent new ones).

- [ ] **Step 4: Run to verify pass**

Run: `npx tsx --test tests/templates-cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/query-cli.ts tests/templates-cli.test.ts
git commit -m "feat: query CLI templates list / template apply|insert"
```

---

## Task 7: Documentation

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`

- [ ] **Step 1: Add a Templates section to `CLAUDE.md`**

Under "## Writing tools" (or a new top-level "## Templates" section after the read tools, matching the existing structure), document the three tools with the same field-by-field style as neighboring tools:
- `list_templates` — purpose, input (`limit`/`offset`), output envelope, folder-resolution note, "read tool, never gated".
- `apply_template` — purpose, input (`template`/`path`/`overwrite`), output (`{ path, created, unresolved_links, broken_anchors }`), `{{title}}`=destination basename, gated + git-guard.
- `insert_template` — purpose, input (`template`/`path`/`position`/`section`/`create_section`), output (`{ path, position, unresolved_links, broken_anchors }`), `{{title}}`=existing basename, section fail-loud behavior, gated.
- Add a "### Templates" note explaining: core Templates plugin only (Templater out of scope), config-first folder resolution (`.obsidian/templates.json` → `OBSIDIAN_TEMPLATE_FOLDER`), the four placeholders + Moment-format fidelity via `dayjs`, unknown-token passthrough.
- Add the two new tool names to the write-tools count where the doc says "the eighteen write tools" → update to "twenty" (grep for "eighteen" and any explicit count).
- Add `dayjs` to the Dependencies list.
- Add CLI examples under the Testing section:
  ```bash
  npm run query -- templates list
  npm run query -- template apply "Daily" "journal/2026-07-23"
  npm run query -- template insert "Meeting" "journal/2026-07-23" --position section --section Notes --create-section
  ```

- [ ] **Step 2: Add to `README.md` Features + Prerequisites**

- Add a feature bullet: **Templates (opt-in)**: apply the vault's existing core Templates-plugin templates — discover, create-from, and insert-into notes, with faithful `{{date}}`/`{{time}}` formatting.
- Note `dayjs` is bundled (no user action) and that Templater is not supported.

- [ ] **Step 3: Verify counts/consistency**

Run: `grep -rn "eighteen\|list_templates\|apply_template\|insert_template" CLAUDE.md README.md`
Expected: no stale "eighteen"; all three tools documented in both spots as appropriate.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: document template tools in CLAUDE.md and README.md"
```

---

## Task 8: Final verification

- [ ] **Step 1: Full build + test**

Run: `npm run build && npm test`
Expected: build clean; all tests pass (baseline 424 + new template tests), 0 failures.

- [ ] **Step 2: Smoke-test the write gate** — confirm the two write tools are hidden when writes are off. Read how `write-gate.test.ts` asserts this and add (or confirm coverage exists) that `apply_template`/`insert_template` are absent from `list_tools` without `OBSIDIAN_ALLOW_WRITES` and present with it. If `write-gate.test.ts` iterates `WRITE_TOOL_NAMES` generically, it already covers the two new names — verify by reading it; only add a case if it hard-codes names.

- [ ] **Step 3: Commit any gate-test additions**

```bash
git add tests/write-gate.test.ts
git commit -m "test: gate coverage for apply_template / insert_template"
```

---

## Self-Review (completed by plan author)

- **Spec coverage:** list/apply/insert (Tasks 3–5), core-only scope + Templater excluded (Task 7 docs + expand passthrough Task 2), dayjs fidelity (Tasks 1–2), config-first folder + env override (Task 3), gating + git-guard via WRITE_TOOL_NAMES + delegation (Task 4), `{{title}}`=target basename (Task 4 tests), link-health via delegation (Task 4 return values), fail-loud errors (Tasks 3–4 tests), CLI (Task 6), docs both files (Task 7). All spec sections mapped. ✔
- **Placeholder scan:** The two `/* paginate */` markers in Task 3 are explicit "copy the real helper from files.ts" instructions, not silent TODOs — the implementer is told exactly where to get the concrete code. No bare TBDs. ✔
- **Type consistency:** `expand(text, ExpandOptions)`, `resolveTemplateConfig → TemplateConfig`, `readTemplate → { path, raw }`, `applyTemplate → { path, created, ...LinkHealth }`, `insertTemplate → { path, position, ...LinkHealth }` used consistently across Tasks 2→4→5→6. Delegation targets (`writeNote`/`appendNote`/`prependNote`/`appendNoteSection`) match the signatures verified from `src/tools/write.ts`. ✔
