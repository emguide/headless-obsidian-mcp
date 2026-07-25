import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveGitSyncMode,
  gitSyncInterval,
  gitRemote,
} from "../src/tools/env-flags.js";

test("mode: unset env → off, no warning", () => {
  const { mode, warning } = resolveGitSyncMode({});
  assert.equal(mode, "off");
  assert.equal(warning, null);
});

test("mode: explicit values pass through", () => {
  for (const m of ["off", "commit", "every-write", "timer"] as const) {
    assert.equal(resolveGitSyncMode({ OBSIDIAN_GIT_SYNC: m }).mode, m);
  }
});

test("mode: unknown value throws (fail-loud)", () => {
  assert.throws(() => resolveGitSyncMode({ OBSIDIAN_GIT_SYNC: "sync-please" }), /OBSIDIAN_GIT_SYNC/);
});

test("migration: legacy autocommit alone maps to commit with a warning", () => {
  const { mode, warning } = resolveGitSyncMode({ OBSIDIAN_GIT_AUTOCOMMIT: "1" });
  assert.equal(mode, "commit");
  assert.match(warning ?? "", /OBSIDIAN_GIT_AUTOCOMMIT/);
});

test("migration: explicit OBSIDIAN_GIT_SYNC wins over legacy flag (still warns)", () => {
  const { mode, warning } = resolveGitSyncMode({
    OBSIDIAN_GIT_AUTOCOMMIT: "1",
    OBSIDIAN_GIT_SYNC: "every-write",
  });
  assert.equal(mode, "every-write");
  assert.match(warning ?? "", /OBSIDIAN_GIT_AUTOCOMMIT/);
});

test("migration: falsy legacy flag does not warn or change mode", () => {
  const { mode, warning } = resolveGitSyncMode({ OBSIDIAN_GIT_AUTOCOMMIT: "0" });
  assert.equal(mode, "off");
  assert.equal(warning, null);
});

test("interval: default 300, parsed, floored at 1", () => {
  assert.equal(gitSyncInterval({}), 300);
  assert.equal(gitSyncInterval({ OBSIDIAN_GIT_SYNC_INTERVAL: "60" }), 60);
  assert.equal(gitSyncInterval({ OBSIDIAN_GIT_SYNC_INTERVAL: "0" }), 1);
  assert.equal(gitSyncInterval({ OBSIDIAN_GIT_SYNC_INTERVAL: "notnum" }), 300);
});

test("remote: default origin, override respected", () => {
  assert.equal(gitRemote({}), "origin");
  assert.equal(gitRemote({ OBSIDIAN_GIT_REMOTE: "backup" }), "backup");
});
