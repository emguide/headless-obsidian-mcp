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
