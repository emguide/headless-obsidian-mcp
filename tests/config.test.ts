import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { makeVault, Fixture } from "./fixtures.js";
import { resolveServerConfig, selectConfigSection } from "../src/tools/config.js";
import { TOOLS_ENV } from "../src/tools/env-flags.js";
import { RETIRED_ALLOW_WRITES_ENV } from "../src/tools/tool-policy.js";

afterEach(() => {
  delete process.env[TOOLS_ENV];
  delete process.env[RETIRED_ALLOW_WRITES_ENV];
});

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

test("writes_enabled derives from the tool policy", async () => {
  const fx = await makeVault([{ path: "a.md", content: "# A\n" }]);
  delete process.env.OBSIDIAN_GIT_AUTOCOMMIT;
  delete process.env.OBSIDIAN_GIT_SYNC;
  try {
    delete process.env[TOOLS_ENV];
    let cfg = await resolveServerConfig(fx.vaultPath);
    assert.equal(cfg.writes.writes_enabled, false); // default policy is read-only
    assert.equal(cfg.writes.git_sync, "off");

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
    assert.equal(cfg.tools.exposed.length, 25);
    assert.equal(cfg.tools.excluded.length, 21);
    // sorted, disjoint, complete
    assert.deepEqual(cfg.tools.exposed, [...cfg.tools.exposed].sort());
    assert.deepEqual(cfg.tools.excluded, [...cfg.tools.excluded].sort());

    process.env[TOOLS_ENV] = "search,notes.read";
    cfg = await resolveServerConfig(fx.vaultPath);
    assert.equal(cfg.tools.policy, "search,notes.read");
    assert.deepEqual(cfg.tools.exposed, [
      "get_config", "list_notes", "list_recent_notes", "read_notes",
      "resolve_daily_note", "resolve_note", "search_notes", "search_notes_ranked",
    ]);
    assert.equal(cfg.tools.excluded.length, 45 - 7);
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
    assert.deepEqual(selectConfigSection(cfg, "tools"), cfg.tools);
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
      /template.*writes.*vault.*tools/i
    );
  } finally {
    await fx.cleanup();
  }
});

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

test("config: sync section reports mode/interval/remote", async () => {
  process.env.OBSIDIAN_GIT_SYNC = "timer";
  process.env.OBSIDIAN_GIT_SYNC_INTERVAL = "120";
  process.env.OBSIDIAN_GIT_REMOTE = "backup";
  const fx = await makeVault([{ path: "a.md", content: "# A\n" }]);
  try {
    const cfg = await resolveServerConfig(fx.vaultPath);
    assert.equal(cfg.sync.mode, "timer");
    assert.equal(cfg.sync.interval, 120);
    assert.equal(cfg.sync.remote, "backup");
    assert.equal(cfg.sync.last_sync, null);
    assert.equal(cfg.sync.last_error, null);
    assert.equal(cfg.writes.git_sync, "timer");
  } finally {
    await fx.cleanup();
  }
});

test("config: writes.git_sync is 'off' when unset", async () => {
  delete process.env.OBSIDIAN_GIT_SYNC;
  delete process.env.OBSIDIAN_GIT_AUTOCOMMIT;
  const fx = await makeVault([{ path: "a.md", content: "# A\n" }]);
  try {
    const cfg = await resolveServerConfig(fx.vaultPath);
    assert.equal(cfg.writes.git_sync, "off");
    assert.equal(cfg.sync.mode, "off");
  } finally {
    await fx.cleanup();
  }
});
