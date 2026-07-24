import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { makeVault, Fixture } from "./fixtures.js";
import {
  resolveTemplateConfig,
  readTemplate,
  listTemplates,
  applyTemplate,
  insertTemplate,
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

test("applyTemplate creates a note, {{title}} = destination basename", async () => {
  const fx = await vaultWithTemplates();
  try {
    const res = await applyTemplate(fx.vaultPath, {
      template: "Meeting",
      path: "meetings/Standup",
    });
    assert.equal(res.created, true);
    assert.equal(res.path, "meetings/Standup");
    assert.deepEqual(res.unresolved_links, []);
    const body = await readFile(
      join(fx.vaultPath, "meetings/Standup.md"),
      "utf-8"
    );
    assert.match(body, /# Standup/); // {{title}} -> basename
    assert.match(body, /Date: \d{4}-\d\d-\d\d/); // {{date}} expanded
  } finally {
    await fx.cleanup();
  }
});

test("applyTemplate refuses to clobber without overwrite", async () => {
  const fx = await vaultWithTemplates();
  try {
    await applyTemplate(fx.vaultPath, { template: "Daily", path: "d1" });
    await assert.rejects(
      () => applyTemplate(fx.vaultPath, { template: "Daily", path: "d1" }),
      /exists/i
    );
  } finally {
    await fx.cleanup();
  }
});

test("insertTemplate appends expanded template into an existing note", async () => {
  const fx = await vaultWithTemplates();
  try {
    await applyTemplate(fx.vaultPath, {
      template: "Daily",
      path: "notes/keep2",
    }); // creates "# keep2"
    const res = await insertTemplate(fx.vaultPath, {
      template: "Meeting",
      path: "notes/keep2",
      position: "append",
    });
    assert.equal(res.position, "append");
    const body = await readFile(join(fx.vaultPath, "notes/keep2.md"), "utf-8");
    // {{title}} = existing basename (keep2), NOT the template name
    assert.match(body, /# keep2[\s\S]*Date: \d{4}-\d\d-\d\d/);
  } finally {
    await fx.cleanup();
  }
});

test("insertTemplate into a section", async () => {
  const fx = await vaultWithTemplates();
  try {
    await applyTemplate(fx.vaultPath, { template: "Daily", path: "notes/log" });
    await insertTemplate(fx.vaultPath, {
      template: "Daily",
      path: "notes/log",
      position: "section",
      section: "Notes",
      create_section: true,
    });
    const body = await readFile(join(fx.vaultPath, "notes/log.md"), "utf-8");
    assert.match(body, /## Notes/);
  } finally {
    await fx.cleanup();
  }
});

test("insertTemplate rejects an invalid position with a clear error", async () => {
  const fx = await vaultWithTemplates();
  try {
    await applyTemplate(fx.vaultPath, { template: "Daily", path: "notes/log3" });
    await assert.rejects(
      () =>
        insertTemplate(fx.vaultPath, {
          template: "Daily",
          path: "notes/log3",
          // deliberately invalid
          position: "sideways" as unknown as "append",
        }),
      /position/i
    );
  } finally {
    await fx.cleanup();
  }
});

test("insertTemplate section=missing without create_section fails loud", async () => {
  const fx = await vaultWithTemplates();
  try {
    await applyTemplate(fx.vaultPath, {
      template: "Daily",
      path: "notes/log2",
    });
    await assert.rejects(
      () =>
        insertTemplate(fx.vaultPath, {
          template: "Daily",
          path: "notes/log2",
          position: "section",
          section: "Nope",
        }),
      /Nope|section/i
    );
  } finally {
    await fx.cleanup();
  }
});

test("applyTemplate accepts a vault-relative template path outside the template folder", async () => {
  const fx = await vaultWithTemplates();
  try {
    await writeFile(
      join(fx.vaultPath, "notes", "Elsewhere.md"),
      "# {{title}}\nFrom outside the folder.\n",
      "utf-8"
    );
    const res = await applyTemplate(fx.vaultPath, {
      template: "notes/Elsewhere",
      path: "journal/out",
    });
    assert.equal(res.created, true);
    const body = await readFile(join(fx.vaultPath, "journal/out.md"), "utf-8");
    assert.match(body, /# out/);
    assert.match(body, /From outside the folder/);
  } finally {
    await fx.cleanup();
  }
});

test("applyTemplate works with no template folder configured when given a vault path", async () => {
  const fx = await makeVault([
    { path: "meta/Daily.md", content: "# {{title}}\n{{date:YYYY}}\n" },
  ]);
  try {
    const res = await applyTemplate(fx.vaultPath, {
      template: "meta/Daily",
      path: "daily/2026-07-22",
    });
    assert.equal(res.created, true);
    const body = await readFile(join(fx.vaultPath, "daily/2026-07-22.md"), "utf-8");
    assert.match(body, /# 2026-07-22/);
    assert.match(body, /\b\d{4}\b/);
  } finally {
    await fx.cleanup();
  }
});

test("a template-folder name still wins over a vault-relative path", async () => {
  const fx = await vaultWithTemplates();
  try {
    // A root-level note with the same name as a folder template.
    await writeFile(join(fx.vaultPath, "Daily.md"), "ROOT NOTE\n", "utf-8");
    const { raw } = await readTemplate(fx.vaultPath, "Daily");
    assert.match(raw, /# \{\{title\}\}/);
    assert.doesNotMatch(raw, /ROOT NOTE/);
  } finally {
    await fx.cleanup();
  }
});

test("a not-found template still fails loud listing available templates", async () => {
  const fx = await vaultWithTemplates();
  try {
    await assert.rejects(
      () => readTemplate(fx.vaultPath, "Nope"),
      /Template not found: Nope.*Daily.*Meeting/s
    );
  } finally {
    await fx.cleanup();
  }
});

test("a traversal-escaping template path is rejected, not read", async () => {
  const fx = await vaultWithTemplates();
  try {
    await assert.rejects(() =>
      readTemplate(fx.vaultPath, "../../etc/passwd")
    );
  } finally {
    await fx.cleanup();
  }
});
