import { test, describe } from "node:test";
import assert from "node:assert";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseMatter, frontmatterLanguage, stringifyMatter } from "../src/tools/matter-safe.js";
import { readNotes } from "../src/tools/read.js";
import { getFrontmatter } from "../src/tools/frontmatter.js";
import { getIndex } from "../src/tools/vault-index.js";

/**
 * gray-matter's default engine set includes an eval()-based `javascript`
 * engine selected by a `---js` language tag. Notes are untrusted input, so the
 * shared parser must never reach it.
 */
const JS_PAYLOAD = [
  "---js",
  'globalThis.__MATTER_RCE__ = "executed";',
  "module.exports = { pwned: true };",
  "---",
  "body text",
  "",
].join("\n");

async function makeVault(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "matter-safe-"));
}

describe("matter-safe: JS frontmatter engine is unreachable", () => {
  test("parseMatter does not execute a ---js block", () => {
    delete (globalThis as Record<string, unknown>).__MATTER_RCE__;
    const parsed = parseMatter(JS_PAYLOAD);
    assert.strictEqual(
      (globalThis as Record<string, unknown>).__MATTER_RCE__,
      undefined,
      "the ---js payload must not run"
    );
    // Treated as body text, matching NoteDocument.parse's bare-fence rule.
    assert.deepStrictEqual(parsed.data, {});
    assert.strictEqual(parsed.content, JS_PAYLOAD);
  });

  test("content stays a suffix of the input for a ---js note", () => {
    // The index's bodyBegin math and set_task_state's reattach rely on this.
    const parsed = parseMatter(JS_PAYLOAD);
    assert.ok(JS_PAYLOAD.endsWith(parsed.content));
  });

  test("read_notes does not execute a planted ---js note", async () => {
    delete (globalThis as Record<string, unknown>).__MATTER_RCE__;
    const vault = await makeVault();
    await writeFile(join(vault, "evil.md"), JS_PAYLOAD, "utf-8");

    const { notes } = await readNotes(vault, ["evil"]);
    assert.strictEqual(
      (globalThis as Record<string, unknown>).__MATTER_RCE__,
      undefined
    );
    assert.deepStrictEqual(notes[0].frontmatter, {});
  });

  test("index refresh does not execute a planted ---js note", async () => {
    delete (globalThis as Record<string, unknown>).__MATTER_RCE__;
    const vault = await makeVault();
    await writeFile(join(vault, "evil.md"), JS_PAYLOAD, "utf-8");
    await writeFile(join(vault, "ok.md"), "---\ntitle: Fine\n---\nbody\n", "utf-8");

    const index = await getIndex(vault);
    assert.strictEqual(
      (globalThis as Record<string, unknown>).__MATTER_RCE__,
      undefined,
      "buildEntry must not run note-supplied code"
    );
    // The rest of the vault still indexes normally.
    const ok = index.getEntry("ok");
    assert.strictEqual(ok?.frontmatter.title, "Fine");
  });

  test("get_frontmatter reports no frontmatter for a ---js note", async () => {
    const vault = await makeVault();
    await writeFile(join(vault, "evil.md"), JS_PAYLOAD, "utf-8");
    const result = await getFrontmatter(vault, "evil");
    assert.deepStrictEqual(result.frontmatter, {});
  });

  test("a ---js note in a subfolder is also inert", async () => {
    delete (globalThis as Record<string, unknown>).__MATTER_RCE__;
    const vault = await makeVault();
    await mkdir(join(vault, "nested"), { recursive: true });
    await writeFile(join(vault, "nested", "evil.md"), JS_PAYLOAD, "utf-8");
    await getIndex(vault);
    assert.strictEqual(
      (globalThis as Record<string, unknown>).__MATTER_RCE__,
      undefined
    );
  });
});

describe("matter-safe: ordinary YAML frontmatter is unaffected", () => {
  test("bare --- fence parses as YAML", () => {
    const parsed = parseMatter("---\ntitle: Alpha\ntags:\n  - work\n---\nbody\n");
    assert.strictEqual(parsed.data.title, "Alpha");
    assert.deepStrictEqual(parsed.data.tags, ["work"]);
    assert.strictEqual(parsed.content, "body\n");
  });

  test("explicit ---yaml tag still parses", () => {
    const parsed = parseMatter("---yaml\ntitle: Alpha\n---\nbody\n");
    assert.strictEqual(parsed.data.title, "Alpha");
  });

  test("a note with no frontmatter is unchanged", () => {
    const raw = "# Heading\n\nbody\n";
    const parsed = parseMatter(raw);
    assert.deepStrictEqual(parsed.data, {});
    assert.strictEqual(parsed.content, raw);
  });

  test("stringifyMatter round-trips through parseMatter", () => {
    const out = stringifyMatter("body\n", { title: "Alpha", tags: ["a", "b"] });
    const parsed = parseMatter(out);
    assert.strictEqual(parsed.data.title, "Alpha");
    assert.deepStrictEqual(parsed.data.tags, ["a", "b"]);
  });
});

describe("matter-safe: language detection", () => {
  test("reports the fence language", () => {
    assert.strictEqual(frontmatterLanguage("---\na: 1\n---\n"), "");
    assert.strictEqual(frontmatterLanguage("---js\nx\n---\n"), "js");
    assert.strictEqual(frontmatterLanguage("---JSON\nx\n---\n"), "json");
    assert.strictEqual(frontmatterLanguage("no fence\n"), null);
  });

  test("other non-YAML languages are inert too", () => {
    for (const lang of ["javascript", "json", "coffee", "toml"]) {
      const raw = `---${lang}\nwhatever\n---\nbody\n`;
      const parsed = parseMatter(raw);
      assert.deepStrictEqual(parsed.data, {}, `${lang} must not be parsed`);
      assert.strictEqual(parsed.content, raw);
    }
  });
});
