import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writesEnabled, ALLOW_WRITES_ENV, gitGuardEnabled, GIT_AUTOCOMMIT_ENV } from "../src/tools/env-flags.js";
import { isWriteTool, WRITE_TOOL_NAMES } from "../src/tools/write.js";

afterEach(() => {
  delete process.env[ALLOW_WRITES_ENV];
  delete process.env[GIT_AUTOCOMMIT_ENV];
});

test("writes are disabled by default", () => {
  delete process.env[ALLOW_WRITES_ENV];
  assert.equal(writesEnabled(), false);
});

test("writesEnabled accepts the documented truthy values", () => {
  for (const value of ["1", "true", "TRUE", "yes", "on", " on "]) {
    process.env[ALLOW_WRITES_ENV] = value;
    assert.equal(writesEnabled(), true, `expected ${JSON.stringify(value)} to enable writes`);
  }
  for (const value of ["0", "false", "no", "off", ""]) {
    process.env[ALLOW_WRITES_ENV] = value;
    assert.equal(writesEnabled(), false, `expected ${JSON.stringify(value)} to keep writes off`);
  }
});

test("git guard flag is independent of the write flag", () => {
  process.env[GIT_AUTOCOMMIT_ENV] = "yes";
  assert.equal(gitGuardEnabled(), true);
  assert.equal(writesEnabled(), false);
});

test("every mutating tool is classified as a write tool", () => {
  for (const name of ["write_note", "append_note", "delete_note", "add_tag", "remove_tag", "set_frontmatter", "add_section", "append_to_section", "replace_section", "bulk_edit", "apply_template", "insert_template"]) {
    assert.equal(isWriteTool(name), true, `${name} should be a write tool`);
    assert.ok(WRITE_TOOL_NAMES.has(name));
  }
});

test("read tools are not classified as write tools", () => {
  for (const name of ["search_notes", "read_notes", "list_notes", "get_links", "list_tags", "find_by_tag", "list_recent_notes", "list_templates"]) {
    assert.equal(isWriteTool(name), false, `${name} should not be a write tool`);
  }
});

test("get_config is never write-gated (isWriteTool returns false)", () => {
  // Regression guard: get_config must NEVER be write-gated, regardless of
  // OBSIDIAN_ALLOW_WRITES. It must always be in list_tools and always
  // dispatchable. This invariant is load-bearing for server availability.
  assert.equal(isWriteTool("get_config"), false, "get_config should not be a write tool");
  assert.ok(!WRITE_TOOL_NAMES.has("get_config"), "get_config should not be in WRITE_TOOL_NAMES");

  // Prove the predicate actually discriminates (not broken to always return false).
  assert.equal(isWriteTool("write_note"), true, "write_note should be a write tool");
  assert.ok(WRITE_TOOL_NAMES.has("write_note"), "write_note should be in WRITE_TOOL_NAMES");
});
