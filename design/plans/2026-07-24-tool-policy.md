# Tool Policy (`OBSIDIAN_TOOLS`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the binary `OBSIDIAN_ALLOW_WRITES` gate with a granular `OBSIDIAN_TOOLS` selector policy that controls exactly which tools the MCP server exposes (by group, mode-slice, or individual tool).

**Architecture:** A new pure module `src/tools/tool-policy.ts` owns the 11-group taxonomy, the selector parser/evaluator, and `resolveToolPolicy()`. `src/index.ts` validates the policy at startup (fail-loud), filters `list_tools` by the exposed set, and rejects calls to excluded tools. `get_config` gains a `tools` section and derives `writes_enabled` from the exposed set. `OBSIDIAN_ALLOW_WRITES` is retired: setting it at all is a startup error.

**Tech Stack:** TypeScript (ESM, NodeNext), Node 18+, `node:test` via tsx, `@modelcontextprotocol/sdk` (already a dependency — its stdio *client* is used for integration tests).

**Spec:** `design/specs/2026-07-24-tool-policy-design.md`

## Global Constraints

- Selector grammar: tokens split on `,`, trimmed, lowercased; empty segments ignored; evaluated left to right; `-` prefix subtracts.
- Token vocabulary: `all` | `reads` | `writes` | 11 group names (`search`, `notes`, `sections`, `links`, `tags`, `properties`, `tasks`, `templates`, `files`, `vault`, `bulk`) | `<group>.read` / `<group>.write` | any tool name.
- Unset `OBSIDIAN_TOOLS` → default policy `reads`. First token negative → evaluation starts from the default policy `reads`, never from `all`.
- Fail-loud: unknown token, empty-set policy, or `OBSIDIAN_ALLOW_WRITES` being set at all must abort server startup with a clear message.
- `get_config` is always exposed, cannot be excluded, belongs to no group.
- Write/read classification has ONE source of truth: `isWriteTool()` from `src/tools/write.ts`. The taxonomy stores group membership only; modes are derived.
- The query CLI stays ungated.
- Tool counts (for assertions): 45 total = 23 gated reads + 21 writes + `get_config`.
- Run tests with `npm test` (whole suite) or `npx tsx --test tests/<file>.test.ts` (one file).
- Every commit message ends with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: `tool-policy.ts` — taxonomy, parser, evaluator

**Files:**
- Modify: `src/tools/env-flags.ts` (add `TOOLS_ENV`; leave `ALLOW_WRITES_ENV`/`writesEnabled` in place — removed in Task 4)
- Create: `src/tools/tool-policy.ts`
- Test: `tests/tool-policy.test.ts`

**Interfaces:**
- Consumes: `isWriteTool(name: string): boolean` from `src/tools/write.js`.
- Produces (used by Tasks 2–4):
  - `TOOLS_ENV = "OBSIDIAN_TOOLS"` (from `env-flags.js`)
  - `RETIRED_ALLOW_WRITES_ENV = "OBSIDIAN_ALLOW_WRITES"`
  - `DEFAULT_POLICY = "reads"`
  - `GROUP_NAMES: readonly string[]` (the 11 group names)
  - `GATED_TOOL_NAMES: ReadonlySet<string>` (44 names, no `get_config`)
  - `interface ToolPolicy { policy: string | null; exposed: ReadonlySet<string> }`
  - `evaluatePolicy(raw: string | null): ReadonlySet<string>` (pure; throws on bad policy)
  - `resolveToolPolicy(env?: NodeJS.ProcessEnv): ToolPolicy` (throws on retired var or bad policy)

- [ ] **Step 1: Add `TOOLS_ENV` to `src/tools/env-flags.ts`**

Append after the `ALLOW_WRITES_ENV` block (do not remove anything yet):

```ts
/** Selector policy naming the tools the server exposes (see tool-policy.ts). */
export const TOOLS_ENV = "OBSIDIAN_TOOLS";
```

- [ ] **Step 2: Write the failing tests**

Create `tests/tool-policy.test.ts`:

```ts
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_POLICY,
  GATED_TOOL_NAMES,
  GROUP_NAMES,
  RETIRED_ALLOW_WRITES_ENV,
  evaluatePolicy,
  resolveToolPolicy,
} from "../src/tools/tool-policy.js";
import { TOOLS_ENV } from "../src/tools/env-flags.js";
import { WRITE_TOOL_NAMES, isWriteTool } from "../src/tools/write.js";

afterEach(() => {
  delete process.env[TOOLS_ENV];
  delete process.env[RETIRED_ALLOW_WRITES_ENV];
});

// --- taxonomy ---

test("taxonomy covers exactly the 44 gated tools; get_config is groupless", () => {
  assert.equal(GATED_TOOL_NAMES.size, 44);
  assert.ok(!GATED_TOOL_NAMES.has("get_config"));
  // every write tool is classified
  for (const name of WRITE_TOOL_NAMES) {
    assert.ok(GATED_TOOL_NAMES.has(name), `${name} missing from taxonomy`);
  }
  assert.equal(GROUP_NAMES.length, 11);
});

test("taxonomy matches the spec, tool by tool", () => {
  const expected = new Set([
    // search
    "search_notes", "search_notes_ranked",
    // notes
    "read_notes", "list_notes", "list_recent_notes", "resolve_note",
    "write_note", "append_note", "prepend_note", "patch_note", "delete_note", "move_note",
    // sections
    "get_outline", "read_section",
    "add_section", "append_to_section", "replace_section", "rename_section",
    // links
    "get_links", "get_related_notes",
    // tags
    "list_tags", "find_by_tag", "add_tag", "remove_tag",
    // properties
    "get_frontmatter", "list_properties", "list_property_values", "query_notes", "get_property",
    "set_frontmatter", "add_property_values", "remove_property_values", "rename_property",
    // tasks
    "list_tasks", "set_task_state",
    // templates
    "list_templates", "apply_template", "insert_template",
    // files
    "list_files", "list_folders", "move_file",
    // vault
    "get_vault_stats", "list_vault_issues",
    // bulk
    "bulk_edit",
  ]);
  assert.deepEqual(new Set(GATED_TOOL_NAMES), expected);
});

// --- evaluatePolicy ---

test("unset policy (null) defaults to reads + get_config", () => {
  const exposed = evaluatePolicy(null);
  assert.ok(exposed.has("get_config"));
  assert.ok(exposed.has("search_notes"));
  assert.ok(exposed.has("list_tasks"));
  for (const name of WRITE_TOOL_NAMES) {
    assert.ok(!exposed.has(name), `${name} must not be exposed by default`);
  }
  assert.equal(exposed.size, 24); // 23 gated reads + get_config
});

test("'all' exposes every tool", () => {
  const exposed = evaluatePolicy("all");
  assert.equal(exposed.size, 45);
});

test("'writes' exposes exactly the write tools plus get_config", () => {
  const exposed = evaluatePolicy("writes");
  assert.equal(exposed.size, 22); // 21 writes + get_config
  for (const name of WRITE_TOOL_NAMES) assert.ok(exposed.has(name));
});

test("group token exposes both modes of the group", () => {
  const exposed = evaluatePolicy("tasks");
  assert.ok(exposed.has("list_tasks"));
  assert.ok(exposed.has("set_task_state"));
  assert.equal(exposed.size, 3); // + get_config
});

test("mode slices select one side of a group", () => {
  const read = evaluatePolicy("tasks.read");
  assert.ok(read.has("list_tasks"));
  assert.ok(!read.has("set_task_state"));
  const write = evaluatePolicy("reads,tasks.write");
  assert.ok(write.has("set_task_state"));
  assert.ok(!write.has("write_note"));
});

test("left-to-right: subtraction then re-add wins", () => {
  const exposed = evaluatePolicy("all,-templates,apply_template");
  assert.ok(!exposed.has("list_templates"));
  assert.ok(!exposed.has("insert_template"));
  assert.ok(exposed.has("apply_template"));
});

test("first-token-negative starts from the default policy, not all", () => {
  const exposed = evaluatePolicy("-templates");
  assert.ok(!exposed.has("list_templates"));
  assert.ok(exposed.has("search_notes"));
  for (const name of WRITE_TOOL_NAMES) {
    assert.ok(!exposed.has(name), `${name} must not leak in via '-' base`);
  }
});

test("tokens are case-insensitive and whitespace-tolerant; empty segments ignored", () => {
  const exposed = evaluatePolicy("  ALL , -Templates ,, ");
  assert.ok(!exposed.has("list_templates"));
  assert.ok(exposed.has("write_note"));
});

test("individual tool tokens add and subtract", () => {
  const exposed = evaluatePolicy("all,-bulk,-delete_note");
  assert.ok(!exposed.has("bulk_edit"));
  assert.ok(!exposed.has("delete_note"));
  assert.ok(exposed.has("write_note"));
});

test("a valid but empty slice (links.write) is allowed and adds nothing", () => {
  const exposed = evaluatePolicy("reads,links.write");
  assert.equal(exposed.size, 24);
});

test("get_config is always exposed and cannot be excluded", () => {
  assert.ok(evaluatePolicy("search").has("get_config"));
  assert.ok(evaluatePolicy("all,-get_config").has("get_config"));
});

test("unknown token fails loud, listing the vocabulary", () => {
  assert.throws(() => evaluatePolicy("reads,templats"), /templats/);
  assert.throws(() => evaluatePolicy("reads,templats"), /search.*notes.*bulk/s);
  assert.throws(() => evaluatePolicy("notes.foo"), /notes\.foo/);
  assert.throws(() => evaluatePolicy("bogus.read"), /bogus\.read/);
});

test("empty policies fail loud", () => {
  assert.throws(() => evaluatePolicy(""), /selects no tools/i);
  assert.throws(() => evaluatePolicy(" , ,"), /selects no tools/i);
  assert.throws(() => evaluatePolicy("tasks,-tasks"), /selects no tools/i);
  assert.throws(() => evaluatePolicy("get_config"), /selects no tools/i);
});

// --- resolveToolPolicy ---

test("resolveToolPolicy reads the env var and reports the raw policy", () => {
  delete process.env[TOOLS_ENV];
  const unset = resolveToolPolicy();
  assert.equal(unset.policy, null);
  assert.equal(unset.exposed.size, 24);

  process.env[TOOLS_ENV] = "all";
  const all = resolveToolPolicy();
  assert.equal(all.policy, "all");
  assert.equal(all.exposed.size, 45);
});

test("retired OBSIDIAN_ALLOW_WRITES fails loud with a migration hint", () => {
  process.env[RETIRED_ALLOW_WRITES_ENV] = "1";
  assert.throws(() => resolveToolPolicy(), /OBSIDIAN_TOOLS/);
  // even a falsy value is an error: the var being present at all means a stale config
  process.env[RETIRED_ALLOW_WRITES_ENV] = "0";
  assert.throws(() => resolveToolPolicy(), /replaced/i);
});

test("mode derivation agrees with isWriteTool for every gated tool", () => {
  const reads = evaluatePolicy("reads");
  const writes = evaluatePolicy("writes");
  for (const name of GATED_TOOL_NAMES) {
    assert.equal(writes.has(name), isWriteTool(name), name);
    assert.equal(reads.has(name), !isWriteTool(name), name);
  }
});
```

- [ ] **Step 3: Run tests, verify they fail**

Run: `npx tsx --test tests/tool-policy.test.ts`
Expected: FAIL — cannot find module `../src/tools/tool-policy.js`.

- [ ] **Step 4: Implement `src/tools/tool-policy.ts`**

```ts
import process from "node:process";
import { isWriteTool } from "./write.js";
import { TOOLS_ENV } from "./env-flags.js";

/** Retired master write switch. Setting it at all is a startup error. */
export const RETIRED_ALLOW_WRITES_ENV = "OBSIDIAN_ALLOW_WRITES";

/** Policy applied when OBSIDIAN_TOOLS is unset: the read-only surface. */
export const DEFAULT_POLICY = "reads";

/** The always-exposed, groupless introspection tool. */
const ALWAYS_EXPOSED = "get_config";

/**
 * The domain taxonomy: every gated tool belongs to exactly one group. Modes
 * (read|write) are not stored here — they derive from isWriteTool, so write
 * classification keeps its single source of truth in write.ts.
 */
const GROUP_MEMBERS: Readonly<Record<string, readonly string[]>> = {
  search: ["search_notes", "search_notes_ranked"],
  notes: [
    "read_notes", "list_notes", "list_recent_notes", "resolve_note",
    "write_note", "append_note", "prepend_note", "patch_note", "delete_note", "move_note",
  ],
  sections: [
    "get_outline", "read_section",
    "add_section", "append_to_section", "replace_section", "rename_section",
  ],
  links: ["get_links", "get_related_notes"],
  tags: ["list_tags", "find_by_tag", "add_tag", "remove_tag"],
  properties: [
    "get_frontmatter", "list_properties", "list_property_values", "query_notes", "get_property",
    "set_frontmatter", "add_property_values", "remove_property_values", "rename_property",
  ],
  tasks: ["list_tasks", "set_task_state"],
  templates: ["list_templates", "apply_template", "insert_template"],
  files: ["list_files", "list_folders", "move_file"],
  vault: ["get_vault_stats", "list_vault_issues"],
  bulk: ["bulk_edit"],
};

export const GROUP_NAMES: readonly string[] = Object.keys(GROUP_MEMBERS);

/** Every gated tool name (get_config is not gated and not listed). */
export const GATED_TOOL_NAMES: ReadonlySet<string> = new Set(
  Object.values(GROUP_MEMBERS).flat()
);

export interface ToolPolicy {
  /** Raw OBSIDIAN_TOOLS value, or null when unset (default policy in force). */
  policy: string | null;
  /** Tool names the server exposes; always contains get_config. */
  exposed: ReadonlySet<string>;
}

/** Expand one (already-lowercased, un-negated) token, or null if unknown. */
function expandToken(token: string): Set<string> | null {
  if (token === "all") return new Set(GATED_TOOL_NAMES);
  if (token === "reads" || token === "writes") {
    const wantWrite = token === "writes";
    return new Set([...GATED_TOOL_NAMES].filter((n) => isWriteTool(n) === wantWrite));
  }
  const dot = token.indexOf(".");
  if (dot !== -1) {
    const members = GROUP_MEMBERS[token.slice(0, dot)];
    const mode = token.slice(dot + 1);
    if (!members || (mode !== "read" && mode !== "write")) return null;
    return new Set(members.filter((n) => isWriteTool(n) === (mode === "write")));
  }
  const members = GROUP_MEMBERS[token];
  if (members) return new Set(members);
  if (GATED_TOOL_NAMES.has(token) || token === ALWAYS_EXPOSED) return new Set([token]);
  return null;
}

function vocabularyHint(): string {
  return (
    `Valid selectors: all, reads, writes; groups: ${GROUP_NAMES.join(", ")} ` +
    `(optionally suffixed .read or .write); or an individual tool name. ` +
    `Prefix any selector with '-' to exclude it.`
  );
}

/**
 * Evaluate a raw OBSIDIAN_TOOLS policy (null = unset -> DEFAULT_POLICY) to
 * the set of exposed tool names. Left to right; '-' subtracts; when the FIRST
 * token subtracts, evaluation starts from the default policy (reads) so that
 * trimming a group can never silently expose the write tools. get_config is
 * always added. Throws on unknown tokens and on policies selecting no tools.
 */
export function evaluatePolicy(raw: string | null): ReadonlySet<string> {
  const source = raw ?? DEFAULT_POLICY;
  const tokens = source
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) {
    throw new Error(
      `${TOOLS_ENV} is set but selects no tools. Unset it for the default ` +
        `("${DEFAULT_POLICY}"), or provide selectors. ${vocabularyHint()}`
    );
  }
  const exposed: Set<string> = tokens[0].startsWith("-")
    ? new Set(expandToken(DEFAULT_POLICY)!)
    : new Set();
  for (const token of tokens) {
    const negate = token.startsWith("-");
    const bare = negate ? token.slice(1).trim() : token;
    const expansion = expandToken(bare);
    if (expansion === null) {
      throw new Error(
        `Unknown ${TOOLS_ENV} selector: ${JSON.stringify(token)}. ${vocabularyHint()}`
      );
    }
    for (const name of expansion) {
      if (negate) exposed.delete(name);
      else exposed.add(name);
    }
  }
  exposed.add(ALWAYS_EXPOSED);
  if (exposed.size === 1) {
    // Only the always-on get_config survived: the policy gates away every tool.
    throw new Error(
      `${TOOLS_ENV} policy ${JSON.stringify(source)} selects no tools ` +
        `(get_config alone is always exposed and does not count). ${vocabularyHint()}`
    );
  }
  return exposed;
}

/**
 * Resolve the effective tool policy from the environment. Fail-loud on the
 * retired OBSIDIAN_ALLOW_WRITES switch: a config that sets it expects the old
 * gating semantics, and silently running read-only (or ignoring it) would be
 * exactly the drift this module exists to prevent.
 */
export function resolveToolPolicy(env: NodeJS.ProcessEnv = process.env): ToolPolicy {
  if (env[RETIRED_ALLOW_WRITES_ENV] !== undefined) {
    throw new Error(
      `${RETIRED_ALLOW_WRITES_ENV} has been replaced by ${TOOLS_ENV}. Unset it; ` +
        `use ${TOOLS_ENV}=all to expose every tool, or see the docs for the selector grammar.`
    );
  }
  const raw = env[TOOLS_ENV];
  const policy = raw === undefined ? null : raw;
  return { policy, exposed: evaluatePolicy(policy) };
}
```

- [ ] **Step 5: Run tests, verify they pass**

Run: `npx tsx --test tests/tool-policy.test.ts`
Expected: PASS (18 tests).

- [ ] **Step 6: Run the whole suite (nothing else may break — this task is additive)**

Run: `npm test`
Expected: 493 + 18 pass, 0 fail.

- [ ] **Step 7: Commit**

```bash
git add src/tools/env-flags.ts src/tools/tool-policy.ts tests/tool-policy.test.ts
git commit -m "feat: tool-policy module — OBSIDIAN_TOOLS taxonomy, parser, evaluator"
```

---

### Task 2: `get_config` reports the policy; `writes_enabled` becomes derived

**Files:**
- Modify: `src/tools/config.ts`
- Test: `tests/config.test.ts` (modify)

**Interfaces:**
- Consumes: `resolveToolPolicy`, `GATED_TOOL_NAMES` from `tool-policy.js`; `isWriteTool` from `write.js`.
- Produces: `ServerConfig` gains `tools: { policy: string | null; exposed: string[]; excluded: string[] }` (both arrays sorted); `writes.writes_enabled` is now `true` iff ≥1 write tool is exposed; `"tools"` is a valid `section`.

- [ ] **Step 1: Update the tests**

In `tests/config.test.ts`:

Add at the top (after existing imports):

```ts
import { TOOLS_ENV } from "../src/tools/env-flags.js";
import { RETIRED_ALLOW_WRITES_ENV } from "../src/tools/tool-policy.js";
import { afterEach } from "node:test";

afterEach(() => {
  delete process.env[TOOLS_ENV];
  delete process.env[RETIRED_ALLOW_WRITES_ENV];
});
```

REPLACE the test `"writes section tracks the env flags"` (which sets `OBSIDIAN_ALLOW_WRITES=1`) with:

```ts
test("writes_enabled derives from the tool policy", async () => {
  const fx = await makeVault([{ path: "a.md", content: "# A\n" }]);
  delete process.env.OBSIDIAN_GIT_AUTOCOMMIT;
  try {
    delete process.env[TOOLS_ENV];
    let cfg = await resolveServerConfig(fx.vaultPath);
    assert.equal(cfg.writes.writes_enabled, false); // default policy is read-only
    assert.equal(cfg.writes.git_autocommit, false);

    process.env[TOOLS_ENV] = "all";
    cfg = await resolveServerConfig(fx.vaultPath);
    assert.equal(cfg.writes.writes_enabled, true);

    process.env[TOOLS_ENV] = "reads,tasks.write"; // one write tool is enough
    cfg = await resolveServerConfig(fx.vaultPath);
    assert.equal(cfg.writes.writes_enabled, true);
  } finally {
    await fx.cleanup();
  }
});

test("tools section reports policy, exposed, and excluded", async () => {
  const fx = await makeVault([{ path: "a.md", content: "# A\n" }]);
  try {
    delete process.env[TOOLS_ENV];
    let cfg = await resolveServerConfig(fx.vaultPath);
    assert.equal(cfg.tools.policy, null);
    assert.ok(cfg.tools.exposed.includes("get_config"));
    assert.ok(cfg.tools.exposed.includes("search_notes"));
    assert.ok(cfg.tools.excluded.includes("write_note"));
    assert.equal(cfg.tools.exposed.length, 24);
    assert.equal(cfg.tools.excluded.length, 21);
    // sorted, disjoint, complete
    assert.deepEqual(cfg.tools.exposed, [...cfg.tools.exposed].sort());
    assert.deepEqual(cfg.tools.excluded, [...cfg.tools.excluded].sort());

    process.env[TOOLS_ENV] = "search,notes.read";
    cfg = await resolveServerConfig(fx.vaultPath);
    assert.equal(cfg.tools.policy, "search,notes.read");
    assert.deepEqual(cfg.tools.exposed, [
      "get_config", "list_notes", "list_recent_notes", "read_notes",
      "resolve_note", "search_notes", "search_notes_ranked",
    ]);
    assert.equal(cfg.tools.excluded.length, 44 - 6);
  } finally {
    await fx.cleanup();
  }
});

test("retired OBSIDIAN_ALLOW_WRITES makes config resolution fail loud", async () => {
  const fx = await makeVault([{ path: "a.md", content: "# A\n" }]);
  process.env[RETIRED_ALLOW_WRITES_ENV] = "1";
  try {
    await assert.rejects(() => resolveServerConfig(fx.vaultPath), /OBSIDIAN_TOOLS/);
  } finally {
    await fx.cleanup();
  }
});
```

UPDATE the existing test `"selectConfigSection unwraps a named section"`: add

```ts
    assert.deepEqual(selectConfigSection(cfg, "tools"), cfg.tools);
```

UPDATE the unknown-section regex in `"selectConfigSection throws on an unknown section, listing valid ones"` to:

```ts
      /template.*writes.*vault.*tools/i
```

- [ ] **Step 2: Run tests, verify the new ones fail**

Run: `npx tsx --test tests/config.test.ts`
Expected: FAIL — `cfg.tools` is undefined; retired-var test fails (no throw).

- [ ] **Step 3: Implement in `src/tools/config.ts`**

Replace the imports of `writesEnabled` and extend the interface:

```ts
import { resolveTemplateConfig } from "./templates.js";
import { gitGuardEnabled } from "./env-flags.js";
import { GATED_TOOL_NAMES, resolveToolPolicy } from "./tool-policy.js";
import { isWriteTool } from "./write.js";
```

In `ServerConfig`, after `vault`:

```ts
  tools: {
    /** Raw OBSIDIAN_TOOLS value, or null when unset (default policy in force). */
    policy: string | null;
    /** Exposed tool names, sorted (always includes get_config). */
    exposed: string[];
    /** Gated tool names the policy hides, sorted. */
    excluded: string[];
  };
```

Update `SECTIONS`:

```ts
const SECTIONS: ConfigSection[] = ["template", "writes", "vault", "tools"];
```

In `resolveServerConfig`, before the `return`, resolve the policy (this also
surfaces the retired-var error), and build the new sections:

```ts
  const { policy, exposed } = resolveToolPolicy();

  return {
    template: { folder, date_format: dateFormat, time_format: timeFormat },
    writes: {
      writes_enabled: [...exposed].some((name) => isWriteTool(name)),
      git_autocommit: gitGuardEnabled(),
    },
    vault: { path: vaultPath },
    tools: {
      policy,
      exposed: [...exposed].sort(),
      excluded: [...GATED_TOOL_NAMES].filter((name) => !exposed.has(name)).sort(),
    },
  };
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npx tsx --test tests/config.test.ts tests/config-cli.test.ts`
Expected: PASS. (`config-cli` exercises the CLI path over the same function; if it asserts on section names or writes fields, update its expectations the same way — `writes_enabled` false by default still holds.)

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: everything passes. `write-gate.test.ts` still passes because `env-flags.ts` still exports the old names (removed in Task 4).

- [ ] **Step 6: Commit**

```bash
git add src/tools/config.ts tests/config.test.ts tests/config-cli.test.ts
git commit -m "feat: get_config tools section; writes_enabled derived from tool policy"
```

---

### Task 3: wire the policy into the server (`src/index.ts`) + integration tests

**Files:**
- Modify: `src/index.ts`
- Test: `tests/tool-policy-server.test.ts` (create)

**Interfaces:**
- Consumes: `resolveToolPolicy`, `GATED_TOOL_NAMES`, `DEFAULT_POLICY`, `ToolPolicy` from `tool-policy.js`; `TOOLS_ENV` from `env-flags.js`.
- Produces: server behavior — `list_tools` filtered to the exposed set; calls to policy-excluded tools return an error naming `OBSIDIAN_TOOLS` and the current policy; startup aborts (exit 1, stderr message) on invalid policy or retired var.

- [ ] **Step 1: Write the failing integration tests**

Create `tests/tool-policy-server.test.ts`. It spawns the real server from
source over stdio using the SDK client (the SDK is already a dependency; tsx
runs the TypeScript entry directly):

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { makeVault, Fixture } from "./fixtures.js";

const TSX = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
const ENTRY = join(process.cwd(), "src", "index.ts");

/** Env for the child server: inherit, minus any tool-gating vars, plus overrides. */
function serverEnv(vaultPath: string, overrides: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  delete env.OBSIDIAN_TOOLS;
  delete env.OBSIDIAN_ALLOW_WRITES;
  env.OBSIDIAN_VAULT_PATH = vaultPath;
  return { ...env, ...overrides };
}

async function withClient<T>(
  vaultPath: string,
  overrides: Record<string, string>,
  fn: (client: Client) => Promise<T>
): Promise<T> {
  const client = new Client({ name: "tool-policy-test", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [TSX, ENTRY],
    env: serverEnv(vaultPath, overrides),
    stderr: "ignore",
  });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

async function toolNames(vaultPath: string, overrides: Record<string, string>): Promise<string[]> {
  return withClient(vaultPath, overrides, async (client) => {
    const { tools } = await client.listTools();
    return tools.map((t) => t.name).sort();
  });
}

/** Spawn the server expecting it to die at startup; return { code, stderr }. */
function startupFailure(vaultPath: string, overrides: Record<string, string>): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TSX, ENTRY], {
      env: serverEnv(vaultPath, overrides),
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

test("default exposure is the read surface plus get_config", async () => {
  const fx = await makeVault([{ path: "a.md", content: "# A\n" }]);
  try {
    const names = await toolNames(fx.vaultPath, {});
    assert.equal(names.length, 24);
    assert.ok(names.includes("get_config"));
    assert.ok(names.includes("search_notes"));
    assert.ok(!names.includes("write_note"));
    assert.ok(!names.includes("set_task_state"));
  } finally {
    await fx.cleanup();
  }
});

test("OBSIDIAN_TOOLS=all exposes all 45 tools", async () => {
  const fx = await makeVault([{ path: "a.md", content: "# A\n" }]);
  try {
    const names = await toolNames(fx.vaultPath, { OBSIDIAN_TOOLS: "all" });
    assert.equal(names.length, 45);
    assert.ok(names.includes("bulk_edit"));
  } finally {
    await fx.cleanup();
  }
});

test("negative-first policy trims the read surface without exposing writes", async () => {
  const fx = await makeVault([{ path: "a.md", content: "# A\n" }]);
  try {
    const names = await toolNames(fx.vaultPath, { OBSIDIAN_TOOLS: "-templates,-tasks" });
    assert.ok(!names.includes("list_templates"));
    assert.ok(!names.includes("list_tasks"));
    assert.ok(!names.includes("write_note"));
    assert.equal(names.length, 22);
  } finally {
    await fx.cleanup();
  }
});

test("mode-slice policy exposes selected writes only", async () => {
  const fx = await makeVault([{ path: "a.md", content: "# A\n" }]);
  try {
    const names = await toolNames(fx.vaultPath, { OBSIDIAN_TOOLS: "reads,tasks.write" });
    assert.ok(names.includes("set_task_state"));
    assert.ok(!names.includes("write_note"));
    assert.equal(names.length, 25);
  } finally {
    await fx.cleanup();
  }
});

test("calling a policy-excluded tool errors, naming the policy", async () => {
  const fx = await makeVault([{ path: "a.md", content: "# A\n" }]);
  try {
    await withClient(fx.vaultPath, { OBSIDIAN_TOOLS: "search" }, async (client) => {
      const result = await client.callTool({
        name: "write_note",
        arguments: { path: "x", content: "y" },
      });
      assert.equal(result.isError, true);
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      assert.match(text, /OBSIDIAN_TOOLS/);
      assert.match(text, /"search"/);
      // excluded READ tools are refused the same way
      const read = await client.callTool({ name: "list_tasks", arguments: {} });
      assert.equal(read.isError, true);
    });
  } finally {
    await fx.cleanup();
  }
});

test("get_config is exposed and callable under a minimal policy", async () => {
  const fx = await makeVault([{ path: "a.md", content: "# A\n" }]);
  try {
    await withClient(fx.vaultPath, { OBSIDIAN_TOOLS: "search" }, async (client) => {
      const { tools } = await client.listTools();
      assert.ok(tools.some((t) => t.name === "get_config"));
      const result = await client.callTool({ name: "get_config", arguments: { section: "tools" } });
      assert.equal(result.isError ?? false, false);
      const payload = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text);
      assert.equal(payload.policy, "search");
      assert.deepEqual(payload.exposed, ["get_config", "search_notes", "search_notes_ranked"]);
    });
  } finally {
    await fx.cleanup();
  }
});

test("startup fails loud on an unknown selector", async () => {
  const fx = await makeVault([{ path: "a.md", content: "# A\n" }]);
  try {
    const { code, stderr } = await startupFailure(fx.vaultPath, { OBSIDIAN_TOOLS: "reads,templats" });
    assert.notEqual(code, 0);
    assert.match(stderr, /templats/);
  } finally {
    await fx.cleanup();
  }
});

test("startup fails loud when the retired OBSIDIAN_ALLOW_WRITES is set", async () => {
  const fx = await makeVault([{ path: "a.md", content: "# A\n" }]);
  try {
    const { code, stderr } = await startupFailure(fx.vaultPath, { OBSIDIAN_ALLOW_WRITES: "1" });
    assert.notEqual(code, 0);
    assert.match(stderr, /OBSIDIAN_TOOLS/);
  } finally {
    await fx.cleanup();
  }
});
```

Check `tests/fixtures.ts` for the exact `makeVault`/`Fixture` signatures before
writing; adjust the import if the helper differs.

- [ ] **Step 2: Run tests, verify current behavior fails them**

Run: `npx tsx --test tests/tool-policy-server.test.ts`
Expected: FAIL — e.g. `OBSIDIAN_TOOLS=all` still hides write tools (old gate), retired-var spawn does not exit non-zero, excluded-tool call errors mention the wrong message.

- [ ] **Step 3: Rewire `src/index.ts`**

3a. Replace the env-flags import (line 89) with:

```ts
import { TOOLS_ENV } from "./tools/env-flags.js";
import {
  DEFAULT_POLICY,
  GATED_TOOL_NAMES,
  resolveToolPolicy,
  ToolPolicy,
} from "./tools/tool-policy.js";
```

and delete `isWriteTool` from the `./tools/write.js` import list (no longer used here).

3b. After the `VAULT_PATH` guard, resolve the policy fail-loud (mirrors the
existing VAULT_PATH exit pattern):

```ts
let TOOL_POLICY: ToolPolicy;
try {
  TOOL_POLICY = resolveToolPolicy();
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
const EXPOSED_TOOLS = TOOL_POLICY.exposed;
```

3c. Hoist the tool-definition array out of the `list_tools` handler to module
scope, renamed `TOOL_DEFINITIONS` (content unchanged except the `get_config`
entry — see 3f), and add the taxonomy-coverage assertion right after it:

```ts
const TOOL_DEFINITIONS = [
  /* ...the exact array currently inside the ListTools handler... */
];

// The taxonomy and the definitions must never drift: every defined tool is
// classified (or is the always-on get_config), every classified tool is defined.
{
  const defined = new Set(TOOL_DEFINITIONS.map((tool) => tool.name));
  for (const tool of TOOL_DEFINITIONS) {
    if (tool.name !== "get_config" && !GATED_TOOL_NAMES.has(tool.name)) {
      console.error(`Error: tool "${tool.name}" has no tool-policy group`);
      process.exit(1);
    }
  }
  for (const name of GATED_TOOL_NAMES) {
    if (!defined.has(name)) {
      console.error(`Error: tool-policy classifies "${name}" but the server does not define it`);
      process.exit(1);
    }
  }
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOL_DEFINITIONS.filter((tool) => EXPOSED_TOOLS.has(tool.name)),
}));
```

3d. In the call handler, replace the old write gate

```ts
    if (isWriteTool(name) && !writesEnabled()) { ... }
```

with the policy gate:

```ts
    // Defense in depth: excluded tools are absent from list_tools, but a stale
    // client may still call one. Unknown names fall through to the default case.
    if (GATED_TOOL_NAMES.has(name) && !EXPOSED_TOOLS.has(name)) {
      throw new Error(
        `Tool "${name}" is excluded by ${TOOLS_ENV} (current policy: ${
          TOOL_POLICY.policy === null
            ? `unset — default "${DEFAULT_POLICY}"`
            : JSON.stringify(TOOL_POLICY.policy)
        }).`
      );
    }
```

3e. Update the server `instructions` string: append a sentence to the end of
the existing instructions text:

```
"\n\nTool exposure is operator-configured (OBSIDIAN_TOOLS): this server may expose a subset of the full tool surface. get_config's tools section reports the active policy and the exposed/excluded tool names."
```

3f. Update the `get_config` definition in `TOOL_DEFINITIONS`:

- description: `"Report the server's own configuration (not vault contents). Returns { template: { folder, date_format, time_format }, writes: { writes_enabled, git_autocommit }, vault: { path }, tools: { policy, exposed, excluded } }. Optional section narrows the result to one unwrapped section. template.folder is null when no template folder is configured (does not error). writes_enabled means at least one write tool is exposed. Read-only; never excluded by OBSIDIAN_TOOLS — this is how you discover the active tool policy."`
- inputSchema `section.enum`: `["template", "writes", "vault", "tools"]`

- [ ] **Step 4: Run the integration tests, verify they pass**

Run: `npx tsx --test tests/tool-policy-server.test.ts`
Expected: PASS (8 tests). If `stderr: "ignore"` is rejected by the SDK version, drop the option (stderr then inherits — noisier but harmless).

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts tests/tool-policy-server.test.ts
git commit -m "feat: gate the MCP tool surface with OBSIDIAN_TOOLS"
```

---

### Task 4: retire `OBSIDIAN_ALLOW_WRITES` from env-flags

**Files:**
- Modify: `src/tools/env-flags.ts`
- Test: `tests/write-gate.test.ts` (modify)

**Interfaces:**
- Consumes: nothing new.
- Produces: `env-flags.ts` no longer exports `ALLOW_WRITES_ENV` / `writesEnabled` (the name lives on only as `RETIRED_ALLOW_WRITES_ENV` in `tool-policy.ts`). `flagEnabled`, `GIT_AUTOCOMMIT_ENV`, `gitGuardEnabled`, `TOOLS_ENV` unchanged.

- [ ] **Step 1: Update the tests**

In `tests/write-gate.test.ts`:

- Change the env-flags import to `import { gitGuardEnabled, GIT_AUTOCOMMIT_ENV } from "../src/tools/env-flags.js";`
- Delete the tests `"writes are disabled by default"` and `"writesEnabled accepts the documented truthy values"` (that behavior now lives in tool-policy, covered by `tests/tool-policy.test.ts`).
- Replace `"git guard flag is independent of the write flag"` with:

```ts
test("git guard flag accepts the documented truthy values", () => {
  for (const value of ["1", "true", "TRUE", "yes", "on", " on "]) {
    process.env[GIT_AUTOCOMMIT_ENV] = value;
    assert.equal(gitGuardEnabled(), true, `expected ${JSON.stringify(value)} to enable the guard`);
  }
  for (const value of ["0", "false", "no", "off", ""]) {
    process.env[GIT_AUTOCOMMIT_ENV] = value;
    assert.equal(gitGuardEnabled(), false, `expected ${JSON.stringify(value)} to keep the guard off`);
  }
});
```

- Update the `afterEach` to only delete `GIT_AUTOCOMMIT_ENV`.
- Keep every `isWriteTool` / `WRITE_TOOL_NAMES` classification test unchanged (that classification still backs the `reads`/`writes` meta-groups and derived `writes_enabled`).

- [ ] **Step 2: Run tests, verify the import fails**

Run: `npx tsx --test tests/write-gate.test.ts`
Expected: PASS still (old exports exist). This step is refactor-shaped: the test change must land with the source change; proceed.

- [ ] **Step 3: Remove the retired exports from `src/tools/env-flags.ts`**

Delete:

```ts
/** Master switch that exposes the write tools; off by default (read-only). */
export const ALLOW_WRITES_ENV = "OBSIDIAN_ALLOW_WRITES";
```

and

```ts
export function writesEnabled(): boolean {
  return flagEnabled(ALLOW_WRITES_ENV);
}
```

Also update the comment on `WRITE_TOOL_NAMES` in `src/tools/write.ts` from
"gate the write surface behind OBSIDIAN_ALLOW_WRITES" to
"back the reads/writes meta-groups of the OBSIDIAN_TOOLS policy (tool-policy.ts)".

- [ ] **Step 4: Verify nothing references the removed names**

Run: `grep -rn "writesEnabled\|ALLOW_WRITES_ENV" src tests`
Expected: only `RETIRED_ALLOW_WRITES_ENV` matches (tool-policy.ts and its tests).

- [ ] **Step 5: Run the whole suite + typecheck**

Run: `npm test && npm run build`
Expected: all pass, clean compile.

- [ ] **Step 6: Commit**

```bash
git add src/tools/env-flags.ts src/tools/write.ts tests/write-gate.test.ts
git commit -m "refactor: retire OBSIDIAN_ALLOW_WRITES from env-flags"
```

---

### Task 5: documentation (CLAUDE.md, README) + CLI help text

**Files:**
- Modify: `CLAUDE.md`, `README.md`, `src/query-cli.ts`

**Interfaces:** none (docs + help strings).

- [ ] **Step 1: Find every stale reference**

Run: `grep -n "ALLOW_WRITES\|writes_enabled\|twenty-one" CLAUDE.md README.md src/query-cli.ts`
Every hit must be updated or consciously kept (the `get_config` docs keep `writes_enabled` with its new derived meaning).

- [ ] **Step 2: Update `CLAUDE.md`**

2a. Replace the "**The write tools are off by default.**" paragraph at the top of the "## Writing tools" section with:

```markdown
**Tool exposure is policy-controlled.** The server exposes tools according to
the `OBSIDIAN_TOOLS` selector policy (see "Tool policy" below). With the
variable unset the server is read-only (policy `reads`): the twenty-one write
tools are hidden from `list_tools` and any call to one is rejected. Set
`OBSIDIAN_TOOLS=all` to expose everything. The policy gates the MCP server
(the agent-facing surface); the query CLI is the operator's own tool and is
not gated. The retired `OBSIDIAN_ALLOW_WRITES` flag is a startup error if set.
```

2b. Add a new top-level section (place it directly before "### Git guard"):

```markdown
### Tool policy (`OBSIDIAN_TOOLS`)

One env var selects exactly which tools the server exposes:

​```
OBSIDIAN_TOOLS="<selector>, <selector>, ..."
​```

Selectors are case-insensitive, evaluated **left to right** (plain token adds,
`-` prefix subtracts): `all` / `reads` / `writes` (meta-groups); a domain
group; `<group>.read` / `<group>.write` (one mode-slice); or an individual
tool name. Evaluation starts from the empty set — unless the *first* token
subtracts, in which case it starts from the default policy `reads` (so
`-templates` trims the read surface and can never silently expose writes).
Unset → policy `reads` (read-only server). Empty segments are ignored.

The 11 domain groups (every gated tool belongs to exactly one):

| Group | Read | Write |
|---|---|---|
| `search` | search_notes, search_notes_ranked | — |
| `notes` | read_notes, list_notes, list_recent_notes, resolve_note | write_note, append_note, prepend_note, patch_note, delete_note, move_note |
| `sections` | get_outline, read_section | add_section, append_to_section, replace_section, rename_section |
| `links` | get_links, get_related_notes | — |
| `tags` | list_tags, find_by_tag | add_tag, remove_tag |
| `properties` | get_frontmatter, list_properties, list_property_values, query_notes, get_property | set_frontmatter, add_property_values, remove_property_values, rename_property |
| `tasks` | list_tasks | set_task_state |
| `templates` | list_templates | apply_template, insert_template |
| `files` | list_files, list_folders | move_file |
| `vault` | get_vault_stats, list_vault_issues | — |
| `bulk` | — | bulk_edit |

`get_config` is groupless and **always exposed** — it reports the active
policy (`tools` section), so an agent can discover why a tool is absent.

Examples:

​```bash
OBSIDIAN_TOOLS="all"                              # everything
OBSIDIAN_TOOLS="-templates,-tasks"                # reads minus templates/tasks
OBSIDIAN_TOOLS="reads,tasks.write,sections.write" # read all, write tasks+sections
OBSIDIAN_TOOLS="all,-bulk,-delete_note"           # everything but the scary ones
OBSIDIAN_TOOLS="search,notes.read"                # minimal search-and-read agent
​```

**Fail-loud:** an unknown selector, a policy that selects no tools, or the
retired `OBSIDIAN_ALLOW_WRITES` variable being set at all aborts startup with
a message listing the valid vocabulary (or the migration hint). A valid slice
that selects nothing (`links.write` — links has no write tools) is allowed.
Excluded tools are absent from `list_tools` (that is the token saving) and,
as defense in depth, calling one is rejected with the current policy named.
​```
```

(Strip the zero-width characters from the fenced blocks when writing the real
file — they exist only to nest fences inside this plan.)

2c. Update the `get_config` tool section: output shape gains
`tools: { policy, exposed, excluded }`; `section` enum gains `"tools"`;
`writes.writes_enabled` documented as "at least one write tool is exposed";
"never gated by OBSIDIAN_ALLOW_WRITES" becomes "never excluded by
`OBSIDIAN_TOOLS`".

2d. In the Testing section's CLI examples, update the comment on the write
examples block ("the query CLI is not gated by OBSIDIAN_ALLOW_WRITES" → "the
query CLI is not gated by OBSIDIAN_TOOLS") and add after the
`config template` example:

```bash
npm run query -- config tools                       # Active tool policy (exposed/excluded)
```

2e. The "### Vault index" and other read-tool sections are unaffected.

- [ ] **Step 3: Update `README.md`**

Apply the same substance: replace the `OBSIDIAN_ALLOW_WRITES` setup/usage text
with the `OBSIDIAN_TOOLS` grammar, group table, examples, and fail-loud notes;
update any `get_config` output example to include the `tools` section. Match
the README's existing tone and heading structure (grep hits from Step 1 locate
every spot).

- [ ] **Step 4: Update `src/query-cli.ts` help strings**

The `config` command description (line ~539): change
"template folder + formats, write flags, vault path" to
"template folder + formats, write status, vault path, tool policy".
Grep for any other `ALLOW_WRITES` mention in CLI help; update likewise.

- [ ] **Step 5: Run the whole suite one last time**

Run: `npm test && npm run build`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md README.md src/query-cli.ts
git commit -m "docs: OBSIDIAN_TOOLS tool policy (grammar, groups, examples)"
```

---

## Self-Review Notes

- Spec coverage: grammar + defaults (T1), first-token-negative base (T1), fail-loud startup incl. retired var (T1 unit + T3 integration), taxonomy (T1), list_tools filtering + call rejection + instructions note (T3), get_config tools section + derived writes_enabled + never-excludable (T2 + T3), CLI ungated (no change; T5 help text), docs (T5).
- Counts used in assertions: 45 total, 44 gated, 23 gated reads, 21 writes, default exposure 24.
- Type consistency: `ToolPolicy { policy, exposed }` consumed by config.ts (T2) and index.ts (T3) exactly as produced in T1.
