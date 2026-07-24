# get_config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only, ungated `get_config` MCP tool that reports the server's own configuration (template folder + effective date/time formats, write flags, vault path), optionally narrowed to one section.

**Architecture:** A new pure module `src/tools/config.ts` exposes `resolveServerConfig(vaultPath)` (assembles the full config object) and `selectConfigSection(config, section?)` (returns the whole object or one unwrapped section, throwing on an unknown section). The template section reuses `resolveTemplateConfig` but catches its throw and maps an unconfigured folder to `folder: null`. The tool is wired into both the MCP server (`src/index.ts`, always exposed) and the query CLI (`src/query-cli.ts`).

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node's built-in `node:test` runner via tsx, MCP SDK, commander (query CLI).

## Global Constraints

- ESM imports use `.js` specifiers even for `.ts` sources (e.g. `from "./templates.js"`).
- `get_config` is **read-only and NEVER gated** by `OBSIDIAN_ALLOW_WRITES` — it must appear in `list_tools` and dispatch unconditionally.
- Fail-loud house style: an unknown `section` throws an Error whose message lists the valid sections.
- Effective date/time formats: report the configured value, else Obsidian's built-in defaults `YYYY-MM-DD` / `HH:mm` — never `undefined`.
- Template folder when unconfigured is reported as `null` — `get_config` must **not** throw (unlike the template tools).
- `vault` section carries `path` only — no vault contents (those stay in `get_vault_stats`).
- Docs must be updated in BOTH `CLAUDE.md` and `README.md` (project documentation rule).
- Tests: `node:test` + `assert/strict`, using the `makeVault`/`Fixture` helper from `tests/fixtures.js`; save and restore any `process.env` mutation in `finally`.

---

### Task 1: `resolveServerConfig` + section selector (core module)

**Files:**
- Create: `src/tools/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes:
  - `resolveTemplateConfig(vaultPath: string): Promise<{ folder: string; dateFormat?: string; timeFormat?: string }>` from `./templates.js` (throws when no folder configured).
  - `writesEnabled(): boolean`, `gitGuardEnabled(): boolean` from `./env-flags.js`.
- Produces:
  - `interface ServerConfig { template: { folder: string | null; date_format: string; time_format: string }; writes: { writes_enabled: boolean; git_autocommit: boolean }; vault: { path: string } }`
  - `resolveServerConfig(vaultPath: string): Promise<ServerConfig>`
  - `type ConfigSection = "template" | "writes" | "vault"`
  - `selectConfigSection(config: ServerConfig, section?: string): ServerConfig | ServerConfig[ConfigSection]`

- [ ] **Step 1: Write the failing test**

Create `tests/config.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { makeVault, Fixture } from "./fixtures.js";
import { resolveServerConfig, selectConfigSection } from "../src/tools/config.js";

async function vaultWithTemplateConfig(): Promise<Fixture> {
  const fx = await makeVault([{ path: "a.md", content: "# A\n" }]);
  await mkdir(join(fx.vaultPath, ".obsidian"), { recursive: true });
  await writeFile(
    join(fx.vaultPath, ".obsidian", "templates.json"),
    JSON.stringify({ folder: "Templates", dateFormat: "DD/MM/YYYY", timeFormat: "h:mm A" }),
    "utf-8"
  );
  return fx;
}

test("template section reports configured folder and formats", async () => {
  const fx = await vaultWithTemplateConfig();
  try {
    const cfg = await resolveServerConfig(fx.vaultPath);
    assert.equal(cfg.template.folder, "Templates");
    assert.equal(cfg.template.date_format, "DD/MM/YYYY");
    assert.equal(cfg.template.time_format, "h:mm A");
  } finally {
    await fx.cleanup();
  }
});

test("unconfigured template folder is null, not a throw", async () => {
  const fx = await makeVault([{ path: "a.md", content: "# A\n" }]);
  try {
    const cfg = await resolveServerConfig(fx.vaultPath);
    assert.equal(cfg.template.folder, null);
    assert.equal(cfg.template.date_format, "YYYY-MM-DD");
    assert.equal(cfg.template.time_format, "HH:mm");
  } finally {
    await fx.cleanup();
  }
});

test("OBSIDIAN_TEMPLATE_FOLDER override wins", async () => {
  const fx = await makeVault([{ path: "a.md", content: "# A\n" }]);
  process.env.OBSIDIAN_TEMPLATE_FOLDER = "MyTemplates";
  try {
    const cfg = await resolveServerConfig(fx.vaultPath);
    assert.equal(cfg.template.folder, "MyTemplates");
  } finally {
    delete process.env.OBSIDIAN_TEMPLATE_FOLDER;
    await fx.cleanup();
  }
});

test("writes section tracks the env flags", async () => {
  const fx = await makeVault([{ path: "a.md", content: "# A\n" }]);
  process.env.OBSIDIAN_ALLOW_WRITES = "1";
  delete process.env.OBSIDIAN_GIT_AUTOCOMMIT;
  try {
    const cfg = await resolveServerConfig(fx.vaultPath);
    assert.equal(cfg.writes.writes_enabled, true);
    assert.equal(cfg.writes.git_autocommit, false);
  } finally {
    delete process.env.OBSIDIAN_ALLOW_WRITES;
    await fx.cleanup();
  }
});

test("vault section echoes the vault path", async () => {
  const fx = await makeVault([{ path: "a.md", content: "# A\n" }]);
  try {
    const cfg = await resolveServerConfig(fx.vaultPath);
    assert.equal(cfg.vault.path, fx.vaultPath);
  } finally {
    await fx.cleanup();
  }
});

test("selectConfigSection returns the whole object with no section", async () => {
  const fx = await makeVault([{ path: "a.md", content: "# A\n" }]);
  try {
    const cfg = await resolveServerConfig(fx.vaultPath);
    assert.deepEqual(selectConfigSection(cfg), cfg);
  } finally {
    await fx.cleanup();
  }
});

test("selectConfigSection unwraps a named section", async () => {
  const fx = await vaultWithTemplateConfig();
  try {
    const cfg = await resolveServerConfig(fx.vaultPath);
    assert.deepEqual(selectConfigSection(cfg, "template"), cfg.template);
    assert.deepEqual(selectConfigSection(cfg, "writes"), cfg.writes);
    assert.deepEqual(selectConfigSection(cfg, "vault"), cfg.vault);
  } finally {
    await fx.cleanup();
  }
});

test("selectConfigSection throws on an unknown section, listing valid ones", async () => {
  const fx = await makeVault([{ path: "a.md", content: "# A\n" }]);
  try {
    const cfg = await resolveServerConfig(fx.vaultPath);
    assert.throws(
      () => selectConfigSection(cfg, "bogus"),
      /template.*writes.*vault/i
    );
  } finally {
    await fx.cleanup();
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test tests/config.test.ts`
Expected: FAIL — `Cannot find module '../src/tools/config.js'` (module does not exist yet).

- [ ] **Step 3: Write the minimal implementation**

Create `src/tools/config.ts`:

```typescript
import { resolveTemplateConfig } from "./templates.js";
import { writesEnabled, gitGuardEnabled } from "./env-flags.js";

/** Obsidian's built-in defaults for a bare {{date}} / {{time}}. */
const DEFAULT_DATE_FORMAT = "YYYY-MM-DD";
const DEFAULT_TIME_FORMAT = "HH:mm";

export interface ServerConfig {
  template: {
    /** Resolved template folder, or null when none is configured. */
    folder: string | null;
    /** Effective format for a bare {{date}} (never undefined). */
    date_format: string;
    /** Effective format for a bare {{time}} (never undefined). */
    time_format: string;
  };
  writes: {
    writes_enabled: boolean;
    git_autocommit: boolean;
  };
  vault: {
    path: string;
  };
}

export type ConfigSection = keyof ServerConfig;

const SECTIONS: ConfigSection[] = ["template", "writes", "vault"];

/**
 * Assemble the server's own configuration. Unlike the template tools, an
 * unconfigured template folder is reported as folder: null rather than thrown —
 * "no template folder is configured" is a valid answer here.
 */
export async function resolveServerConfig(
  vaultPath: string
): Promise<ServerConfig> {
  let folder: string | null = null;
  let dateFormat = DEFAULT_DATE_FORMAT;
  let timeFormat = DEFAULT_TIME_FORMAT;
  try {
    const cfg = await resolveTemplateConfig(vaultPath);
    folder = cfg.folder;
    if (cfg.dateFormat) dateFormat = cfg.dateFormat;
    if (cfg.timeFormat) timeFormat = cfg.timeFormat;
  } catch {
    /* no template folder configured — folder stays null, formats stay default */
  }

  return {
    template: { folder, date_format: dateFormat, time_format: timeFormat },
    writes: {
      writes_enabled: writesEnabled(),
      git_autocommit: gitGuardEnabled(),
    },
    vault: { path: vaultPath },
  };
}

/**
 * Return the whole config, or a single unwrapped section. An unknown section
 * name throws, listing the valid sections (fail-loud).
 */
export function selectConfigSection(
  config: ServerConfig,
  section?: string
): ServerConfig | ServerConfig[ConfigSection] {
  if (section === undefined) return config;
  if ((SECTIONS as string[]).includes(section)) {
    return config[section as ConfigSection];
  }
  throw new Error(
    `Unknown config section: ${JSON.stringify(section)}. Valid sections: ${SECTIONS.join(", ")}.`
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test tests/config.test.ts`
Expected: PASS — all 8 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/tools/config.ts tests/config.test.ts
git commit -m "$(cat <<'EOF'
feat: resolveServerConfig + section selector for get_config

Core module: assembles template/writes/vault config, mapping an
unconfigured template folder to folder: null (not a throw), and a
fail-loud section selector.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Wire `get_config` into the MCP server

**Files:**
- Modify: `src/index.ts` — import (near line 27), tool registration in `list_tools` (after the `list_templates` block, ~line 279), dispatch case (near the other read-tool cases, ~line 920)
- Test: `tests/config.test.ts` (extend — assert the dispatch path returns JSON)

**Interfaces:**
- Consumes: `resolveServerConfig`, `selectConfigSection` from `./tools/config.js`.
- Produces: MCP tool `get_config` with input `{ section?: "template" | "writes" | "vault" }`, returning `{ content: [{ type: "text", text: JSON.stringify(...) }] }`.

- [ ] **Step 1: Write the failing test**

Append to `tests/config.test.ts`:

```typescript
test("dispatch: selectConfigSection round-trips through JSON for a section", async () => {
  const fx = await vaultWithTemplateConfig();
  try {
    const cfg = await resolveServerConfig(fx.vaultPath);
    const payload = JSON.parse(JSON.stringify(selectConfigSection(cfg, "template")));
    assert.equal(payload.folder, "Templates");
    assert.equal(payload.date_format, "DD/MM/YYYY");
  } finally {
    await fx.cleanup();
  }
});
```

(The full request-handler is covered end-to-end by the CLI test in Task 3; this
step locks the JSON-serializability the dispatch relies on.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test tests/config.test.ts`
Expected: PASS for the existing 8, and the new test also PASSES (it exercises only Task 1 code). This test is a guard, not a red-first driver — proceed to wiring.

- [ ] **Step 3: Add the import to `src/index.ts`**

After the existing templates import (line 27, `import { listTemplates, applyTemplate, insertTemplate } from "./tools/templates.js";`), add:

```typescript
import { resolveServerConfig, selectConfigSection } from "./tools/config.js";
```

- [ ] **Step 4: Register the tool in `list_tools`**

Immediately after the `list_templates` registration object (the block ending near line 279, just before the `get_links` block), insert:

```typescript
      {
        name: "get_config",
        description: "Report the server's own configuration (not vault contents). Returns { template: { folder, date_format, time_format }, writes: { writes_enabled, git_autocommit }, vault: { path } }. Optional section narrows the result to one unwrapped section. template.folder is null when no template folder is configured (does not error). Read-only; never gated by OBSIDIAN_ALLOW_WRITES — this is how you discover whether writes are enabled.",
        inputSchema: {
          type: "object",
          properties: {
            section: {
              type: "string",
              enum: ["template", "writes", "vault"],
              description: "Return just this section, unwrapped. Omit for the whole config object."
            }
          }
        }
      },
```

- [ ] **Step 5: Add the dispatch case**

After the `list_templates` dispatch case (the block ending near line 920, before `case "get_links"`), insert:

```typescript
      case "get_config": {
        const { section } = (args ?? {}) as { section?: string };
        const config = await resolveServerConfig(VAULT_PATH);
        const result = selectConfigSection(config, section);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }
```

- [ ] **Step 6: Verify the build compiles and tests pass**

Run: `npm run build && npx tsx --test tests/config.test.ts`
Expected: build succeeds (no TS errors), all 9 tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/index.ts tests/config.test.ts
git commit -m "$(cat <<'EOF'
feat: expose get_config MCP tool (ungated)

Register get_config in list_tools and dispatch — always exposed,
independent of OBSIDIAN_ALLOW_WRITES.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Add the `config` query-CLI subcommand

**Files:**
- Modify: `src/query-cli.ts` — import (near line 22), `queryTool` dispatch branch (near line 146, the `list_templates` branch), and a new `config` command (near the `stats` command, ~line 500)
- Test: `tests/config-cli.test.ts`

**Interfaces:**
- Consumes: `resolveServerConfig`, `selectConfigSection` from `../src/tools/config.js` (in the test); the CLI reuses the existing `queryTool` indirection.
- Produces: CLI command `config [section]` printing the JSON result.

- [ ] **Step 1: Write the failing test**

Create `tests/config-cli.test.ts` (spawns the CLI exactly as `tests/templates-cli.test.ts` does — mirror that file's spawn helper):

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { makeVault } from "./fixtures.js";

function runCli(vaultPath: string, args: string[], env: Record<string, string> = {}) {
  const res = spawnSync(
    "npx",
    ["tsx", "src/query-cli.ts", ...args],
    {
      encoding: "utf-8",
      env: { ...process.env, OBSIDIAN_VAULT_PATH: vaultPath, ...env },
    }
  );
  return res;
}

test("config prints the whole config object", async () => {
  const fx = await makeVault([{ path: "a.md", content: "# A\n" }]);
  await mkdir(join(fx.vaultPath, ".obsidian"), { recursive: true });
  await writeFile(
    join(fx.vaultPath, ".obsidian", "templates.json"),
    JSON.stringify({ folder: "Templates" }),
    "utf-8"
  );
  try {
    const res = runCli(fx.vaultPath, ["config"]);
    assert.equal(res.status, 0, res.stderr);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.template.folder, "Templates");
    assert.equal(parsed.vault.path, fx.vaultPath);
    assert.ok("writes" in parsed);
  } finally {
    await fx.cleanup();
  }
});

test("config template prints just the template section", async () => {
  const fx = await makeVault([{ path: "a.md", content: "# A\n" }]);
  try {
    const res = runCli(fx.vaultPath, ["config", "template"]);
    assert.equal(res.status, 0, res.stderr);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.folder, null);
    assert.equal(parsed.date_format, "YYYY-MM-DD");
  } finally {
    await fx.cleanup();
  }
});
```

Before writing, open `tests/templates-cli.test.ts` and copy its exact spawn
idiom (binary, arg vector, cwd, env plumbing) rather than the sketch above if it
differs — the two must invoke the CLI identically.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test tests/config-cli.test.ts`
Expected: FAIL — the CLI exits non-zero with `Unknown tool: get_config` (or an unknown-command error), so `JSON.parse` throws / `res.status !== 0`.

- [ ] **Step 3: Add the import to `src/query-cli.ts`**

After the templates import (line 22, `import { listTemplates, applyTemplate, insertTemplate } from "./tools/templates.js";`), add:

```typescript
import { resolveServerConfig, selectConfigSection } from "./tools/config.js";
```

- [ ] **Step 4: Add the `get_config` branch to `queryTool`**

In the `queryTool` dispatch chain, after the `list_templates` branch (near line 147), add:

```typescript
    } else if (toolName === "get_config") {
      const config = await resolveServerConfig(VAULT_PATH!);
      result = selectConfigSection(config, args.section);
```

- [ ] **Step 5: Register the `config` command**

After the `stats` command block (ending near line 500), add:

```typescript
program
  .command("config")
  .description("Report the server's own configuration (template folder + formats, write flags, vault path)")
  .argument("[section]", "Narrow to one section: template | writes | vault")
  .action(async (section: string | undefined, _options: any, command: Command) => {
    const verbose = command.parent?.opts().verbose ?? false;
    await queryTool("get_config", { ...(section && { section }) }, verbose);
  });
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx tsx --test tests/config-cli.test.ts`
Expected: PASS — both CLI tests green.

- [ ] **Step 7: Commit**

```bash
git add src/query-cli.ts tests/config-cli.test.ts
git commit -m "$(cat <<'EOF'
feat: config query-CLI subcommand

`query config [section]` prints the server config via get_config,
ungated like the rest of the CLI.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Documentation (CLAUDE.md + README.md)

**Files:**
- Modify: `CLAUDE.md` — add a `### get_config` section among the read tools (after the `### list_templates` / template section), and a `config` example under the query-CLI Testing block
- Modify: `README.md` — mirror the same tool description in whatever structure README uses for tools

**Interfaces:** none (documentation only).

- [ ] **Step 1: Add the `get_config` section to CLAUDE.md**

In `CLAUDE.md`, after the template tools section (`### insert_template`), add:

```markdown
### get_config
- **Purpose**: Report the server's *own configuration* — how it is set up, not what is in the vault (that is `get_vault_stats`). Answers "where is the template folder?", "are writes enabled?", "which vault am I pointed at?" in one call, instead of inferring them from other tools' side effects.
- **Input**: `section` (optional): `"template" | "writes" | "vault"` — return just that section, unwrapped. Omit for the whole object. An unknown section errors loudly, listing the valid sections.
- **Output**: `{ template, writes, vault }` (or one unwrapped section):
  - `template`: `{ folder, date_format, time_format }` — `folder` is the resolved template folder or `null` when none is configured (this tool does **not** throw on an unconfigured folder, unlike the template tools); `date_format`/`time_format` are the **effective** formats a bare `{{date}}`/`{{time}}` renders as (configured value, else Obsidian's `YYYY-MM-DD` / `HH:mm`).
  - `writes`: `{ writes_enabled, git_autocommit }` — the `OBSIDIAN_ALLOW_WRITES` / `OBSIDIAN_GIT_AUTOCOMMIT` flag states.
  - `vault`: `{ path }` — the configured `OBSIDIAN_VAULT_PATH`. Configuration only; vault contents (counts, sizes, link health) stay in `get_vault_stats`.
- **Gating**: Read-only and **never gated** by `OBSIDIAN_ALLOW_WRITES` — it is how an agent discovers whether writes are enabled, so it is always exposed.
```

- [ ] **Step 2: Add a CLI example to CLAUDE.md**

In the Testing section's knowledge-base examples (near the `stats` line), add:

```markdown
npm run query -- config                                 # Whole server config
npm run query -- config template                        # Just the template section
```

- [ ] **Step 3: Mirror the description in README.md**

Open `README.md`, locate where the read tools (e.g. `get_vault_stats` / `list_templates`) are documented, and add a `get_config` entry in the same format and level of detail used there for a read tool. Match README's existing structure — do not paste the CLAUDE.md block verbatim if README uses a terser format.

- [ ] **Step 4: Verify no stale references and the full suite is green**

Run: `npm run build && npm test`
Expected: build clean; entire suite PASSES (Tasks 1–3 tests included).

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "$(cat <<'EOF'
docs: document get_config in CLAUDE.md and README.md

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Notes for the implementer

- Line numbers are approximate anchors from a snapshot; locate the named
  neighbor (`list_templates` block, `stats` command) rather than trusting the
  number.
- The `VAULT_PATH` non-null assertion (`VAULT_PATH!`) in the CLI matches the
  file's existing convention — `VAULT_PATH` is validated at startup.
- Do not add `get_config` to any write-gating branch. If you find yourself near
  the `writesEnabled()` check that filters the tool list, `get_config` belongs
  with the always-exposed read tools, not behind the flag.
