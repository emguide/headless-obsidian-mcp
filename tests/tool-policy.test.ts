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
