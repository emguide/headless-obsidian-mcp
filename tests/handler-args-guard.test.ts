import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Several read handlers destructured `args` directly, so a call arriving with
 * no `arguments` object at all produced "Cannot read properties of undefined
 * (reading 'pattern')" instead of the intended fail-loud "X is required".
 * Behaviour was still an error, but the project holds a message-quality bar.
 */
test("no tool handler destructures args without the ?? {} guard", async () => {
  const src = await readFile(join(process.cwd(), "src", "index.ts"), "utf-8");

  const offenders: string[] = [];
  src.split("\n").forEach((line, i) => {
    // `args as unknown as X` without the guard is the unsafe form.
    if (/\bargs as unknown as /.test(line) && !/\(args \?\? \{\}\) as unknown as /.test(line)) {
      offenders.push(`${i + 1}: ${line.trim()}`);
    }
  });

  assert.deepEqual(
    offenders,
    [],
    `these handlers dereference args unguarded:\n${offenders.join("\n")}`
  );
});

test("every guarded handler still reads its params", async () => {
  const src = await readFile(join(process.cwd(), "src", "index.ts"), "utf-8");
  // Sanity: the guard is actually in use across the handler surface.
  const guarded = src.match(/\(args \?\? \{\}\) as unknown as /g) ?? [];
  assert.ok(guarded.length >= 30, `expected the guard throughout, found ${guarded.length}`);
});

test("list_vault_issues include_context description names both rejected kinds", async () => {
  const src = await readFile(join(process.cwd(), "src", "index.ts"), "utf-8");
  const match = src.match(/decorate each target with the source line\(s\)[^"]*/);
  assert.ok(match, "include_context description not found");
  assert.match(match[0], /orphans/);
  assert.match(match[0], /conflicts/, "conflicts also errors and must be documented");
});

test("list_properties description admits the object type", async () => {
  const src = await readFile(join(process.cwd(), "src", "index.ts"), "utf-8");
  const match = src.match(/List every frontmatter property key[^"]*/);
  assert.ok(match, "list_properties description not found");
  assert.match(match[0], /object/, "typeOf can return object for hand-written nested YAML");
});
