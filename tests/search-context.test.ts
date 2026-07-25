import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchNotes } from "../src/tools/search.js";

/**
 * ripgrep emits a match's LEADING context before the match event itself. The
 * parser used to infer file boundaries from match events alone, so those
 * context events were attributed to the PREVIOUS file's last match — and each
 * file's own leading context was dropped. Context is now keyed by line number
 * within the file that owns it.
 */
async function vaultWith(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "search-context-"));
  for (const [name, body] of Object.entries(files)) {
    const full = join(dir, name);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, body, "utf-8");
  }
  return dir;
}

test("context is not borrowed from the next file", async () => {
  const vault = await vaultWith({
    "a1.md": "x1\nx2\nNEEDLE here\nx4\n",
    "a2.md": "lead1\nlead2\nNEEDLE two\ntail\n",
  });

  const { results } = await searchNotes(vault, { pattern: "NEEDLE", context_lines: 2 });
  const a1 = results.find((r) => r.path === "a1")!;
  const a2 = results.find((r) => r.path === "a2")!;

  // Each file keeps its OWN leading context.
  assert.deepEqual(a1.matches[0].context_before, ["x1\n", "x2\n"]);
  assert.deepEqual(a1.matches[0].context_after, ["x4\n"]);
  assert.deepEqual(a2.matches[0].context_before, ["lead1\n", "lead2\n"]);
  assert.deepEqual(a2.matches[0].context_after, ["tail\n"]);

  // No line from one file may appear in the other's context.
  for (const m of a1.matches) {
    for (const line of [...m.context_before, ...m.context_after]) {
      assert.ok(!line.includes("lead"), `a1 context leaked from a2: ${line}`);
    }
  }
});

test("every file's leading context survives, whatever the file order", async () => {
  const files: Record<string, string> = {};
  for (const name of ["b1", "b2", "b3", "b4"]) {
    files[`${name}.md`] = `${name}-before1\n${name}-before2\nNEEDLE ${name}\n${name}-after\n`;
  }
  const vault = await vaultWith(files);

  const { results } = await searchNotes(vault, { pattern: "NEEDLE", context_lines: 2 });
  assert.equal(results.length, 4);
  for (const file of results) {
    const m = file.matches[0];
    assert.deepEqual(
      m.context_before,
      [`${file.path}-before1\n`, `${file.path}-before2\n`],
      `${file.path} must keep its own leading context`
    );
    assert.deepEqual(m.context_after, [`${file.path}-after\n`]);
  }
});

test("context_before is populated for non-first matches within a file", async () => {
  // Two well-separated matches: each gets its own before/after window.
  const body = [
    "pad0",
    "before-a1",
    "before-a2",
    "NEEDLE one",
    "after-a1",
    "after-a2",
    "gap1",
    "gap2",
    "before-b1",
    "before-b2",
    "NEEDLE two",
    "after-b1",
    "",
  ].join("\n");
  const vault = await vaultWith({ "multi.md": body });

  const { results } = await searchNotes(vault, { pattern: "NEEDLE", context_lines: 2 });
  const file = results.find((r) => r.path === "multi")!;
  assert.equal(file.matches.length, 2);

  assert.deepEqual(file.matches[0].context_before, ["before-a1\n", "before-a2\n"]);
  assert.deepEqual(file.matches[0].context_after, ["after-a1\n", "after-a2\n"]);
  // The second match must have its OWN leading context, not an empty array.
  assert.deepEqual(file.matches[1].context_before, ["before-b1\n", "before-b2\n"]);
  assert.deepEqual(file.matches[1].context_after, ["after-b1\n"]);
});

test("context windows never exceed context_lines on either side", async () => {
  const body = Array.from({ length: 40 }, (_, i) =>
    i === 20 ? "NEEDLE middle" : `line-${i}`
  ).join("\n");
  const vault = await vaultWith({ "big.md": body });

  for (const context_lines of [0, 1, 3, 5]) {
    const { results } = await searchNotes(vault, { pattern: "NEEDLE", context_lines });
    const m = results[0].matches[0];
    assert.ok(m.context_before.length <= context_lines, `before > ${context_lines}`);
    assert.ok(m.context_after.length <= context_lines, `after > ${context_lines}`);
  }
});

test("context lines are the real neighbouring lines, usable as patch_note find", async () => {
  const vault = await vaultWith({
    "first.md": "alpha\nbravo\nNEEDLE x\ncharlie\n",
    "second.md": "delta\necho\nNEEDLE y\nfoxtrot\n",
  });

  const { results } = await searchNotes(vault, { pattern: "NEEDLE", context_lines: 1 });
  const second = results.find((r) => r.path === "second")!;
  // Feeding this straight into patch_note must address the right note.
  assert.deepEqual(second.matches[0].context_before, ["echo\n"]);
  assert.deepEqual(second.matches[0].context_after, ["foxtrot\n"]);
});
