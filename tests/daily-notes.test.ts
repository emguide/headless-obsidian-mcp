import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { makeVault, Fixture } from "./fixtures.js";
import {
  resolveDailyConfig,
  resolveDailyNote,
  DAILY_FOLDER_ENV,
} from "../src/tools/daily-notes.js";

/** A fixed local-time clock: 2026-07-22 10:00 in the host timezone. */
const NOW = new Date(2026, 6, 22, 10, 0, 0);

async function vaultWithDailyConfig(
  config: object | string
): Promise<Fixture> {
  const fx = await makeVault([
    { path: "daily/2026-07-22.md", content: "# Daily\nDid things. #daily\n" },
    { path: "Templates/Daily Template.md", content: "# {{title}}\n" },
  ]);
  await mkdir(join(fx.vaultPath, ".obsidian"), { recursive: true });
  await writeFile(
    join(fx.vaultPath, ".obsidian", "daily-notes.json"),
    typeof config === "string" ? config : JSON.stringify(config),
    "utf-8"
  );
  return fx;
}

test("resolveDailyConfig reads folder/format/template from daily-notes.json", async () => {
  const fx = await vaultWithDailyConfig({
    folder: "daily",
    format: "YYYY-MM-DD",
    template: "Templates/Daily Template",
  });
  try {
    const cfg = await resolveDailyConfig(fx.vaultPath);
    assert.equal(cfg.folder, "daily");
    assert.equal(cfg.format, "YYYY-MM-DD");
    assert.equal(cfg.template, "Templates/Daily Template");
  } finally {
    await fx.cleanup();
  }
});

test("empty daily-notes.json means Obsidian defaults (root, YYYY-MM-DD, no template)", async () => {
  const fx = await vaultWithDailyConfig({});
  try {
    const cfg = await resolveDailyConfig(fx.vaultPath);
    assert.equal(cfg.folder, "");
    assert.equal(cfg.format, "YYYY-MM-DD");
    assert.equal(cfg.template, null);
  } finally {
    await fx.cleanup();
  }
});

test("a template value with .md is normalized to the extensionless note path", async () => {
  const fx = await vaultWithDailyConfig({
    folder: "daily",
    template: "Templates/Daily Template.md",
  });
  try {
    const cfg = await resolveDailyConfig(fx.vaultPath);
    assert.equal(cfg.template, "Templates/Daily Template");
  } finally {
    await fx.cleanup();
  }
});

test("a trailing slash on the configured folder is normalized away", async () => {
  const fx = await vaultWithDailyConfig({ folder: "daily/" });
  try {
    const res = await resolveDailyNote(fx.vaultPath, {}, NOW);
    assert.equal(res.path, "daily/2026-07-22");
    assert.equal(res.exists, true);
  } finally {
    await fx.cleanup();
  }
});

test("OBSIDIAN_DAILY_FOLDER overrides the configured folder", async () => {
  const fx = await vaultWithDailyConfig({ folder: "daily", format: "YYYY-MM-DD" });
  process.env[DAILY_FOLDER_ENV] = "journal";
  try {
    const cfg = await resolveDailyConfig(fx.vaultPath);
    assert.equal(cfg.folder, "journal");
    assert.equal(cfg.format, "YYYY-MM-DD");
  } finally {
    delete process.env[DAILY_FOLDER_ENV];
    await fx.cleanup();
  }
});

test("OBSIDIAN_DAILY_FOLDER alone configures daily notes (headless, no .obsidian)", async () => {
  const fx = await makeVault([{ path: "a.md", content: "# A\n" }]);
  process.env[DAILY_FOLDER_ENV] = "journal";
  try {
    const cfg = await resolveDailyConfig(fx.vaultPath);
    assert.equal(cfg.folder, "journal");
    assert.equal(cfg.format, "YYYY-MM-DD");
    assert.equal(cfg.template, null);
  } finally {
    delete process.env[DAILY_FOLDER_ENV];
    await fx.cleanup();
  }
});

test("resolveDailyConfig fails loud when neither config nor env is present", async () => {
  const fx = await makeVault([{ path: "a.md", content: "# A\n" }]);
  try {
    await assert.rejects(
      () => resolveDailyConfig(fx.vaultPath),
      /daily.notes|OBSIDIAN_DAILY_FOLDER/i
    );
  } finally {
    await fx.cleanup();
  }
});

test("invalid JSON in daily-notes.json is treated as no config (fail loud without env)", async () => {
  const fx = await vaultWithDailyConfig("{ not json");
  try {
    await assert.rejects(
      () => resolveDailyConfig(fx.vaultPath),
      /daily.notes|OBSIDIAN_DAILY_FOLDER/i
    );
  } finally {
    await fx.cleanup();
  }
});

test("resolve_daily_note defaults to today and reports an existing note", async () => {
  const fx = await vaultWithDailyConfig({
    folder: "daily",
    format: "YYYY-MM-DD",
    template: "Templates/Daily Template",
  });
  try {
    const res = await resolveDailyNote(fx.vaultPath, {}, NOW);
    assert.equal(res.date, "2026-07-22");
    assert.equal(res.path, "daily/2026-07-22");
    assert.equal(res.exists, true);
    assert.equal(res.template, "Templates/Daily Template");
  } finally {
    await fx.cleanup();
  }
});

test("exists is false for a daily note not yet created", async () => {
  const fx = await vaultWithDailyConfig({ folder: "daily" });
  try {
    const res = await resolveDailyNote(fx.vaultPath, { date: "2026-07-23" }, NOW);
    assert.equal(res.path, "daily/2026-07-23");
    assert.equal(res.exists, false);
  } finally {
    await fx.cleanup();
  }
});

test("yesterday and tomorrow keywords resolve relative to now, case-insensitively", async () => {
  const fx = await vaultWithDailyConfig({ folder: "daily" });
  try {
    const y = await resolveDailyNote(fx.vaultPath, { date: "Yesterday" }, NOW);
    assert.equal(y.date, "2026-07-21");
    assert.equal(y.path, "daily/2026-07-21");
    const t = await resolveDailyNote(fx.vaultPath, { date: "tomorrow" }, NOW);
    assert.equal(t.date, "2026-07-23");
  } finally {
    await fx.cleanup();
  }
});

test("an explicit ISO date resolves to that day", async () => {
  const fx = await vaultWithDailyConfig({ folder: "daily" });
  try {
    const res = await resolveDailyNote(fx.vaultPath, { date: "2026-07-01" }, NOW);
    assert.equal(res.date, "2026-07-01");
    assert.equal(res.path, "daily/2026-07-01");
  } finally {
    await fx.cleanup();
  }
});

test("an unparseable date fails loud, listing the accepted forms", async () => {
  const fx = await vaultWithDailyConfig({ folder: "daily" });
  try {
    await assert.rejects(
      () => resolveDailyNote(fx.vaultPath, { date: "2026-13-45" }, NOW),
      /YYYY-MM-DD.*today.*yesterday.*tomorrow/is
    );
    await assert.rejects(
      () => resolveDailyNote(fx.vaultPath, { date: "next tuesday" }, NOW),
      /YYYY-MM-DD/
    );
  } finally {
    await fx.cleanup();
  }
});

test("a format containing slashes yields nested folders, like Obsidian", async () => {
  const fx = await vaultWithDailyConfig({
    folder: "daily",
    format: "YYYY/MM/YYYY-MM-DD",
  });
  try {
    const res = await resolveDailyNote(fx.vaultPath, {}, NOW);
    assert.equal(res.path, "daily/2026/07/2026-07-22");
  } finally {
    await fx.cleanup();
  }
});

test("root folder ('' ) resolves daily notes at the vault root", async () => {
  const fx = await vaultWithDailyConfig({ format: "YYYY-MM-DD" });
  try {
    const res = await resolveDailyNote(fx.vaultPath, {}, NOW);
    assert.equal(res.path, "2026-07-22");
  } finally {
    await fx.cleanup();
  }
});

test("a folder or format that escapes the vault is rejected", async () => {
  const fx = await vaultWithDailyConfig({ folder: ".." });
  try {
    await assert.rejects(() => resolveDailyNote(fx.vaultPath, {}, NOW));
  } finally {
    await fx.cleanup();
  }
  const fx2 = await vaultWithDailyConfig({
    folder: "daily",
    format: "[../../escape-]YYYY",
  });
  try {
    await assert.rejects(() => resolveDailyNote(fx2.vaultPath, {}, NOW));
  } finally {
    await fx2.cleanup();
  }
});

test("get_config gains a lenient daily section", async () => {
  const { resolveServerConfig, selectConfigSection } = await import(
    "../src/tools/config.js"
  );
  const unconfigured = await makeVault([{ path: "a.md", content: "# A\n" }]);
  try {
    const cfg = await resolveServerConfig(unconfigured.vaultPath);
    assert.deepEqual(cfg.daily, { folder: null, format: "YYYY-MM-DD", template: null });
  } finally {
    await unconfigured.cleanup();
  }

  const fx = await vaultWithDailyConfig({
    folder: "daily",
    format: "YYYY/MM/DD",
    template: "Templates/Daily Template",
  });
  try {
    const cfg = await resolveServerConfig(fx.vaultPath);
    const daily = selectConfigSection(cfg, "daily");
    assert.deepEqual(daily, {
      folder: "daily",
      format: "YYYY/MM/DD",
      template: "Templates/Daily Template",
    });
  } finally {
    await fx.cleanup();
  }
});
