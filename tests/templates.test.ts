import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { makeVault, Fixture } from "./fixtures.js";
import {
  resolveTemplateConfig,
  readTemplate,
  listTemplates,
} from "../src/tools/templates.js";

async function vaultWithTemplates(): Promise<Fixture> {
  const fx = await makeVault([
    { path: "Templates/Meeting.md", content: "# {{title}}\nDate: {{date}}\n" },
    { path: "Templates/Daily.md", content: "# {{title}}\n" },
    { path: "notes/keep.md", content: "# Keep\n" },
  ]);
  await mkdir(join(fx.vaultPath, ".obsidian"), { recursive: true });
  await writeFile(
    join(fx.vaultPath, ".obsidian", "templates.json"),
    JSON.stringify({
      folder: "Templates",
      dateFormat: "YYYY-MM-DD",
      timeFormat: "HH:mm",
    }),
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
  } finally {
    await fx.cleanup();
  }
});

test("OBSIDIAN_TEMPLATE_FOLDER overrides templates.json", async () => {
  const fx = await vaultWithTemplates();
  process.env.OBSIDIAN_TEMPLATE_FOLDER = "notes";
  try {
    const cfg = await resolveTemplateConfig(fx.vaultPath);
    assert.equal(cfg.folder, "notes");
  } finally {
    delete process.env.OBSIDIAN_TEMPLATE_FOLDER;
    await fx.cleanup();
  }
});

test("resolveTemplateConfig throws when unconfigured", async () => {
  const fx = await makeVault([{ path: "a.md", content: "# A\n" }]);
  try {
    await assert.rejects(
      () => resolveTemplateConfig(fx.vaultPath),
      /template folder/i
    );
  } finally {
    await fx.cleanup();
  }
});

test("listTemplates enumerates the folder, not other notes", async () => {
  const fx = await vaultWithTemplates();
  try {
    const res = await listTemplates(fx.vaultPath, {});
    const names = res.results.map((r) => r.name).sort();
    assert.deepEqual(names, ["Daily", "Meeting"]);
    assert.ok(res.results.every((r) => r.path.startsWith("Templates/")));
  } finally {
    await fx.cleanup();
  }
});

test("readTemplate returns raw text; unknown name lists candidates", async () => {
  const fx = await vaultWithTemplates();
  try {
    const { raw } = await readTemplate(fx.vaultPath, "Meeting");
    assert.match(raw, /\{\{title\}\}/);
    await assert.rejects(
      () => readTemplate(fx.vaultPath, "Nope"),
      /Meeting|Daily/
    );
  } finally {
    await fx.cleanup();
  }
});
